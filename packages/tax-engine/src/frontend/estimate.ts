import Decimal from "decimal.js";
import { amountOf, ESTIMATE_DISCLAIMER } from "../core/calculator";
import type { TaxableTransaction } from "../core/types";
import { getFrontendRuleSet } from "./rulesets";

/**
 * Structural superset of `CostBasisResult` (core/cost-basis).
 *
 * Declared locally instead of imported so this module stays tolerant of the engine
 * widening its own result shape (gas fiat, bridge moves, narrower `review` unions).
 * A `ReadonlyMap<string, CostBasisResult>` is assignable to a
 * `ReadonlyMap<string, FrontendCostBasis>` as long as the engine only narrows.
 */
export type FrontendCostBasis = {
  eventId: string;
  direction: "IN" | "OUT";
  costBasis: string;
  proceeds: string | null;
  realizedPnl: string | null;
  pnlRatio: string | null;
  excluded: boolean;
  excludeReason?: string;
  review?: string;
  gasFiat?: string | null;
  bridgeMove?: "out" | "in";
  isEstimate: true;
};

// Cost is unknown because the price is: the event has no usable fiat value at all.
const PRICE_EXCLUDE_REASONS = new Set(["price_unknown", "no_fiat_value", "no_quantity"]);
// Cost is known but the event is not a taxable line: spam / unclassified / internal move.
const NON_TAXABLE_EXCLUDE_REASONS = new Set(["internal_transfer_unlinked"]);
const REVIEW_UNRESOLVED_COST = "disposal_exceeds_holdings";

const LIMITATION_MESSAGES: Readonly<Record<string, string>> = {
  excluded: "가격 미확인 이벤트는 계산에서 제외했습니다.",
  review: "취득 원가를 확인할 수 없는 처분은 합계에서 제외하고 unresolvedProceeds로 보고했습니다.",
  non_taxable: "스팸·미분류·내부 이체 이벤트는 과세 대상이 아니므로 제외했습니다.",
};

type ScopedEvent = { transaction: TaxableTransaction; eventId: string; amount: Decimal | null; entry: FrontendCostBasis | undefined };

function eventIdOf(transaction: TaxableTransaction): string {
  return String(transaction.payload.id ?? transaction.id);
}

function isPriceExcluded(entry: FrontendCostBasis): boolean {
  return entry.excluded && PRICE_EXCLUDE_REASONS.has(entry.excludeReason ?? "");
}

function isNonTaxableExcluded(entry: FrontendCostBasis): boolean {
  const reason = entry.excludeReason ?? "";
  return entry.excluded && (reason.startsWith("classification_") || NON_TAXABLE_EXCLUDE_REASONS.has(reason));
}

// A disposal whose acquisition cost could not be established. Kept out of the totals
// (its cost is "unknown", not "zero") and reported separately as unresolvedProceeds.
function isUnresolvedDisposal(entry: FrontendCostBasis): boolean {
  return !entry.excluded && entry.direction === "OUT" && entry.review === REVIEW_UNRESOLVED_COST;
}

/**
 * Realized-P/L estimate for one tax year.
 *
 * `transactions` is the user's FULL history and `basis` is the moving-average fold over
 * that same history. The tax-year window is applied AFTER the fold, so a prior-year
 * acquisition still carries its cost into this year's disposals. Filtering first (the
 * previous behaviour) made every disposal look like it exceeded holdings.
 */
export function calculateFrontendEstimate(
  transactions: TaxableTransaction[],
  country: string,
  taxYear: number,
  basis: ReadonlyMap<string, FrontendCostBasis>,
) {
  const metadata = getFrontendRuleSet(country);
  if (!metadata) throw new Error(`Unsupported country: ${country}`);
  const { code, label: countryLabel, currency, costBasis: method, rate } = metadata;
  const from = `${taxYear}-01-01T00:00:00.000Z`;
  const to = `${taxYear + 1}-01-01T00:00:00.000Z`;
  const scoped: ScopedEvent[] = transactions
    .filter((transaction) => {
      const at = new Date(transaction.occurredAt).getTime();
      return at >= Date.parse(from) && at < Date.parse(to);
    })
    .map((transaction) => {
      const eventId = eventIdOf(transaction);
      return { transaction, eventId, amount: amountOf(transaction.payload), entry: basis.get(eventId) };
    });

  // Year attribution: only disposals realize P/L, and only when their cost is known.
  // Acquisitions contribute 0 — their cost lives in the running average, not in this year.
  let total = new Decimal(0);
  let unresolved = new Decimal(0);
  const known: { transaction: TaxableTransaction; amount: Decimal; entry: FrontendCostBasis }[] = [];
  const excludedIds: string[] = [];
  const reviewIds: string[] = [];
  const nonTaxableIds: string[] = [];

  for (const row of scoped) {
    const entry = row.entry;
    if (!entry) continue;
    if (isPriceExcluded(entry)) excludedIds.push(row.eventId);
    if (isNonTaxableExcluded(entry)) nonTaxableIds.push(row.eventId);
    if (isUnresolvedDisposal(entry)) {
      reviewIds.push(row.eventId);
      if (entry.proceeds !== null) unresolved = unresolved.plus(entry.proceeds);
    } else if (!entry.excluded && entry.direction === "OUT" && entry.realizedPnl !== null) {
      total = total.plus(entry.realizedPnl);
    }
    if (!entry.excluded && row.amount !== null) known.push({ transaction: row.transaction, amount: row.amount, entry });
  }

  const taxable = Decimal.max(total, 0);
  const estimatedCharge = taxable.mul(rate);
  const judgments = known.map(({ transaction, amount, entry }) => judgmentOf(transaction, amount, entry, code, countryLabel));
  const effective = taxable.isZero() ? new Decimal(0) : estimatedCharge.div(taxable).mul(100);
  const limitations = [
    { kind: "excluded", eventIds: excludedIds },
    { kind: "review", eventIds: reviewIds },
    { kind: "non_taxable", eventIds: nonTaxableIds },
  ]
    .filter((entry) => entry.eventIds.length > 0)
    .map((entry) => ({ kind: entry.kind, message: LIMITATION_MESSAGES[entry.kind] as string, eventIds: entry.eventIds }));
  // Back-compat: the flat list FE already reads is the union of every limitation bucket.
  const excludedEventIds = [...new Set([...excludedIds, ...reviewIds, ...nonTaxableIds])];

  return {
    country: code, countryLabel, currency, taxYear, period: { from, to }, method,
    status: code === "KR" ? "UNDETERMINED" : "PARTIAL",
    lines: [
      { key: "taxableGains", label: "과세 대상 손익", amount: taxable.toFixed() },
      { key: "estimatedCharge", label: "예상 부담액", amount: estimatedCharge.toFixed(), rate: `${new Decimal(rate).mul(100).toFixed()}%` },
    ],
    totals: { taxableGains: taxable.toFixed(), exemptGains: "0", incomeTotal: "0", taxableBase: taxable.toFixed(), estimatedCharge: estimatedCharge.toFixed(), effectiveRatePercent: effective.toFixed(), unresolvedProceeds: unresolved.toFixed() },
    lossCarryforward: Decimal.min(total, 0).abs().toFixed(), notes: [ESTIMATE_DISCLAIMER],
    limitations,
    openQuestions: code === "KR" ? [{ topic: "CAPITAL_GAINS", status: "UNDETERMINED", reason: "시행 세부 규정이 확정되지 않아 숫자를 확정할 수 없습니다.", affectedEventIds: judgments.map((row) => row.eventId) }] : [],
    requiredInputs: [], excludedEventIds, provenance: "mock" as const, judgments,
    isEstimate: true as const, disclaimer: ESTIMATE_DISCLAIMER,
  };
}

function judgmentOf(transaction: TaxableTransaction, amount: Decimal, entry: FrontendCostBasis, country: string, countryLabel: string) {
  const payload = transaction.payload;
  const inbound = payload.direction === "IN";
  return {
    eventId: String(payload.id ?? transaction.id), at: new Date(transaction.occurredAt).toISOString(), asset: `${payload.chain_id ?? 1}:${payload.asset_contract ?? "native"}`,
    symbol: String(payload.symbol ?? (payload.asset_type === "NATIVE" ? "ETH" : "TOKEN")), quantity: String(payload.raw_amount ?? "0"),
    amount: amount.toFixed(), amountKind: inbound ? "cost" : "gain", holdingDays: null, acquiredAt: null, leg: "single",
    group: country === "KR" ? "pending" : inbound ? "acquire" : "taxable", label: country === "KR" ? "판정 대기" : inbound ? "취득 · 원가 기록" : "과세 대상",
    lots: 1, inPeriod: true, basis: `${countryLabel} v1 데모 룰셋`,
    costBasis: entry.costBasis, realizedPnl: entry.realizedPnl, pnlReview: entry.review ?? null,
    ...(!inbound ? { breakdown: { proceeds: amount.toFixed(), cost: entry.costBasis, fee: String(payload.gas_fee_native ?? "0"), feeFiat: entry.gasFiat ?? null } } : {}),
  };
}
