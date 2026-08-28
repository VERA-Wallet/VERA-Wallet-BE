export type UserRecord = { id: string; didHash: string; createdAt: Date };
export type BindingRecord = { id: string; userId: string; walletAddress: string; bindingHash: string | null; verificationMethod: string; verifiedAt: Date | null; boundAt: Date; initialSyncedAt: Date | null };
export type TransactionRecord = { id: string; bindingId: string; txHash: string; eventType: string; chain: string; payload: Record<string, unknown>; occurredAt: Date };
export type TaxEventRecord = { id: string; txId: string; reportId: string | null; countryCode: string; ruleVersion: string; gainLoss: string; isEstimate: boolean };
export type ReportRecord = { id: string; userId: string; period: string; countryCode: string; totalGain: string; status: string; createdAt: Date };
export type AnchorRecordView = { id: string; payloadHash: string; anchorType: string; chainTxHash: string | null; blockNumber: bigint | null; status: string; attempts: number; anchoredAt: Date | null; createdAt: Date };
