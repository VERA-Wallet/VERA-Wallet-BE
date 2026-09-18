// Pure framework-free port: per-(binding, chain) incremental sync cursor.
// `rulesVersion` is the NORMALIZATION_RULES_VERSION the chain was last walked under. A cursor behind the
// current constant is stale evidence, not progress: the sync treats it as absent and walks the chain from
// genesis again (see normalization-rules.ts).
export type ChainCursor = { chainId: number; lastSyncedBlock: bigint; rulesVersion: number };

export interface SyncCursorRepository {
  listForBinding(bindingId: string): Promise<ChainCursor[]>;
  // Advance is monotonic on both fields: a lower head or an older rules version never lowers the stored value.
  advance(bindingId: string, chainId: number, head: bigint, rulesVersion: number): Promise<void>;
}
