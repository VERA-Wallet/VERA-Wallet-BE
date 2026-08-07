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

export interface ChainIndexer {
  fetchTransactions(address: string): Promise<IndexedTransaction[]>;
}

export interface IndexedTransaction {
  source: "alchemy" | "mock";
  txHash: string;
  chain: string;
  eventType: "swap" | "transfer_in" | "transfer_out" | "staking_reward" | "airdrop" | "lp_add" | "lp_remove" | "unknown";
  occurredAt: Date;
  payload: Record<string, unknown>;
}
