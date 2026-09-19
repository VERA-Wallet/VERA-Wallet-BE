import { Inject, Injectable } from "@nestjs/common";
import type { AnchorType, EvidenceAnchor } from "@vera/interfaces";
import type { AnchorRepository } from "./anchor.repository";
import type { AnchorQueryPort } from "./anchor.port";
import { ANCHOR_REPOSITORY, EVIDENCE_ANCHOR } from "./anchor.tokens";

@Injectable()
export class AnchorService implements AnchorQueryPort {
  constructor(@Inject(EVIDENCE_ANCHOR) private readonly adapter: EvidenceAnchor, @Inject(ANCHOR_REPOSITORY) private readonly anchors: AnchorRepository) {}
  async prepare(payloadHash: string, type: AnchorType) { return this.anchors.create(payloadHash, type); }
  /**
   * 해시 하나를 체인에 올린다. **이미 올라갔으면 다시 올리지 않는다.**
   *
   * 큐 재시도가 그대로 새 트랜잭션이 되던 문제를 여기서 끊는다: 체인 쓰기는 성공했는데 작업이
   * 다른 이유로 실패로 보고되면(실제로 반환값의 bigint 직렬화가 그랬다) 같은 근거가 5번 올라가고
   * 기록된 tx 해시가 매번 바뀌어, 사용자가 저장해 둔 영수증 링크가 조용히 낡는다.
   */
  async process(payloadHash: string, type: AnchorType) {
    const anchored = await this.anchors.findByHash(payloadHash);
    if (anchored?.status === "anchored" && anchored.chainTxHash && anchored.blockNumber !== null && anchored.anchoredAt) {
      return { txHash: anchored.chainTxHash, blockNumber: anchored.blockNumber, anchoredAt: anchored.anchoredAt };
    }
    await this.anchors.incrementAttempts(payloadHash);
    try {
      const receipt = await this.adapter.anchor(payloadHash, type);
      await this.anchors.markAnchored(payloadHash, receipt.txHash, receipt.blockNumber, receipt.anchoredAt);
      return receipt;
    } catch (error) {
      const record = await this.anchors.findByHash(payloadHash);
      if ((record?.attempts ?? 0) >= 5) await this.anchors.markFailed(payloadHash);
      throw error;
    }
  }
  get(payloadHash: string) { return this.anchors.findByHash(payloadHash); }
  verify(txHash: string) { return this.adapter.verify(txHash); }
  inspect(txHash: string) { return this.adapter.inspect(txHash); }
  async markFailed(payloadHash: string) { await this.anchors.markFailed(payloadHash); }
}

export interface AnchorDispatcher { enqueue(payloadHash: string, type: AnchorType): Promise<void>; }
