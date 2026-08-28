import Decimal from "decimal.js";
import type { TaxableTransaction } from "./types";

// Per-disposal / per-acquisition cost result. Cost basis is an order-dependent
// derived value, so this engine is a pure read-time fold over the event stream:
// nothing here is persisted. Every monetary field is a Decimal-fixed string in the
// event's own fiat unit; ratios are plain decimals (0.25 => +25%).
export type CostBasisResult = {
  eventId: string;
  direction: "IN" | "OUT";
  // IN  => acquisition total added to the running average (0 when excluded).
  // OUT => cost of the disposed quantity recognized against holdings.
  costBasis: string;
  // OUT only: gross disposal value; null for acquisitions and excluded events.
  proceeds: string | null;
  realizedPnl: string | null;
  // realizedPnl / costBasis; null when there is no positive cost to divide by.
  pnlRatio: string | null;
  excluded: boolean;
  excludeReason?: string;
  // Set when a disposal exceeds tracked holdings: the excess is recognized at zero
  // cost and flagged for manual review rather than producing a fabricated basis.
  review?: string;
  isEstimate: true;
};

// classification values that never participate in realized-P/L accounting. Mirrors
// the computable filter in event-query.service.ts summary().
const NON_TAXABLE_CLASSES = new Set(["SPAM", "UNKNOWN", "INTERNAL_TRANSFER"]);

type AssetState = { qty: Decimal; avgCost: Decimal };

function assetKeyOf(payload: Record<string, unknown>): string {
  const chainId = payload.chain_id ?? "";
  const assetType = String(payload.asset_type ?? "");
  const contract = assetType === "NATIVE" ? "native" : String(payload.asset_contract ?? "").toLowerCase();
  const tokenId = payload.token_id ?? "";
  return `${chainId}:${assetType}:${contract}:${tokenId}`;
}

function quantityOf(payload: Record<string, unknown>): Decimal | null {
  const raw = payload.raw_amount;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const decimals = Number(payload.decimals ?? 0);
  try {
    const amount = new Decimal(raw);
    if (!amount.isFinite()) return null; // decimal.js accepts NaN/Infinity without throwing
    return Number.isFinite(decimals) && decimals > 0 ? amount.div(Decimal.pow(10, decimals)) : amount;
  } catch {
    return null;
  }
}

function fiatOf(payload: Record<string, unknown>): Decimal | null {
  const raw = payload.fiat_value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? value : null; // reject NaN/Infinity poisoning the running average
  } catch {
    return null;
  }
}

function logIndexOf(payload: Record<string, unknown>): number {
  const raw = Number(payload.log_index);
  return Number.isFinite(raw) ? raw : 0;
}

function occurredMs(transaction: TaxableTransaction): number {
  const at = transaction.occurredAt;
  return at instanceof Date ? at.getTime() : new Date(at).getTime();
}

// Reason a transaction cannot contribute to cost-basis accounting, or null when it can.
function exclusionReason(payload: Record<string, unknown>): string | null {
  const classification = String(payload.classification ?? "");
  if (NON_TAXABLE_CLASSES.has(classification)) return `classification_${classification}`;
  if (payload.price_status === "UNKNOWN") return "price_unknown";
  if (fiatOf(payload) === null) return "no_fiat_value";
  return null;
}

/**
 * Moving-average cost basis engine (KR 이동평균법 / JP 총평균법 family).
 *
 * Folds the events in chronological order, keeping one { qty, avgCost } cell per
 * asset key. Acquisitions (direction IN) roll the running average; disposals
 * (direction OUT, including the OUT leg of a swap/EXCHANGE) realize P/L against
 * that average. Input order is irrelevant — events are sorted by occurredAt first.
 *
 * Returns a Map keyed by event id. Excluded events (spam/unknown/internal-transfer
 * or missing price) are still present with excluded:true and an excludeReason, and
 * never mutate holdings.
 */
export function computeCostBasis(events: TaxableTransaction[]): Map<string, CostBasisResult> {
  // Chronological fold. Same-timestamp events (e.g. both legs of a swap in one block)
  // break ties by on-chain log_index first, then event id, so ordering follows block
  // execution order rather than an arbitrary id sort.
  const ordered = [...events].sort(
    (a, b) =>
      occurredMs(a) - occurredMs(b) ||
      logIndexOf(a.payload) - logIndexOf(b.payload) ||
      String(a.payload.id ?? a.id).localeCompare(String(b.payload.id ?? b.id)),
  );
  const state = new Map<string, AssetState>();
  const results = new Map<string, CostBasisResult>();

  for (const transaction of ordered) {
    const payload = transaction.payload;
    const eventId = String(payload.id ?? transaction.id);
    const direction: "IN" | "OUT" = payload.direction === "IN" ? "IN" : "OUT";
    const base: CostBasisResult = {
      eventId,
      direction,
      costBasis: "0",
      proceeds: null,
      realizedPnl: null,
      pnlRatio: null,
      excluded: false,
      isEstimate: true,
    };

    const reason = exclusionReason(payload);
    const qty = quantityOf(payload);
    const fiat = fiatOf(payload);
    if (reason !== null || qty === null || qty.lessThanOrEqualTo(0) || fiat === null) {
      results.set(eventId, { ...base, excluded: true, excludeReason: reason ?? (qty === null || qty.lessThanOrEqualTo(0) ? "no_quantity" : "no_fiat_value") });
      continue;
    }

    const key = assetKeyOf(payload);
    const cell = state.get(key) ?? { qty: new Decimal(0), avgCost: new Decimal(0) };

    if (direction === "IN") {
      const newQty = cell.qty.plus(qty);
      const newAvg = newQty.isZero() ? new Decimal(0) : cell.qty.mul(cell.avgCost).plus(fiat).div(newQty);
      state.set(key, { qty: newQty, avgCost: newAvg });
      results.set(eventId, { ...base, costBasis: fiat.toFixed() });
      continue;
    }

    // Disposal: recognize cost only up to tracked holdings; excess is zero-cost + flagged.
    const disposable = Decimal.min(qty, cell.qty);
    const cost = disposable.mul(cell.avgCost);
    const realized = fiat.minus(cost);
    const ratio = cost.greaterThan(0) ? realized.div(cost) : null;
    state.set(key, { qty: Decimal.max(cell.qty.minus(qty), 0), avgCost: cell.avgCost });
    results.set(eventId, {
      ...base,
      costBasis: cost.toFixed(),
      proceeds: fiat.toFixed(),
      realizedPnl: realized.toFixed(),
      pnlRatio: ratio === null ? null : ratio.toFixed(),
      ...(qty.greaterThan(cell.qty) ? { review: "disposal_exceeds_holdings" } : {}),
    });
  }

  return results;
}
