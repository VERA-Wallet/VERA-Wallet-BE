import type { BindingRecord } from "../shared/repository.types";

export interface WalletBindingRepository {
  upsert(input: Omit<BindingRecord, "id" | "boundAt">): Promise<BindingRecord>;
}
export interface WalletRepository {
  findLatestByUser(userId: string): Promise<BindingRecord | null>;
}
