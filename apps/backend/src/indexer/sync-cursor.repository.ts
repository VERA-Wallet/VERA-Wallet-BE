// Pure framework-free port: per-(binding, chain) incremental sync cursor.
export type ChainCursor = { chainId: number; lastSyncedBlock: bigint };

export interface SyncCursorRepository {
  listForBinding(bindingId: string): Promise<ChainCursor[]>;
  // Advance is monotonic: a lower head must never lower the stored value.
  advance(bindingId: string, chainId: number, head: bigint): Promise<void>;
}
