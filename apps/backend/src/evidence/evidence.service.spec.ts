import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import type { AnchorQueryPort, AnchorSubmissionPort } from "../anchor/anchor.port";
import type { AnchorRecordView } from "../shared/repository.types";
import type { AnchorType } from "@vera/interfaces";
import { MockTaxEvidenceRepository } from "./evidence.repository.adapters";
import { TaxEvidenceService } from "./evidence.service";

const vector = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/evidence-vector.json"), "utf8")) as {
  merkleRoot: string;
  leaves: Record<string, unknown>[];
};

/** 앵커 대역. MOCK_MODE의 즉시 디스패처처럼 제출 즉시 anchored가 된다. */
class FakeAnchors implements AnchorSubmissionPort, AnchorQueryPort {
  readonly submitted: { payloadHash: string; type: AnchorType }[] = [];
  private readonly records = new Map<string, AnchorRecordView>();
  async submit(payloadHash: string, type: AnchorType) {
    this.submitted.push({ payloadHash, type });
    const existing = this.records.get(payloadHash);
    if (existing) return existing;
    const record: AnchorRecordView = {
      id: `anchor-${this.records.size}`, payloadHash, anchorType: type,
      chainTxHash: `0x${"ab".repeat(32)}`, blockNumber: 42n, status: "anchored",
      attempts: 1, anchoredAt: new Date("2027-05-01T00:00:00.000Z"), createdAt: new Date(),
    };
    this.records.set(payloadHash, record);
    return record;
  }
  async get(payloadHash: string) { return this.records.get(payloadHash) ?? null; }
  async verify() { return true; }
  async markFailed() {}
  /** 체인이 실제로 실어 나른 해시. 테스트가 "체인이 다른 값을 갖고 있는" 경우를 만들 수 있게 한다. */
  onChainPayload: string | null | undefined;
  chainReadable = true;
  async inspect(txHash: string) {
    if (!this.chainReadable) return null;
    const record = [...this.records.values()].find((r) => r.chainTxHash === txHash);
    if (!record) return null;
    return {
      txHash,
      blockNumber: record.blockNumber ?? 0n,
      success: true,
      anchoredPayloadHash: this.onChainPayload === undefined ? record.payloadHash : this.onChainPayload,
    };
  }
}

const USER = "user-1";
const body = () => ({ version: 1, leaves: structuredClone(vector.leaves) });

describe("계산 근거 앵커", () => {
  let anchors: FakeAnchors;
  let service: TaxEvidenceService;

  beforeEach(() => {
    anchors = new FakeAnchors();
    service = new TaxEvidenceService(new MockTaxEvidenceRepository(), anchors, anchors);
  });

  it("서버가 잎에서 루트를 다시 계산해 rule_version 앵커로 올린다", async () => {
    const result = await service.record(USER, body());

    expect(result.merkleRoot).toBe(vector.merkleRoot);
    expect(anchors.submitted).toEqual([{ payloadHash: vector.merkleRoot, type: "rule_version" }]);
    expect(result).toMatchObject({ countryCode: "KR", taxYear: 2027, anchorStatus: "anchored", leafCount: vector.leaves.length });
  });

  it("탐색기가 없는 환경에서는 링크를 지어내지 않는다 — 401이 뜨는 주소를 주느니 없다고 말한다", async () => {
    const result = await service.record(USER, body());
    expect(result.explorerUrl).toBeNull();
    // 사용자가 직접 조회할 수 있는 값(거래 해시)은 반드시 남는다.
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("탐색기가 생기면(OMNIONE_EXPLORER_URL) 그 주소로 링크를 만든다", async () => {
    const previous = process.env.OMNIONE_EXPLORER_URL;
    process.env.OMNIONE_EXPLORER_URL = "https://scan.example.test/";
    try {
      const result = await service.record(USER, body());
      expect(result.explorerUrl).toBe(`https://scan.example.test/tx/${result.txHash}`);
    } finally {
      if (previous === undefined) delete process.env.OMNIONE_EXPLORER_URL;
      else process.env.OMNIONE_EXPLORER_URL = previous;
    }
  });

  it("체인에는 루트만 나간다 — 금액·거래 id는 앵커 포트를 넘지 않는다", async () => {
    await service.record(USER, body());
    // 제출 인자 전체를 문자열로 훑어 정본에 있던 값이 섞여 나갔는지 본다.
    const submitted = JSON.stringify(anchors.submitted);
    expect(submitted).not.toContain("evt-dispose");
    expect(submitted).not.toContain("21000000");
  });

  it("FE가 보낸 루트가 서버 계산과 다르면 올리지 않는다 — 재현 불가능한 해시를 남기지 않는다", async () => {
    const tampered = { ...body(), merkleRoot: `0x${"11".repeat(32)}` };
    await expect(service.record(USER, tampered)).rejects.toBeInstanceOf(BadRequestException);
    expect(anchors.submitted).toEqual([]);
  });

  it("FE가 보낸 루트가 맞으면 그대로 통과한다", async () => {
    const result = await service.record(USER, { ...body(), merkleRoot: vector.merkleRoot });
    expect(result.merkleRoot).toBe(vector.merkleRoot);
  });

  it("첫 잎이 헤더가 아니면 거절한다 — 귀속연도·국가 없이는 무엇을 봉인했는지 알 수 없다", async () => {
    const headless = { version: 1, leaves: vector.leaves.slice(1) };
    await expect(service.record(USER, headless)).rejects.toBeInstanceOf(BadRequestException);
    expect(anchors.submitted).toEqual([]);
  });

  it("같은 근거를 다시 올려도 기록은 하나다", async () => {
    const first = await service.record(USER, body());
    const second = await service.record(USER, body());
    expect(second.merkleRoot).toBe(first.merkleRoot);
    expect(second.recordedAt).toBe(first.recordedAt);
  });

  it("기록한 해를 다시 물으면 그때의 루트와 현재 앵커 상태를 돌려준다", async () => {
    await service.record(USER, body());
    const latest = await service.latest(USER, "KR", 2027);
    expect(latest).toMatchObject({ merkleRoot: vector.merkleRoot, anchorStatus: "anchored" });
    expect(await service.latest(USER, "KR", 2026)).toBeNull();
    expect(await service.latest("other-user", "KR", 2027)).toBeNull();
  });

  it("정본 원본은 올린 사람만 열 수 있다 — 건별 증명을 다시 만들 유일한 소스다", async () => {
    await service.record(USER, body());
    expect(await service.document(USER, vector.merkleRoot)).toMatchObject({ version: 1 });
    expect(await service.document("other-user", vector.merkleRoot)).toBeNull();
  });

  it("체인을 직접 읽어 내 루트가 올라가 있는지 대조한다 — 탐색기가 없어 이게 유일한 확인 창구다", async () => {
    await service.record(USER, body());
    const check = await service.checkChain(USER, vector.merkleRoot);

    expect(check).toMatchObject({ merkleRoot: vector.merkleRoot, readFromChain: true, success: true, matches: true });
    expect(check!.anchoredPayloadHash).toBe(vector.merkleRoot);
  });

  it("체인이 다른 해시를 갖고 있으면 일치하지 않는다고 말한다 — 성공한 트랜잭션이라도", async () => {
    await service.record(USER, body());
    anchors.onChainPayload = `0x${"99".repeat(32)}`;

    const check = await service.checkChain(USER, vector.merkleRoot);
    expect(check).toMatchObject({ readFromChain: true, success: true, matches: false });
  });

  it("체인을 읽지 못하면 '확인 못 함'이지 '없음'이 아니다", async () => {
    await service.record(USER, body());
    anchors.chainReadable = false;

    const check = await service.checkChain(USER, vector.merkleRoot);
    expect(check).toMatchObject({ readFromChain: false, matches: false });
    // 저장된 거래 해시는 남겨 준다 — 사용자가 직접 조회할 수 있어야 한다.
    expect(check!.txHash).not.toBeNull();
  });

  it("남의 근거를 체인에서 대신 조회해 주지 않는다", async () => {
    await service.record(USER, body());
    expect(await service.checkChain("other-user", vector.merkleRoot)).toBeNull();
  });
});
