import Decimal from "decimal.js";
import { amountOf, ESTIMATE_DISCLAIMER } from "../core/calculator";
import type { TaxableTransaction } from "../core/types";
import { frontendRates, frontendRuleSets } from "./rulesets";

export function calculateFrontendEstimate(transactions: TaxableTransaction[], country: string, taxYear: number) {
  const metadata = frontendRuleSets.find(([code]) => code === country);
  if (!metadata) throw new Error(`Unsupported country: ${country}`);
  const [, countryLabel, currency, method] = metadata;
  const from = `${taxYear}-01-01T00:00:00.000Z`;
  const to = `${taxYear + 1}-01-01T00:00:00.000Z`;
  const inPeriod = transactions.filter((transaction) => {
    const at = new Date(transaction.occurredAt).getTime();
    return at >= Date.parse(from) && at < Date.parse(to);
  });
  const known = inPeriod.map((transaction) => ({ transaction, amount: amountOf(transaction.payload) })).filter((item): item is { transaction: TaxableTransaction; amount: Decimal } => item.amount !== null);
  const excludedEventIds = inPeriod.filter((transaction) => amountOf(transaction.payload) === null).map((transaction) => String(transaction.payload.id ?? transaction.id));
  const total = known.reduce((sum, item) => sum.plus(item.transaction.payload.direction === "IN" ? item.amount.negated() : item.amount), new Decimal(0));
  const taxable = Decimal.max(total, 0);
  const estimatedCharge = taxable.mul(frontendRates[country] ?? "0");
  const judgments = known.map(({ transaction, amount }) => judgmentOf(transaction, amount, country, countryLabel));
  const effective = taxable.isZero() ? new Decimal(0) : estimatedCharge.div(taxable).mul(100);
  return {
    country, countryLabel, currency, taxYear, period: { from, to }, method,
    status: country === "KR" ? "UNDETERMINED" : "PARTIAL",
    lines: [
      { key: "taxableGains", label: "과세 대상 손익", amount: taxable.toFixed() },
      { key: "estimatedCharge", label: "예상 부담액", amount: estimatedCharge.toFixed(), rate: `${new Decimal(frontendRates[country] ?? 0).mul(100).toFixed()}%` },
    ],
    totals: { taxableGains: taxable.toFixed(), exemptGains: "0", incomeTotal: "0", taxableBase: taxable.toFixed(), estimatedCharge: estimatedCharge.toFixed(), effectiveRatePercent: effective.toFixed() },
    lossCarryforward: Decimal.min(total, 0).abs().toFixed(), notes: [ESTIMATE_DISCLAIMER],
    limitations: excludedEventIds.length ? [{ kind: "excluded", message: "가격 미확인 이벤트는 계산에서 제외했습니다.", eventIds: excludedEventIds }] : [],
    openQuestions: country === "KR" ? [{ topic: "CAPITAL_GAINS", status: "UNDETERMINED", reason: "시행 세부 규정이 확정되지 않아 숫자를 확정할 수 없습니다.", affectedEventIds: judgments.map((row) => row.eventId) }] : [],
    requiredInputs: [], excludedEventIds, provenance: "mock" as const, judgments,
    isEstimate: true as const, disclaimer: ESTIMATE_DISCLAIMER,
  };
}

function judgmentOf(transaction: TaxableTransaction, amount: Decimal, country: string, countryLabel: string) {
  const payload = transaction.payload;
  const inbound = payload.direction === "IN";
  return {
    eventId: String(payload.id ?? transaction.id), at: new Date(transaction.occurredAt).toISOString(), asset: `${payload.chain_id ?? 1}:${payload.asset_contract ?? "native"}`,
    symbol: String(payload.symbol ?? (payload.asset_type === "NATIVE" ? "ETH" : "TOKEN")), quantity: String(payload.raw_amount ?? "0"),
    amount: amount.toFixed(), amountKind: inbound ? "cost" : "gain", holdingDays: null, acquiredAt: null, leg: "single",
    group: country === "KR" ? "pending" : inbound ? "acquire" : "taxable", label: country === "KR" ? "판정 대기" : inbound ? "취득 · 원가 기록" : "과세 대상",
    lots: 1, inPeriod: true, basis: `${countryLabel} v1 데모 룰셋`,
    ...(!inbound ? { breakdown: { proceeds: amount.toFixed(), cost: "0", fee: String(payload.gas_fee_native ?? "0") } } : {}),
  };
}
