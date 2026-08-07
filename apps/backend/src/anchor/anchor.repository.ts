import type { AnchorRecordView } from "../shared/repository.types";

export interface AnchorRepository {
  create(payloadHash: string, anchorType: string): Promise<AnchorRecordView>;
  findByHash(payloadHash: string): Promise<AnchorRecordView | null>;
  incrementAttempts(payloadHash: string): Promise<void>;
  markAnchored(payloadHash: string, txHash: string, blockNumber: bigint, anchoredAt: Date): Promise<void>;
  markFailed(payloadHash: string): Promise<void>;
}
