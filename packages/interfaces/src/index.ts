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
  /**
   * 체인에서 트랜잭션을 직접 읽어 **무엇이 올라갔는지** 돌려준다.
   *
   * `verify`는 "성공했나"만 답한다. 그것만으로는 "내 계산 근거가 올라갔나"를 확인할 수 없다 —
   * 트랜잭션이 성공해도 다른 해시가 실려 있을 수 있기 때문이다. 이 체인에는 블록 탐색기가 없어
   * 사용자가 직접 대조할 방법이 없으므로, 서버가 원문을 읽어 와 대조해 준다.
   */
  inspect(txHash: string): Promise<AnchorInspection | null>;
}

/** 체인에 실제로 실려 있는 내용. */
export interface AnchorInspection {
  txHash: string;
  blockNumber: bigint;
  success: boolean;
  /** 트랜잭션이 실어 나른 payload 해시. calldata를 읽지 못하면 null. */
  anchoredPayloadHash: string | null;
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
