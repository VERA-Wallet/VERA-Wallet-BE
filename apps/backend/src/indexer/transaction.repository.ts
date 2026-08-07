import type { IndexedTransaction } from "@vera/interfaces";
import type { TransactionRecord } from "../shared/repository.types";

export interface TransactionRepository {
  listForUser(userId: string): Promise<TransactionRecord[]>;
  findForUser(userId: string, id: string): Promise<TransactionRecord | null>;
  updatePayload(userId: string, id: string, payload: Record<string, unknown>): Promise<TransactionRecord | null>;
}
export interface TransactionSyncRepository {
  save(bindingId: string, userId: string, sourceItems: IndexedTransaction[]): Promise<TransactionRecord[]>;
}
