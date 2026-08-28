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

export interface ChainIndexer {
  fetchTransactions(address: string, sinceByChain?: Record<number, bigint>): Promise<ChainScanResult>;
}

export interface IndexedTransaction {
  source: "alchemy" | "mock";
  txHash: string;
  chain: string;
  eventType: "swap" | "transfer_in" | "transfer_out" | "staking_reward" | "airdrop" | "lp_add" | "lp_remove" | "unknown";
  occurredAt: Date;
  payload: Record<string, unknown>;
}
