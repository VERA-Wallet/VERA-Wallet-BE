import { describe, expect, it } from "vitest";
import { computeCostBasis } from "./cost-basis";
import type { TaxableTransaction } from "./types";

// Build an event with sane ERC20 defaults; override per case. raw_amount is in base
// units (18 decimals) so `tokens` is the human quantity.
function evt(
  id: string,
  direction: "IN" | "OUT",
  tokens: string,
  fiat: string | null,
  overrides: Record<string, unknown> = {},
  occurredAt = `2025-01-${id.padStart(2, "0")}T12:00:00.000Z`,
): TaxableTransaction {
  const raw = fiat === null && overrides.raw_amount === undefined ? "0" : `${tokens}${"0".repeat(18)}`;
  return {
    id: `event-${id}`,
    eventType: direction === "IN" ? "transfer_in" : "transfer_out",
    occurredAt,
    payload: {
      id: `event-${id}`,
      direction,
      asset_type: "ERC20",
      asset_contract: "0xAAA",
      token_id: null,
      chain_id: 1,
      decimals: 18,
      raw_amount: raw,
      classification: direction === "IN" ? "RECEIVE" : "SEND",
      price_status: fiat === null ? "UNKNOWN" : "RESOLVED",
      fiat_value: fiat,
      ...overrides,
    },
  };
}

describe("computeCostBasis", () => {
  it("computes realized P/L and ratio for a single acquire + dispose", () => {
    // Buy 1 token @ 1,000,000 KRW; sell 1 token @ 1,500,000 KRW => +500,000 (+50%).
    const results = computeCostBasis([
      evt("01", "IN", "1", "1000000"),
      evt("02", "OUT", "1", "1500000"),
    ]);
    const sell = results.get("event-02")!;
    expect(sell.costBasis).toBe("1000000");
    expect(sell.proceeds).toBe("1500000");
    expect(sell.realizedPnl).toBe("500000");
    expect(sell.pnlRatio).toBe("0.5");
    expect(sell.excluded).toBe(false);
    const buy = results.get("event-01")!;
    expect(buy.costBasis).toBe("1000000");
    expect(buy.realizedPnl).toBeNull();
  });

  it("re-averages cost across multiple acquisitions", () => {
    // Buy 1 @ 1,000,000 then 1 @ 2,000,000 => avg 1,500,000. Sell 1 @ 1,500,000 => 0 P/L.
    const results = computeCostBasis([
      evt("01", "IN", "1", "1000000"),
      evt("02", "IN", "1", "2000000"),
      evt("03", "OUT", "1", "1500000"),
    ]);
    const sell = results.get("event-03")!;
    expect(sell.costBasis).toBe("1500000");
    expect(sell.realizedPnl).toBe("0");
    expect(sell.pnlRatio).toBe("0");
  });

  it("excludes events with a null fiat_value / UNKNOWN price and never mutates holdings", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", null), // no price -> excluded, does not seed avg cost
      evt("02", "OUT", "1", "1500000"),
    ]);
    const buy = results.get("event-01")!;
    expect(buy.excluded).toBe(true);
    expect(buy.excludeReason).toBe("price_unknown");
    // The disposal sees zero holdings (the excluded IN never seeded), so cost is 0.
    const sell = results.get("event-02")!;
    expect(sell.costBasis).toBe("0");
    expect(sell.proceeds).toBe("1500000");
    expect(sell.realizedPnl).toBe("1500000");
    expect(sell.pnlRatio).toBeNull();
    expect(sell.review).toBe("disposal_exceeds_holdings");
  });

  it("caps recognized cost at holdings and flags over-disposal", () => {
    // Buy 1 @ 1,000,000; sell 2 @ 3,000,000. Only 1 has basis (1,000,000); excess is 0-cost.
    const results = computeCostBasis([
      evt("01", "IN", "1", "1000000"),
      evt("02", "OUT", "2", "3000000"),
    ]);
    const sell = results.get("event-02")!;
    expect(sell.costBasis).toBe("1000000");
    expect(sell.realizedPnl).toBe("2000000");
    expect(sell.review).toBe("disposal_exceeds_holdings");
  });

  it("excludes SPAM / UNKNOWN / INTERNAL_TRANSFER classifications", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "1000000", { classification: "SPAM" }),
      evt("02", "OUT", "1", "1000000", { classification: "UNKNOWN" }),
      evt("03", "OUT", "1", "1000000", { classification: "INTERNAL_TRANSFER" }),
    ]);
    expect(results.get("event-01")!.excludeReason).toBe("classification_SPAM");
    expect(results.get("event-02")!.excludeReason).toBe("classification_UNKNOWN");
    expect(results.get("event-03")!.excludeReason).toBe("classification_INTERNAL_TRANSFER");
    expect([...results.values()].every((r) => r.excluded)).toBe(true);
  });

  it("reports losses with a negative P/L and negative ratio", () => {
    // Buy 1 @ 2,000,000; sell 1 @ 1,500,000 => -500,000 (-25%).
    const results = computeCostBasis([
      evt("01", "IN", "1", "2000000"),
      evt("02", "OUT", "1", "1500000"),
    ]);
    const sell = results.get("event-02")!;
    expect(sell.realizedPnl).toBe("-500000");
    expect(sell.pnlRatio).toBe("-0.25");
  });

  it("returns a null P/L ratio when the recognized cost basis is zero", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "0"),
      evt("02", "OUT", "1", "1500000"),
    ]);
    const sell = results.get("event-02")!;
    expect(sell.costBasis).toBe("0");
    expect(sell.realizedPnl).toBe("1500000");
    expect(sell.pnlRatio).toBeNull();
  });

  it("is independent of input array order (folds by occurredAt)", () => {
    const buy = evt("01", "IN", "1", "1000000", {}, "2025-01-01T12:00:00.000Z");
    const sell = evt("02", "OUT", "1", "1500000", {}, "2025-01-05T12:00:00.000Z");
    const forward = computeCostBasis([buy, sell]).get("event-02")!;
    const reversed = computeCostBasis([sell, buy]).get("event-02")!;
    expect(reversed).toEqual(forward);
    expect(forward.realizedPnl).toBe("500000");
  });

  it("excludes NaN/Infinity fiat and quantity instead of poisoning the average", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "Infinity"), // bad fiat -> excluded, no avg seed
      evt("02", "IN", "1", "1000000", { raw_amount: "NaN" }), // bad qty -> excluded
      evt("03", "OUT", "1", "1500000"),
    ]);
    expect(results.get("event-01")!.excluded).toBe(true);
    expect(results.get("event-02")!.excluded).toBe(true);
    // The disposal sees zero valid holdings (both acquires excluded).
    const sell = results.get("event-03")!;
    expect(sell.costBasis).toBe("0");
    expect(sell.realizedPnl).toBe("1500000");
  });

  it("breaks same-timestamp ties by on-chain log_index", () => {
    // Same block/timestamp: buy (log_index 0) must fold before sell (log_index 1),
    // regardless of array order, so the sell has a real cost basis.
    const at = "2025-01-01T12:00:00.000Z";
    const buy = evt("01", "IN", "1", "1000000", { log_index: 0 }, at);
    const sell = evt("02", "OUT", "1", "1500000", { log_index: 1 }, at);
    const result = computeCostBasis([sell, buy]).get("event-02")!;
    expect(result.costBasis).toBe("1000000");
    expect(result.realizedPnl).toBe("500000");
  });

  it("keeps separate averages per asset key", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "1000000", { asset_contract: "0xAAA" }),
      evt("02", "IN", "1", "5000000", { asset_contract: "0xBBB" }),
      evt("03", "OUT", "1", "1200000", { asset_contract: "0xAAA" }),
    ]);
    const sell = results.get("event-03")!;
    expect(sell.costBasis).toBe("1000000");
    expect(sell.realizedPnl).toBe("200000");
  });
});
