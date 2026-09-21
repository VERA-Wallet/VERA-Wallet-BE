import type { BindingRecord } from "../shared/repository.types";

export interface WalletBindingRepository {
  // initialSyncedAt is persistence-managed (defaults null at creation), so it is excluded from the create input.
  upsert(input: Omit<BindingRecord, "id" | "boundAt" | "initialSyncedAt">): Promise<BindingRecord>;
  findByUserAndAddress(userId: string, walletAddress: string): Promise<BindingRecord | null>;
  /** 바인딩 행 하나를 지운다. 그 행을 가리키는 거래·커서는 호출자가 먼저 지워야 한다(FK). */
  delete(bindingId: string): Promise<void>;
}
export interface WalletRepository {
  findLatestByUser(userId: string): Promise<BindingRecord | null>;
  findAllByUser(userId: string): Promise<BindingRecord[]>;
  markInitialSynced(bindingId: string, at: Date): Promise<void>;
}
