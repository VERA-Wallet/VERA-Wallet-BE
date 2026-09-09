import Decimal from "decimal.js";
import type { TaxableTransaction } from "./types";

// Review flags, most severe first. A result carries at most one, so when several apply
// the highest-ranked wins (disposal_exceeds_holdings > bridge_move_unmatched > gas_unpriced).
export type CostBasisReview = "disposal_exceeds_holdings" | "bridge_move_unmatched" | "gas_unpriced";

const REVIEW_RANK: Record<CostBasisReview, number> = {
  disposal_exceeds_holdings: 3,
  bridge_move_unmatched: 2,
  gas_unpriced: 1,
};

function pickReview(a: CostBasisReview | undefined, b: CostBasisReview | undefined): CostBasisReview | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return REVIEW_RANK[a] >= REVIEW_RANK[b] ? a : b;
}

/**
 * Read-time inputs the fold cannot derive from the event payloads themselves.
 *
 * `nativePrices` is a plain map rather than a lookup callback on purpose: callers memoize
 * the fold on the *identity* of this object, and a fresh closure per call would make that
 * cache permanently miss. Keys are `${chainId}:${YYYY-MM-DD}` (UTC day of the event) and values are
 * the KRW unit close of that chain's native coin as a Decimal string. Omitting the option
 * disables gas accounting entirely, which is the pre-PR-2 behaviour.
 */
export type CostBasisOptions = {
  nativePrices?: ReadonlyMap<string, string>;
};

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
  // `excluded` means "this event is not a taxable line" — it does NOT mean "this event
  // leaves holdings untouched". The legs of a complete bridge pair are excluded (a
  // non-taxable transfer produces no gain) and still move quantity and cost between
  // asset cells; see the bridge branch in computeCostBasis.
  excluded: boolean;
  excludeReason?: string;
  // Set when a disposal exceeds tracked holdings: the excess is recognized at zero
  // cost and flagged for manual review rather than producing a fabricated basis.
  review?: CostBasisReview;
  // KRW value of this event's gas, present only on the leg the gas is attributed to.
  // null when the native close for that (chain, day) is unknown; absent when gas is
  // not attributed here (an excluded leg, a bridge leg, or a non-chosen swap leg).
  gasFiat?: string | null;
  // Present on both legs of a complete bridge pair: the leg that shipped the cost out
  // and the leg that received it.
  bridgeMove?: "out" | "in";
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

function idOf(transaction: TaxableTransaction): string {
  return String(transaction.payload.id ?? transaction.id);
}

/**
 * Bridge group this leg belongs to, or null.
 *
 * Both conditions are required: bridge-linking.service.ts always writes
 * `bridge_group_id` together with `classification: "INTERNAL_TRANSFER"`, so demanding
 * both means a user override that re-classifies a leg back to a taxable one takes it
 * out of the move (the pair then reads as incomplete and stays conservative) instead
 * of silently relocating the cost of a taxable event.
 */
function bridgeGroupOf(payload: Record<string, unknown>): string | null {
  if (payload.classification !== "INTERNAL_TRANSFER") return null;
  const group = payload.bridge_group_id;
  return typeof group === "string" && group.length > 0 ? group : null;
}

// Swap group (both legs of one exchange share it). Distinct from bridge_group_id.
function swapGroupOf(payload: Record<string, unknown>): string | null {
  const group = payload.group_id;
  return typeof group === "string" && group.length > 0 ? group : null;
}

function gasNativeOf(payload: Record<string, unknown>): Decimal | null {
  const raw = payload.gas_fee_native;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

function utcDay(value: string | Date): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * `${chainId}:${YYYY-MM-DD}` key into `options.nativePrices`, or null when the day cannot
 * be established. Mirrors dateOf() in historical-price-enrichment.service.ts (prefer
 * block_timestamp, fall back to occurredAt) so the engine reads exactly the keys the
 * warming pass writes.
 */
function nativePriceKeyOf(transaction: TaxableTransaction): string | null {
  const stamp = transaction.payload.block_timestamp;
  const day = (typeof stamp === "string" ? utcDay(stamp) : null) ?? utcDay(
    transaction.occurredAt instanceof Date ? transaction.occurredAt : String(transaction.occurredAt),
  );
  if (day === null) return null;
  return `${String(transaction.payload.chain_id ?? "")}:${day}`;
}

// Reason a transaction cannot contribute to cost-basis accounting, or null when it can.
function exclusionReason(payload: Record<string, unknown>): string | null {
  const classification = String(payload.classification ?? "");
  if (classification === "INTERNAL_TRANSFER") {
    // A linked leg keeps the historical reason string; an unlinked manual transfer gets
    // its own so callers can tell "cost was moved / could have been" from "no pair exists".
    return typeof payload.bridge_group_id === "string" && payload.bridge_group_id.length > 0
      ? "classification_INTERNAL_TRANSFER"
      : "internal_transfer_unlinked";
  }
  if (NON_TAXABLE_CLASSES.has(classification)) return `classification_${classification}`;
  if (payload.price_status === "UNKNOWN") return "price_unknown";
  if (fiatOf(payload) === null) return "no_fiat_value";
  return null;
}

// True when the event produces a taxable line (and can therefore absorb gas). Pure and
// payload-only, so gas attribution can be planned before the fold runs.
function isTaxableLine(payload: Record<string, unknown>): boolean {
  if (exclusionReason(payload) !== null) return false;
  const qty = quantityOf(payload);
  return qty !== null && qty.greaterThan(0) && fiatOf(payload) !== null;
}

type BridgePair = { outId: string; inId: string };
type BridgeScan = {
  // group id -> the one OUT / one IN whose cost actually moves
  pairs: Map<string, BridgePair>;
  // OUT legs carrying a bridge group that did NOT form a movable pair
  unmatchedOutIds: Set<string>;
};

/**
 * Pre-scan: decide which bridge groups move cost, before anything is folded.
 *
 * A group moves cost only when the input holds exactly one OUT leg and exactly one IN
 * leg for it and both carry a usable quantity — value is irrelevant here, a transfer is
 * defined by how much moved, not by what it was worth, so a leg with a null fiat_value
 * or price_status UNKNOWN still moves. Anything else (a half-synced pair, a transaction
 * that bridged two assets under one groupId, a leg with an unreadable amount) leaves the
 * legs excluded exactly as before and flags the OUT for review.
 */
function scanBridgePairs(events: TaxableTransaction[]): BridgeScan {
  type Legs = { outIds: string[]; inIds: string[]; usable: boolean };
  const groups = new Map<string, Legs>();
  for (const transaction of events) {
    const group = bridgeGroupOf(transaction.payload);
    if (group === null) continue;
    const legs = groups.get(group) ?? { outIds: [], inIds: [], usable: true };
    const qty = quantityOf(transaction.payload);
    if (qty === null || qty.lessThanOrEqualTo(0)) legs.usable = false;
    (transaction.payload.direction === "IN" ? legs.inIds : legs.outIds).push(idOf(transaction));
    groups.set(group, legs);
  }

  const pairs = new Map<string, BridgePair>();
  const unmatchedOutIds = new Set<string>();
  for (const [group, legs] of groups) {
    // outIds[0] !== inIds[0]: two legs reporting the same event id are not two legs. Pairing
    // them would make the reorder pass lift and reinsert the same position, dropping both from
    // the fold, so a duplicate id degrades to "no movable pair" like any other malformed group.
    if (legs.usable && legs.outIds.length === 1 && legs.inIds.length === 1 && legs.outIds[0] !== legs.inIds[0]) {
      pairs.set(group, { outId: legs.outIds[0], inId: legs.inIds[0] });
      continue;
    }
    for (const outId of legs.outIds) unmatchedOutIds.add(outId);
  }
  return { pairs, unmatchedOutIds };
}

/**
 * Stable post-sort pass that puts the IN leg of a complete pair after its OUT leg.
 *
 * This deliberately does NOT live in the sort comparator. A comparator term of the form
 * "inside a bridge group the OUT sorts first" breaks total order: with A = IN(group g,
 * log_index 0), C = an unrelated event(log_index 2) and B = OUT(group g, log_index 5) at
 * the same timestamp you get A < C, C < B and B < A — a cycle, and Array#sort is then
 * free to return any permutation. Correcting the order after a well-defined sort keeps
 * the comparator a total order and leaves every other event's relative position intact.
 * O(n) and deterministic.
 *
 * The pass corrects the inversion unconditionally. Today bridge linking requires the IN
 * to arrive at or after the OUT, so an inversion only shows up on a same-timestamp tie —
 * but that is a statement about how often it fires, not a precondition.
 */
function orderBridgeInsAfterOuts(
  ordered: TaxableTransaction[],
  pairs: Map<string, BridgePair>,
): TaxableTransaction[] {
  if (pairs.size === 0) return ordered;
  const position = new Map<string, number>();
  ordered.forEach((transaction, index) => position.set(idOf(transaction), index));

  const lifted = new Set<string>();
  const reinsertAfter = new Map<string, TaxableTransaction>();
  for (const { outId, inId } of pairs.values()) {
    const outAt = position.get(outId);
    const inAt = position.get(inId);
    if (outAt === undefined || inAt === undefined || inAt >= outAt) continue; // already in order
    lifted.add(inId);
    reinsertAfter.set(outId, ordered[inAt]);
  }
  if (lifted.size === 0) return ordered;

  const result: TaxableTransaction[] = [];
  for (const transaction of ordered) {
    const id = idOf(transaction);
    if (lifted.has(id)) continue;
    result.push(transaction);
    const pending = reinsertAfter.get(id);
    if (pending !== undefined) result.push(pending);
  }
  return result;
}

/**
 * Decide, per swap group, which single leg carries the transaction's gas.
 *
 * Gas is a cost of the whole transaction, so charging it to every leg of a swap would
 * double-count it. Preference order inside a group: the first eligible acquisition
 * (capitalize it into the new asset's basis), else the first eligible disposal (deduct it
 * from proceeds) so the fee is not silently dropped. Ungrouped events are their own
 * target. Excluded legs cannot absorb gas, and bridge legs are excluded by construction,
 * so a non-taxable move never carries a fee.
 */
function planGasAttribution(ordered: TaxableTransaction[]): Set<string> {
  const targets = new Set<string>();
  const firstIn = new Map<string, string>();
  const firstOut = new Map<string, string>();
  for (const transaction of ordered) {
    const payload = transaction.payload;
    if (!isTaxableLine(payload)) continue;
    const id = idOf(transaction);
    const group = swapGroupOf(payload);
    if (group === null) {
      targets.add(id);
      continue;
    }
    const bucket = payload.direction === "IN" ? firstIn : firstOut;
    if (!bucket.has(group)) bucket.set(group, id);
  }
  for (const id of firstIn.values()) targets.add(id);
  for (const [group, id] of firstOut) if (!firstIn.has(group)) targets.add(id);
  return targets;
}

// KRW gas for one event. `unpriced` is true only when there is gas to value and no close
// to value it with — a zero/absent fee is fully known and needs no review.
function gasFiatOf(
  transaction: TaxableTransaction,
  nativePrices: ReadonlyMap<string, string>,
): { value: Decimal | null; unpriced: boolean } {
  const gas = gasNativeOf(transaction.payload);
  if (gas === null || gas.lessThanOrEqualTo(0)) return { value: new Decimal(0), unpriced: false };
  const key = nativePriceKeyOf(transaction);
  const raw = key === null ? undefined : nativePrices.get(key);
  if (raw === undefined) return { value: null, unpriced: true };
  try {
    const unit = new Decimal(raw);
    if (!unit.isFinite() || unit.lessThan(0)) return { value: null, unpriced: true };
    return { value: gas.mul(unit), unpriced: false };
  } catch {
    return { value: null, unpriced: true };
  }
}

/**
 * Moving-average cost basis engine (KR 이동평균법 / JP 총평균법 family).
 *
 * Folds the events in chronological order, keeping one { qty, avgCost } cell per
 * asset key. Acquisitions (direction IN) roll the running average; disposals
 * (direction OUT, including the OUT leg of a swap/EXCHANGE) realize P/L against
 * that average. Input order is irrelevant — events are sorted by occurredAt first.
 *
 * Two kinds of event are not taxable lines but still change state:
 *  - the legs of a complete bridge pair move quantity and cost between asset cells;
 *  - the leg a transaction's gas is attributed to capitalizes or deducts that fee.
 *
 * Returns a Map keyed by event id. Excluded events (spam/unknown/internal-transfer
 * or missing price) are still present with excluded:true and an excludeReason.
 */
export function computeCostBasis(
  events: TaxableTransaction[],
  options?: CostBasisOptions,
): Map<string, CostBasisResult> {
  // Chronological fold. Same-timestamp events (e.g. both legs of a swap in one block)
  // break ties by on-chain log_index first, then event id, so ordering follows block
  // execution order rather than an arbitrary id sort.
  const sorted = [...events].sort(
    (a, b) =>
      occurredMs(a) - occurredMs(b) ||
      logIndexOf(a.payload) - logIndexOf(b.payload) ||
      String(a.payload.id ?? a.id).localeCompare(String(b.payload.id ?? b.id)),
  );
  const { pairs, unmatchedOutIds } = scanBridgePairs(events);
  const ordered = orderBridgeInsAfterOuts(sorted, pairs);
  const nativePrices = options?.nativePrices;
  const gasTargets = nativePrices === undefined ? new Set<string>() : planGasAttribution(ordered);

  const state = new Map<string, AssetState>();
  const results = new Map<string, CostBasisResult>();
  // Cost in flight between the two legs of a bridge, keyed by bridge group.
  const escrow = new Map<string, { cost: Decimal; outId: string }>();
  const unmatched = new Set<string>(unmatchedOutIds);

  for (const transaction of ordered) {
    const payload = transaction.payload;
    const eventId = idOf(transaction);
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

    // --- bridge move ------------------------------------------------------------
    // Runs before the exclusion gate: these legs ARE excluded (a non-taxable transfer
    // makes no gain), but the cost still has to travel, and it travels on quantity
    // alone so an unpriced leg must not short-circuit here.
    const bridgeGroup = bridgeGroupOf(payload);
    const pair = bridgeGroup === null ? undefined : pairs.get(bridgeGroup);
    if (bridgeGroup !== null && pair !== undefined) {
      const qty = quantityOf(payload)!; // scanBridgePairs only pairs legs with a usable quantity
      const key = assetKeyOf(payload);
      const cell = state.get(key) ?? { qty: new Decimal(0), avgCost: new Decimal(0) };
      const moved: CostBasisResult = {
        ...base,
        excluded: true,
        excludeReason: "classification_INTERNAL_TRANSFER",
      };

      if (direction === "OUT") {
        const disposable = Decimal.min(qty, cell.qty);
        state.set(key, { qty: Decimal.max(cell.qty.minus(qty), 0), avgCost: cell.avgCost });
        // Cost moves only when the source can account for the whole amount that left. If the
        // cell is short or empty, the cost that should travel is unknown — NOT zero — and
        // escrowing the partial figure would be worse than not moving at all: the destination
        // would receive quantity at a cheap or free average, its later disposal would read as
        // near-pure profit, and with no review flag that fabricated gain would sail into the
        // totals (ADR-000 exists to keep unknown cost out of them). So the pair stays unmatched
        // and the flag travels to the destination disposal instead.
        if (disposable.lessThan(qty)) {
          unmatched.add(eventId);
          results.set(eventId, { ...moved, review: "disposal_exceeds_holdings" });
          continue;
        }
        escrow.set(bridgeGroup, { cost: disposable.mul(cell.avgCost), outId: eventId });
        results.set(eventId, { ...moved, bridgeMove: "out" });
        continue;
      }

      const held = escrow.get(bridgeGroup);
      if (held === undefined) {
        // Either the OUT leg declined to move (short source, above) or — the case the reorder
        // pass exists to prevent — this IN ran before its OUT. Crediting a zero-cost
        // acquisition would manufacture basis, so credit nothing and let the OUT carry the flag.
        unmatched.add(pair.outId);
        results.set(eventId, moved);
        continue;
      }
      escrow.delete(bridgeGroup);
      // The whole shipped cost lands on whatever quantity arrived, so a bridge fee paid in
      // the asset itself is capitalized into the destination average rather than lost.
      const newQty = cell.qty.plus(qty);
      const newAvg = newQty.isZero() ? new Decimal(0) : cell.qty.mul(cell.avgCost).plus(held.cost).div(newQty);
      state.set(key, { qty: newQty, avgCost: newAvg });
      results.set(eventId, { ...moved, bridgeMove: "in", costBasis: held.cost.toFixed() });
      continue;
    }

    const reason = exclusionReason(payload);
    const qty = quantityOf(payload);
    const fiat = fiatOf(payload);
    if (reason !== null || qty === null || qty.lessThanOrEqualTo(0) || fiat === null) {
      results.set(eventId, { ...base, excluded: true, excludeReason: reason ?? (qty === null || qty.lessThanOrEqualTo(0) ? "no_quantity" : "no_fiat_value") });
      continue;
    }

    // --- gas ---------------------------------------------------------------------
    const gas = nativePrices !== undefined && gasTargets.has(eventId) ? gasFiatOf(transaction, nativePrices) : null;
    const gasAmount = gas?.value ?? null;
    const gasFields = gas === null ? {} : { gasFiat: gasAmount === null ? null : gasAmount.toFixed() };
    const gasReview: CostBasisReview | undefined = gas?.unpriced === true ? "gas_unpriced" : undefined;

    const key = assetKeyOf(payload);
    const cell = state.get(key) ?? { qty: new Decimal(0), avgCost: new Decimal(0) };

    if (direction === "IN") {
      // Acquisition gas is capitalized: it is part of what the asset cost to obtain.
      const acquired = gasAmount === null ? fiat : fiat.plus(gasAmount);
      const newQty = cell.qty.plus(qty);
      const newAvg = newQty.isZero() ? new Decimal(0) : cell.qty.mul(cell.avgCost).plus(acquired).div(newQty);
      state.set(key, { qty: newQty, avgCost: newAvg });
      results.set(eventId, {
        ...base,
        ...gasFields,
        costBasis: acquired.toFixed(),
        ...(gasReview !== undefined ? { review: gasReview } : {}),
      });
      continue;
    }

    // Disposal: recognize cost only up to tracked holdings; excess is zero-cost + flagged.
    // Disposal gas is deducted from proceeds instead: it reduces what the sale netted.
    const proceeds = gasAmount === null ? fiat : fiat.minus(gasAmount);
    const disposable = Decimal.min(qty, cell.qty);
    const cost = disposable.mul(cell.avgCost);
    const realized = proceeds.minus(cost);
    const ratio = cost.greaterThan(0) ? realized.div(cost) : null;
    state.set(key, { qty: Decimal.max(cell.qty.minus(qty), 0), avgCost: cell.avgCost });
    const review = pickReview(qty.greaterThan(cell.qty) ? "disposal_exceeds_holdings" : undefined, gasReview);
    results.set(eventId, {
      ...base,
      ...gasFields,
      costBasis: cost.toFixed(),
      proceeds: proceeds.toFixed(),
      realizedPnl: realized.toFixed(),
      pnlRatio: ratio === null ? null : ratio.toFixed(),
      ...(review !== undefined ? { review } : {}),
    });
  }

  // Cost that was shipped and never received (an IN leg missing from the fold, or one that
  // ran before its OUT) stays deducted from the source — inventing it back would be worse —
  // but the OUT leg says so.
  for (const held of escrow.values()) unmatched.add(held.outId);
  for (const outId of unmatched) {
    const result = results.get(outId);
    if (result === undefined) continue;
    results.set(outId, { ...result, review: pickReview(result.review, "bridge_move_unmatched")! });
  }

  return results;
}
