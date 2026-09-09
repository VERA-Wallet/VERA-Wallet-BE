import { describe, expect, it } from "vitest";
import { computeCostBasis } from "../core/cost-basis";
import type { TaxableTransaction } from "../core/types";
import { calculateFrontendEstimate } from "./estimate";

// Human quantity -> base units (18 decimals), matching the indexer payload shape.
function evt(
  id: string,
  direction: "IN" | "OUT",
  tokens: string,
  fiat: string | null,
  occurredAt: string,
  overrides: Record<string, unknown> = {},
): TaxableTransaction {
  return {
    id,
    eventType: direction === "IN" ? "transfer_in" : "transfer_out",
    occurredAt,
    payload: {
      id,
      chain_id: 1,
      asset_type: "ERC20",
      asset_contract: "0xAAA",
      symbol: "TKN",
      decimals: 18,
      raw_amount: `${tokens}${"0".repeat(18)}`,
      fiat_value: fiat,
      price_status: fiat === null ? "UNKNOWN" : "RESOLVED",
      classification: direction === "IN" ? "RECEIVE" : "SEND",
      direction,
      log_index: 0,
      gas_fee_native: "0",
      ...overrides,
    },
  };
}

// The engine is always folded over the FULL history; the tax-year window is applied
// inside calculateFrontendEstimate, after the fold.
function estimate(transactions: TaxableTransaction[], taxYear: number, country = "KR") {
  return calculateFrontendEstimate(transactions, country, taxYear, computeCostBasis(transactions));
}

describe("calculateFrontendEstimate", () => {
  // E1 — prior-year acquisition still carries its cost into this year's disposal.
  // Filtering by year before the fold (the old behaviour) reported 1,500,000.
  it("attributes realized P/L to the disposal year using a prior-year acquisition", () => {
    const history = [
      evt("buy-2024", "IN", "1", "1000000", "2024-06-01T00:00:00.000Z"),
      evt("sell-2025", "OUT", "1", "1500000", "2025-03-01T00:00:00.000Z"),
    ];
    const result = estimate(history, 2025);
    expect(result.totals.taxableGains).toBe("500000");
    expect(result.lossCarryforward).toBe("0");
    expect(result.totals.unresolvedProceeds).toBe("0");
    expect(result.limitations).toEqual([]);
  });

  // E2 — an acquisition-only year realizes nothing (the old cash-flow sum reported 1,000,000).
  it("reports zero for a year that only contains acquisitions", () => {
    const history = [
      evt("buy-2024", "IN", "1", "1000000", "2024-06-01T00:00:00.000Z"),
      evt("sell-2025", "OUT", "1", "1500000", "2025-03-01T00:00:00.000Z"),
    ];
    const result = estimate(history, 2024);
    expect(result.totals.taxableGains).toBe("0");
    expect(result.lossCarryforward).toBe("0");
  });

  // E3 — a realized loss clamps taxable gains to zero and surfaces as carryforward.
  it("carries a realized loss forward instead of taxing it", () => {
    const history = [
      evt("buy", "IN", "1", "1000000", "2025-01-10T00:00:00.000Z"),
      evt("sell", "OUT", "1", "800000", "2025-02-10T00:00:00.000Z"),
    ];
    const result = estimate(history, 2025);
    expect(result.totals.taxableGains).toBe("0");
    expect(result.lossCarryforward).toBe("200000");
  });

  // E4 — an unpriced disposal cannot be valued, so it leaves the totals entirely.
  it("excludes a disposal with an unknown price and lists it under limitations", () => {
    const history = [
      evt("buy", "IN", "1", "1000000", "2025-01-10T00:00:00.000Z"),
      evt("sell-unpriced", "OUT", "1", null, "2025-02-10T00:00:00.000Z"),
    ];
    const result = estimate(history, 2025);
    expect(result.totals.taxableGains).toBe("0");
    expect(result.totals.unresolvedProceeds).toBe("0");
    const excluded = result.limitations.find((row) => row.kind === "excluded");
    expect(excluded?.eventIds).toContain("sell-unpriced");
    expect(excluded?.message).toBe("가격 미확인 이벤트는 계산에서 제외했습니다.");
    expect(result.excludedEventIds).toContain("sell-unpriced");
    expect(result.judgments.map((row) => row.eventId)).not.toContain("sell-unpriced");
  });

  // E5 (Decision 0) — cost is "unknown", not "zero": out of the totals, into unresolvedProceeds.
  // The per-event judgment still reports what is actually known.
  it("keeps a cost-unresolved disposal out of the totals but reports it per event", () => {
    const history = [evt("sell-orphan", "OUT", "1", "900000", "2025-02-10T00:00:00.000Z")];
    const result = estimate(history, 2025);
    expect(result.totals.taxableGains).toBe("0");
    expect(result.lossCarryforward).toBe("0");
    expect(result.totals.unresolvedProceeds).toBe("900000");
    const review = result.limitations.find((row) => row.kind === "review");
    expect(review?.eventIds).toEqual(["sell-orphan"]);
    expect(review?.message).toBe("취득 원가를 확인할 수 없는 처분은 합계에서 제외하고 unresolvedProceeds로 보고했습니다.");
    const judgment = result.judgments.find((row) => row.eventId === "sell-orphan");
    expect(judgment?.realizedPnl).toBe("900000");
    expect(judgment?.pnlReview).toBe("disposal_exceeds_holdings");
    expect(judgment?.costBasis).toBe("0");
  });

  // E6 — breakdown.cost was hard-coded "0" before; it now carries the recognized cost.
  it("puts the recognized cost basis in the disposal breakdown", () => {
    const history = [
      evt("buy-2024", "IN", "1", "1000000", "2024-06-01T00:00:00.000Z"),
      evt("sell-2025", "OUT", "1", "1500000", "2025-03-01T00:00:00.000Z"),
    ];
    const judgment = estimate(history, 2025).judgments.find((row) => row.eventId === "sell-2025");
    expect(judgment?.breakdown).toEqual({ proceeds: "1500000", cost: "1000000", fee: "0", feeFiat: null });
    expect(judgment?.costBasis).toBe("1000000");
    expect(judgment?.realizedPnl).toBe("500000");
    expect(judgment?.pnlReview).toBeNull();
    // amount / amountKind keep their existing meaning.
    expect(judgment?.amount).toBe("1500000");
    expect(judgment?.amountKind).toBe("gain");
  });

  // E7 — an internal transfer moves value without disposing of it: never a taxable line.
  it("excludes an internal-transfer leg as non-taxable", () => {
    const history = [
      evt("bridge-out", "OUT", "1", "3000000", "2025-04-01T00:00:00.000Z", {
        asset_type: "NATIVE",
        asset_contract: null,
        symbol: "ETH",
        classification: "INTERNAL_TRANSFER",
      }),
    ];
    const result = estimate(history, 2025);
    expect(result.totals.taxableGains).toBe("0");
    expect(result.totals.unresolvedProceeds).toBe("0");
    const nonTaxable = result.limitations.find((row) => row.kind === "non_taxable");
    expect(nonTaxable?.eventIds).toEqual(["bridge-out"]);
    expect(nonTaxable?.message).toBe("스팸·미분류·내부 이체 이벤트는 과세 대상이 아니므로 제외했습니다.");
    expect(result.excludedEventIds).toEqual(["bridge-out"]);
    expect(result.judgments).toEqual([]);
  });

  // The KR ruleset stays undetermined regardless of the new totals.
  it("keeps status, provenance and openQuestions unchanged for KR", () => {
    const history = [
      evt("buy-2024", "IN", "1", "1000000", "2024-06-01T00:00:00.000Z"),
      evt("sell-2025", "OUT", "1", "1500000", "2025-03-01T00:00:00.000Z"),
    ];
    const result = estimate(history, 2025);
    expect(result.status).toBe("UNDETERMINED");
    expect(result.provenance).toBe("mock");
    expect(result.country).toBe("KR");
    expect(result.currency).toBe("KRW");
    expect(result.method).toBe("이동평균법");
    expect(result.period).toEqual({ from: "2025-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" });
    expect(result.openQuestions).toEqual([
      {
        topic: "CAPITAL_GAINS",
        status: "UNDETERMINED",
        reason: "시행 세부 규정이 확정되지 않아 숫자를 확정할 수 없습니다.",
        affectedEventIds: ["sell-2025"],
      },
    ]);
    expect(result.lines[0]).toEqual({ key: "taxableGains", label: "과세 대상 손익", amount: "500000" });
    expect(result.isEstimate).toBe(true);
  });

  it("applies the non-zero country rate to the realized total", () => {
    const history = [
      evt("buy-2024", "IN", "1", "1000000", "2024-06-01T00:00:00.000Z"),
      evt("sell-2025", "OUT", "1", "1500000", "2025-03-01T00:00:00.000Z"),
    ];
    const result = estimate(history, 2025, "US");
    expect(result.totals.taxableGains).toBe("500000");
    expect(result.totals.estimatedCharge).toBe("120000");
    expect(result.totals.effectiveRatePercent).toBe("24");
  });

  it("rejects an unsupported country", () => {
    expect(() => estimate([], 2025, "ZZ")).toThrow("Unsupported country: ZZ");
  });
});
