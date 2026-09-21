import type { AnchorInspection, AnchorType } from "@vera/interfaces";
import type { AnchorRecordView } from "../shared/repository.types";

export interface AnchorSubmissionPort {
  submit(payloadHash: string, type: AnchorType): Promise<AnchorRecordView | null>;
}

export interface AnchorQueryPort {
  get(payloadHash: string): Promise<AnchorRecordView | null>;
  verify(txHash: string): Promise<boolean>;
  /** 체인에서 트랜잭션을 직접 읽는다. DB가 아는 것과 체인이 실제로 가진 것을 대조하기 위한 통로다. */
  inspect(txHash: string): Promise<AnchorInspection | null>;
  // Transition a record to `failed` so a later sync retries it (used when enqueue itself rejects,
  // which would otherwise leave the record stuck `pending` and skipped forever).
  markFailed(payloadHash: string): Promise<void>;
}
