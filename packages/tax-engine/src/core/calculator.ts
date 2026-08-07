import Decimal from "decimal.js";
import { rules, isSupportedCountry } from "./rules";
import type { CalculatedTaxEvent, TaxableTransaction } from "./types";

export const ESTIMATE_DISCLAIMER =
  "본 결과는 지갑 데이터와 현재 룰셋에 기반한 추정치이며 세무 자문 또는 확정 신고 금액이 아닙니다.";

export function amountOf(payload: Record<string, unknown>): Decimal | null {
  const raw = payload.gainLoss ?? payload.fiat_value ?? payload.fiatValue;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  try { return new Decimal(raw); } catch { return null; }
}

export function calculateTaxEvents(transactions: TaxableTransaction[], countryCode: string, ruleVersion?: string): CalculatedTaxEvent[] {
  if (!isSupportedCountry(countryCode)) throw new Error(`Unsupported country: ${countryCode}`);
  const rule = rules[countryCode];
  return transactions.flatMap((transaction) => {
    const amount = amountOf(transaction.payload);
    if (amount === null) return [];
    const gainLoss = transaction.payload.direction === "IN" && transaction.payload.gainLoss === undefined ? amount.negated() : amount;
    return [{ transactionId: transaction.id, countryCode, ruleVersion: ruleVersion ?? rule.version, gainLoss: gainLoss.toFixed(), isEstimate: true as const }];
  });
}

export function summarize(events: CalculatedTaxEvent[]) {
  const totalGain = events.reduce((sum, event) => sum.plus(event.gainLoss), new Decimal(0));
  const rule = rules[events[0]?.countryCode ?? "KR"];
  return {
    totalGain: totalGain.toFixed(),
    estimatedTax: Decimal.max(totalGain, 0).mul(rule.rate).toFixed(),
    isEstimate: true as const,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}
