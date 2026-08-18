import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import type { AnchorQueryPort } from "../anchor/anchor.port";
import { ANCHOR_QUERY } from "../anchor/anchor.tokens";
import { TransactionService } from "./transaction.service";

@Injectable()
export class AnchorProofService {
  constructor(private readonly transactions: TransactionService, @Inject(ANCHOR_QUERY) private readonly anchors: AnchorQueryPort) {}
  async get(userId: string, eventId?: string) {
    if (!eventId) throw new BadRequestException("eventId is required.");
    const transaction = await this.transactions.get(userId, eventId);
    if (!transaction) throw new NotFoundException("Anchor proof not found.");
    const payloadHash = String(transaction.payload._anchorPayloadHash);
    const anchor = await this.anchors.get(payloadHash);
    if (!anchor?.chainTxHash || !anchor.anchoredAt) throw new NotFoundException("Anchor proof not found.");
    return {
      tx_hash: anchor.chainTxHash,
      merkle_root: payloadHash,
      anchored_at: anchor.anchoredAt.toISOString(),
      explorer_url: `https://stage-chainapi.omnione.net/tx/${anchor.chainTxHash}`,
    };
  }
}
