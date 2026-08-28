import type { AnchorType } from "@vera/interfaces";
import type { AnchorRecordView } from "../shared/repository.types";

export interface AnchorSubmissionPort {
  submit(payloadHash: string, type: AnchorType): Promise<AnchorRecordView | null>;
}

export interface AnchorQueryPort {
  get(payloadHash: string): Promise<AnchorRecordView | null>;
  verify(txHash: string): Promise<boolean>;
  // Transition a record to `failed` so a later sync retries it (used when enqueue itself rejects,
  // which would otherwise leave the record stuck `pending` and skipped forever).
  markFailed(payloadHash: string): Promise<void>;
}
