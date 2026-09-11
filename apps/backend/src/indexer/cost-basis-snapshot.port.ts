import type { CostBasisResult, HoldingCostBasis } from "@vera/tax-engine";
import type { TransactionRecord } from "../shared/repository.types";

// Framework-free port over the shared cost-basis fold. Another feature module (tax) reads
// the same snapshot the events read path built, without importing the indexer's concrete
// service — the same shape as TransactionAvailabilityPort.
export interface CostBasisSnapshotPort {
  // Moving-average fold over the user's FULL history, keyed by event id. Callers must
  // pass the whole ledger: a period filter applied first drops the prior-year
  // acquisitions that carry cost into this year's disposals.
  snapshotFor(userId: string, rows: TransactionRecord[], opts?: { gas?: boolean }): Promise<Map<string, CostBasisResult>>;
  // Terminal state of the same fold: remaining quantity + average cost per asset cell, keyed
  // by `holdingAssetKey`. Same full-ledger requirement; the portfolio read joins live balances on it.
  holdingsFor(userId: string, rows: TransactionRecord[], opts?: { gas?: boolean }): Promise<Map<string, HoldingCostBasis>>;
}
