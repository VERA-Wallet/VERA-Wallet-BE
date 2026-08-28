import { Inject, Injectable } from "@nestjs/common";
import type { AnchorType, EvidenceAnchor } from "@vera/interfaces";
import type { AnchorRepository } from "./anchor.repository";
import type { AnchorQueryPort } from "./anchor.port";
import { ANCHOR_REPOSITORY, EVIDENCE_ANCHOR } from "./anchor.tokens";

@Injectable()
export class AnchorService implements AnchorQueryPort {
  constructor(@Inject(EVIDENCE_ANCHOR) private readonly adapter: EvidenceAnchor, @Inject(ANCHOR_REPOSITORY) private readonly anchors: AnchorRepository) {}
  async prepare(payloadHash: string, type: AnchorType) { return this.anchors.create(payloadHash, type); }
  async process(payloadHash: string, type: AnchorType) {
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
  async markFailed(payloadHash: string) { await this.anchors.markFailed(payloadHash); }
}

export interface AnchorDispatcher { enqueue(payloadHash: string, type: AnchorType): Promise<void>; }
