import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { AnchorQueryPort, AnchorSubmissionPort } from "../anchor/anchor.port";
import { ANCHOR_QUERY, ANCHOR_SUBMISSION } from "../anchor/anchor.tokens";
import { omnioneExplorerTxUrl } from "../shared/omnione-explorer";
import type { RecordEvidenceDto } from "./evidence.dto";
import { merkleRoot } from "./evidence.merkle";
import type { TaxEvidenceRecordView, TaxEvidenceRepository } from "./evidence.repository";
import { TAX_EVIDENCE_REPOSITORY } from "./evidence.tokens";

/**
 * 한 번에 봉인할 수 있는 잎 수의 상한.
 *
 * 본문 크기 한도(main.ts)와 짝이다: 바이트로만 막으면 거절 이유가 "request entity too large"라
 * 사용자가 무엇을 해야 할지 알 수 없다. 도메인에서 한 번 더 세어 "몇 건까지"를 말한다.
 * 플랜 최상위 한도(10,000건)에 판정이 이벤트당 여러 행일 수 있는 여유를 더한 값이다.
 */
export const EVIDENCE_MAX_LEAVES = 50_000;

/** 체인을 직접 읽어 대조한 결과. 탐색기가 없는 체인에서 사용자가 확인할 수 있는 유일한 창구다. */
export type EvidenceChainCheck = {
  merkleRoot: string;
  txHash: string | null;
  blockNumber: string | null;
  /** 체인에서 트랜잭션을 읽었는가. false면 아래 값들은 "모른다"는 뜻이다. */
  readFromChain: boolean;
  /** 그 트랜잭션이 성공했는가. */
  success: boolean;
  /** 체인의 calldata에서 읽은 해시. */
  anchoredPayloadHash: string | null;
  /** 체인이 실어 나른 해시가 이 근거의 루트와 같은가. 이것이 "내 계산 근거가 올라갔다"의 증명이다. */
  matches: boolean;
  checkedAt: string;
};

export type EvidenceView = {
  merkleRoot: string;
  countryCode: string;
  taxYear: number;
  leafCount: number;
  recordedAt: string;
  anchorStatus: string;
  txHash: string | null;
  blockNumber: string | null;
  anchoredAt: string | null;
  explorerUrl: string | null;
};

/**
 * 계산 근거를 OmniOne 체인에 올리는 사용 사례.
 *
 * 체인에 나가는 것은 **머클루트 하나**다. 금액·거래 id·지갑 주소는 앵커 포트를 넘지 않는다
 * (`AnchorRecord`에 userId가 없다는 불변식과 같은 경계). 원본 정본 문서는 서버가 따로 보관해
 * 나중에 "그 루트가 무엇이었는지"를 감사할 수 있게 한다.
 *
 * 루트는 FE가 준 값을 쓰지 않고 **서버가 잎에서 다시 계산한다**. FE가 계산 주체여도 봉인은
 * 서버 책임이라, 올라간 해시가 무엇을 덮는지는 서버가 스스로 알아야 한다.
 */
@Injectable()
export class TaxEvidenceService {
  constructor(
    @Inject(TAX_EVIDENCE_REPOSITORY) private readonly evidence: TaxEvidenceRepository,
    @Inject(ANCHOR_SUBMISSION) private readonly anchors: AnchorSubmissionPort,
    @Inject(ANCHOR_QUERY) private readonly anchorQuery: AnchorQueryPort,
  ) {}

  async record(userId: string, dto: RecordEvidenceDto): Promise<EvidenceView> {
    if (dto.leaves.length > EVIDENCE_MAX_LEAVES) {
      throw new BadRequestException(`Evidence document is too large: ${dto.leaves.length} leaves (max ${EVIDENCE_MAX_LEAVES}).`);
    }
    const header = dto.leaves[0];
    if (!header || header.kind !== "header") {
      throw new BadRequestException("The first evidence leaf must be the header leaf.");
    }
    const countryCode = typeof header.country === "string" ? header.country : null;
    const taxYear = typeof header.taxYear === "number" ? header.taxYear : null;
    if (!countryCode || taxYear === null || !Number.isInteger(taxYear)) {
      throw new BadRequestException("The header leaf must carry country and taxYear.");
    }

    const root = merkleRoot(dto.leaves);
    // FE가 루트를 함께 보냈는데 서버 계산과 다르면, 두 구현이 갈린 것이다 — 그대로 올리면
    // 체인에는 아무도 재현할 수 없는 해시가 남는다. 올리지 않고 그 사실을 알린다.
    if (dto.merkleRoot && dto.merkleRoot.toLowerCase() !== root.toLowerCase()) {
      throw new BadRequestException(`Evidence merkle root mismatch: client ${dto.merkleRoot}, server ${root}.`);
    }

    const record = await this.evidence.save({
      userId,
      countryCode,
      taxYear,
      merkleRoot: root,
      document: { version: dto.version, leaves: dto.leaves },
      leafCount: dto.leaves.length,
    });
    await this.anchors.submit(root, "rule_version");
    return this.view(record);
  }

  /** 그 해에 이미 기록한 근거가 있는지. 앵커 상태는 매번 앵커 저장소에서 다시 읽는다(큐가 나중에 채운다). */
  async latest(userId: string, countryCode: string, taxYear: number): Promise<EvidenceView | null> {
    const record = await this.evidence.findLatest(userId, countryCode, taxYear);
    return record ? this.view(record) : null;
  }

  async document(userId: string, merkleRoot: string) {
    return this.evidence.findDocument(userId, merkleRoot);
  }

  /**
   * 체인을 **지금** 읽어 이 근거가 실제로 올라가 있는지 대조한다.
   *
   * 저장된 tx 해시를 그대로 보여 주는 것과 다르다: DB가 "올렸다"고 적어 두는 것과 체인이 실제로
   * 그 해시를 갖고 있는 것은 별개이고, 이 체인에는 탐색기가 없어 사용자가 스스로 확인할 길이 없다.
   */
  async checkChain(userId: string, merkleRoot: string): Promise<EvidenceChainCheck | null> {
    const document = await this.evidence.findDocument(userId, merkleRoot);
    // 남의 근거를 체인에서 대신 조회해 주지 않는다 — 소유 확인이 먼저다.
    if (document === null) return null;

    const anchor = await this.anchorQuery.get(merkleRoot);
    const checkedAt = new Date().toISOString();
    if (!anchor?.chainTxHash) {
      return { merkleRoot, txHash: null, blockNumber: null, readFromChain: false, success: false, anchoredPayloadHash: null, matches: false, checkedAt };
    }

    const inspection = await this.anchorQuery.inspect(anchor.chainTxHash);
    if (!inspection) {
      return { merkleRoot, txHash: anchor.chainTxHash, blockNumber: anchor.blockNumber?.toString() ?? null, readFromChain: false, success: false, anchoredPayloadHash: null, matches: false, checkedAt };
    }
    const onChain = inspection.anchoredPayloadHash;
    return {
      merkleRoot,
      txHash: inspection.txHash,
      blockNumber: inspection.blockNumber.toString(),
      readFromChain: true,
      success: inspection.success,
      anchoredPayloadHash: onChain,
      matches: inspection.success && onChain !== null && onChain.toLowerCase() === merkleRoot.toLowerCase(),
      checkedAt,
    };
  }

  private async view(record: TaxEvidenceRecordView): Promise<EvidenceView> {
    const anchor = await this.anchorQuery.get(record.merkleRoot);
    return {
      merkleRoot: record.merkleRoot,
      countryCode: record.countryCode,
      taxYear: record.taxYear,
      leafCount: record.leafCount,
      recordedAt: record.createdAt.toISOString(),
      anchorStatus: anchor?.status ?? "pending",
      txHash: anchor?.chainTxHash ?? null,
      blockNumber: anchor?.blockNumber?.toString() ?? null,
      anchoredAt: anchor?.anchoredAt?.toISOString() ?? null,
      explorerUrl: anchor?.chainTxHash ? omnioneExplorerTxUrl(anchor.chainTxHash) : null,
    };
  }
}
