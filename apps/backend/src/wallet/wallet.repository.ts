import type { BindingRecord } from "../shared/repository.types";

export interface WalletBindingRepository {
  // initialSyncedAt is persistence-managed (defaults null at creation), so it is excluded from the create input.
  upsert(input: Omit<BindingRecord, "id" | "boundAt" | "initialSyncedAt">): Promise<BindingRecord>;
  findByUserAndAddress(userId: string, walletAddress: string): Promise<BindingRecord | null>;
}
export interface WalletRepository {
  findLatestByUser(userId: string): Promise<BindingRecord | null>;
  findAllByUser(userId: string): Promise<BindingRecord[]>;
  markInitialSynced(bindingId: string, at: Date): Promise<void>;
}
