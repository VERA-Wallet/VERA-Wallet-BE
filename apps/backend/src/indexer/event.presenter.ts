import type { CostBasisResult } from "@vera/tax-engine";
import type { TransactionRecord } from "../shared/repository.types";

// Read-time cost-basis fields merged onto a public event. Derived (never persisted),
// so an excluded event (spam/unknown/missing price) carries nulls rather than fabricated
// numbers; FE reads price_status to explain why. `pnl`/`pnl_ratio` are null for
// acquisitions (IN) and only populated on disposals (OUT/EXCHANGE).
//
// `gas_fee_fiat` is always present (null when the fee could not be valued, or is not
// attributed to this leg) so FE can bind one stable key. `bridge_move` and `pnl_review`
// appear only when set, since absence is their normal state.
function costBasisFields(costBasis: CostBasisResult) {
  return {
    cost_basis: costBasis.excluded ? null : costBasis.costBasis,
    pnl: costBasis.realizedPnl,
    pnl_ratio: costBasis.pnlRatio,
    gas_fee_fiat: costBasis.gasFiat ?? null,
    ...(costBasis.bridgeMove ? { bridge_move: costBasis.bridgeMove } : {}),
    ...(costBasis.review ? { pnl_review: costBasis.review } : {}),
  };
}

export function publicEvent(transaction: TransactionRecord, costBasis?: CostBasisResult) {
  const { _version: _version, _overrideHistory: _history, _anchorPayloadHash: _anchor, ...event } = transaction.payload;
  return costBasis ? { ...event, ...costBasisFields(costBasis) } : event;
}

export function eventMutation(transaction: TransactionRecord, costBasis?: CostBasisResult) {
  return { event: publicEvent(transaction, costBasis), version: Number(transaction.payload._version ?? 1) };
}

export function eventDetail(transaction: TransactionRecord, costBasis?: CostBasisResult) {
  return { ...eventMutation(transaction, costBasis), override_history: transaction.payload._overrideHistory ?? [] };
}
