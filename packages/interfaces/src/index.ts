export interface IdentityProvider {
  requestVerification(sessionId: string): Promise<VerificationRequest>;
  handleCallback(token: string): Promise<VerifiedIdentity>;
}

export interface VerificationRequest {
  sessionId: string;
  verificationUrl: string;
  deepLink?: string;
  expiresAt: Date;
}

export interface VerifiedIdentity {
  didHash: string;
  verifiedAt: Date;
  method: "omnione_cx" | "mock";
}

export type AnchorType = "binding" | "rule_version" | "audit";

export interface EvidenceAnchor {
  anchor(payloadHash: string, type: AnchorType): Promise<AnchorReceipt>;
  verify(txHash: string): Promise<boolean>;
}

export interface AnchorReceipt {
  txHash: string;
  blockNumber: bigint;
  anchoredAt: Date;
}

export interface ChainScanResult {
  transactions: IndexedTransaction[];
  // Per-chain scanned head (block number) for chains that were COMPLETELY observed
  // this pass. Absent chains were skipped/errored/truncated and must not advance a cursor.
  chainHeads: Record<number, number>;
}

/** One chain's complete observation: transfers, recovered native legs and normalization all done. */
export interface ChainScanOutcome {
  chainId: number;
  head: number;
  transactions: IndexedTransaction[];
}

/** Where one chain's scan currently is. `fetched` counts raw transfers pulled so far. */
export interface ChainScanProgress {
  chainId: number;
  phase: "fetching" | "tracing";
  fetched: number;
  traced?: { done: number; total: number };
}

/**
 * Optional streaming side of a scan. An adapter that can finish chains independently hands each one
 * over the moment it is complete, so the caller can persist it before the slower chains finish. The
 * aggregate `ChainScanResult` is still returned, for callers and adapters that do not stream.
 */
export interface ChainScanHooks {
  onChain?(outcome: ChainScanOutcome): void | Promise<void>;
  onProgress?(progress: ChainScanProgress): void;
  /** A chain was withheld (incomplete or failed), with the reason the adapter would otherwise only log. */
  onChainError?(chainId: number, message: string): void;
}

export interface ChainIndexer {
  fetchTransactions(address: string, sinceByChain?: Record<number, bigint>, hooks?: ChainScanHooks): Promise<ChainScanResult>;
}

export interface IndexedTransaction {
  source: "alchemy" | "mock";
  txHash: string;
  chain: string;
  eventType: "swap" | "transfer_in" | "transfer_out" | "staking_reward" | "airdrop" | "lp_add" | "lp_remove" | "unknown";
  occurredAt: Date;
  payload: Record<string, unknown>;
}
