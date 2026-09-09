import Decimal from "decimal.js";
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
  // Decimal, not string concatenation: fractional quantities (0.99 ETH across a bridge) are
  // meaningless as `${tokens}` + 18 zeros.
  const raw = new Decimal(tokens).mul(Decimal.pow(10, 18)).toFixed();
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
    // PR-3: an INTERNAL_TRANSFER with no bridge_group_id is a manual, unlinkable transfer and
    // gets its own reason so callers can tell it from a linked bridge leg.
    expect(results.get("event-03")!.excludeReason).toBe("internal_transfer_unlinked");
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

// --- PR-3: bridge cost move -------------------------------------------------------

const ETH_L1 = { asset_type: "NATIVE", asset_contract: null, chain_id: 1, symbol: "ETH" };
const ETH_L2 = { asset_type: "NATIVE", asset_contract: null, chain_id: 8453, symbol: "ETH" };
const GROUP = "bridge:1:0xabc";
const leg = (chain: Record<string, unknown>) => ({ ...chain, classification: "INTERNAL_TRANSFER", bridge_group_id: GROUP });

describe("computeCostBasis — bridge cost move", () => {
  // B1. 1 ETH acquired on L1 crosses to L2 and is sold there. The cost has to arrive with it,
  // otherwise the L2 sale looks like 3,200,000 of pure profit against a zero basis.
  function bridged(destinationSale: string, sold = "0.99") {
    return computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", leg(ETH_L2), "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", sold, destinationSale, ETH_L2, "2025-01-03T00:00:00.000Z"),
    ]);
  }

  it("B1 moves the cost to the destination chain so the sale realizes only the real gain", () => {
    const sale = bridged("3200000").get("event-04")!;
    expect(sale.costBasis).toBe("3000000");
    expect(sale.proceeds).toBe("3200000");
    expect(sale.realizedPnl).toBe("200000");
    expect(sale.review).toBeUndefined();
  });

  it("B2 capitalizes the bridge fee: 0.99 ETH carries the full 3,000,000 of cost", () => {
    // The destination cell holds exactly 0.99 at an average of 3,000,000 / 0.99, so disposing
    // all of it recognizes the whole original cost and nothing is flagged...
    const exact = bridged("3200000").get("event-04")!;
    expect(exact.costBasis).toBe("3000000");
    expect(exact.review).toBeUndefined();
    // ...while disposing more than arrived exceeds the cell and is flagged.
    const over = bridged("3200000", "0.995").get("event-04")!;
    expect(over.costBasis).toBe("3000000");
    expect(over.review).toBe("disposal_exceeds_holdings");
  });

  it("B3 moves only the bridged share and conserves total cost (AC3-5)", () => {
    const results = computeCostBasis([
      evt("01", "IN", "2", "6000000", ETH_L1, "2025-01-01T00:00:00.000Z"), // avg 3,000,000
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "1", "3000000", leg(ETH_L2), "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "1", "3500000", ETH_L1, "2025-01-03T00:00:00.000Z"), // the source remainder
    ]);
    const moved = results.get("event-03")!;
    const remainder = results.get("event-04")!;
    expect(moved.costBasis).toBe("3000000"); // cost that left the source
    expect(remainder.costBasis).toBe("3000000"); // source keeps qty 1 @ 3,000,000
    expect(remainder.realizedPnl).toBe("500000");
    // AC3-5: nothing was created or destroyed by the move.
    expect(new Decimal(moved.costBasis).plus(remainder.costBasis).toFixed()).toBe("6000000");
  });

  it("B4 makes neither bridge leg a taxable line", () => {
    const results = bridged("3200000");
    const out = results.get("event-02")!;
    const inLeg = results.get("event-03")!;
    for (const legResult of [out, inLeg]) {
      expect(legResult.excluded).toBe(true);
      expect(legResult.excludeReason).toBe("classification_INTERNAL_TRANSFER");
      expect(legResult.proceeds).toBeNull();
      expect(legResult.realizedPnl).toBeNull();
      expect(legResult.pnlRatio).toBeNull();
    }
    expect(out.bridgeMove).toBe("out");
    expect(inLeg.bridgeMove).toBe("in");
    expect(out.costBasis).toBe("0");
    expect(inLeg.costBasis).toBe("3000000");
  });

  it("B5 leaves an incomplete pair alone and flags the orphaned OUT (AC3-3)", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"), // no IN leg in the input
      evt("03", "OUT", "1", "3200000", ETH_L1, "2025-01-03T00:00:00.000Z"),
    ]);
    const orphan = results.get("event-02")!;
    expect(orphan.excluded).toBe(true);
    expect(orphan.excludeReason).toBe("classification_INTERNAL_TRANSFER");
    expect(orphan.review).toBe("bridge_move_unmatched");
    expect(orphan.bridgeMove).toBeUndefined();
    // Source holdings untouched: the later sale still sees 1 ETH @ 3,000,000.
    const sale = results.get("event-03")!;
    expect(sale.costBasis).toBe("3000000");
    expect(sale.realizedPnl).toBe("200000");
    expect(sale.review).toBeUndefined();
  });

  it("B6 never moves cost for a manual INTERNAL_TRANSFER with no bridge group (AC3-4)", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", { ...ETH_L1, classification: "INTERNAL_TRANSFER" }, "2025-01-02T00:00:00.000Z"),
      evt("03", "OUT", "1", "3200000", ETH_L1, "2025-01-03T00:00:00.000Z"),
    ]);
    const manual = results.get("event-02")!;
    expect(manual.excluded).toBe(true);
    expect(manual.excludeReason).toBe("internal_transfer_unlinked");
    expect(manual.review).toBeUndefined();
    expect(manual.bridgeMove).toBeUndefined();
    expect(results.get("event-03")!.costBasis).toBe("3000000");
  });

  // B11 / B12. A move is all-or-nothing. A short source cannot say what the cost was, and a
  // partial escrow would hand the destination cheap basis that reads as profit later with no
  // flag on it — the exact shape ADR-000 keeps out of the totals. Refusing the move pushes
  // disposal_exceeds_holdings onto the destination sale, where the gate can see it.
  it("B11 refuses the move when the source never acquired the asset", () => {
    const results = computeCostBasis([
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", leg(ETH_L2), "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "0.99", "3200000", ETH_L2, "2025-01-03T00:00:00.000Z"),
    ]);
    const out = results.get("event-02")!;
    const inLeg = results.get("event-03")!;
    expect(out.review).toBe("disposal_exceeds_holdings");
    expect(out.bridgeMove).toBeUndefined();
    expect(inLeg.excluded).toBe(true);
    expect(inLeg.bridgeMove).toBeUndefined();
    expect(inLeg.costBasis).toBe("0"); // no zero-cost holdings created on the destination
    const sale = results.get("event-04")!;
    expect(sale.costBasis).toBe("0");
    expect(sale.realizedPnl).toBe("3200000");
    expect(sale.review).toBe("disposal_exceeds_holdings"); // decision 0 keeps this out of the totals
  });

  it("B12 refuses the move when the source held less than it bridged", () => {
    const results = computeCostBasis([
      evt("01", "IN", "0.5", "1500000", ETH_L1, "2025-01-01T00:00:00.000Z"), // only half of it
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", leg(ETH_L2), "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "0.99", "3200000", ETH_L2, "2025-01-03T00:00:00.000Z"),
      evt("05", "OUT", "0.1", "300000", ETH_L1, "2025-01-04T00:00:00.000Z"),
    ]);
    expect(results.get("event-02")!.review).toBe("disposal_exceeds_holdings");
    expect(results.get("event-02")!.bridgeMove).toBeUndefined();
    expect(results.get("event-03")!.bridgeMove).toBeUndefined();
    expect(results.get("event-03")!.costBasis).toBe("0");
    const destinationSale = results.get("event-04")!;
    expect(destinationSale.costBasis).toBe("0");
    expect(destinationSale.review).toBe("disposal_exceeds_holdings");
    // The source cell is still drained by the transfer, so it has nothing left to recognize.
    const sourceSale = results.get("event-05")!;
    expect(sourceSale.costBasis).toBe("0");
    expect(sourceSale.review).toBe("disposal_exceeds_holdings");
  });

  it("moves cost across mismatched asset keys (native ETH -> canonical WETH) (AC3-6)", () => {
    const WETH_L2 = { chain_id: 8453, asset_type: "ERC20", asset_contract: "0x4200000000000000000000000000000000000006" };
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", leg(WETH_L2), "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "0.99", "3200000", WETH_L2, "2025-01-03T00:00:00.000Z"),
    ]);
    expect(results.get("event-04")!.costBasis).toBe("3000000");
    expect(results.get("event-04")!.realizedPnl).toBe("200000");
  });

  it("moves cost even when the bridge legs have no resolved price", () => {
    // A transfer is defined by quantity, so an unpriced leg must not block the move.
    const unpriced = { price_status: "UNKNOWN", fiat_value: null };
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", { ...leg(ETH_L1), ...unpriced }, "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", { ...leg(ETH_L2), ...unpriced }, "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "0.99", "3200000", ETH_L2, "2025-01-03T00:00:00.000Z"),
    ]);
    expect(results.get("event-04")!.costBasis).toBe("3000000");
    expect(results.get("event-03")!.bridgeMove).toBe("in");
  });

  it("keeps both legs in the result when a duplicate event id makes the pair unidentifiable", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("02", "IN", "0.99", "2970000", leg(ETH_L2), "2025-01-02T00:05:00.000Z"), // same id
    ]);
    expect(results.has("event-02")).toBe(true); // neither leg is dropped from the fold
  });

  it("treats a bridge group with an unreadable quantity as incomplete", () => {
    const results = computeCostBasis([
      evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
      evt("02", "OUT", "1", "3000000", leg(ETH_L1), "2025-01-02T00:00:00.000Z"),
      evt("03", "IN", "0.99", "2970000", { ...leg(ETH_L2), raw_amount: "NaN" }, "2025-01-02T00:05:00.000Z"),
      evt("04", "OUT", "0.99", "3200000", ETH_L2, "2025-01-03T00:00:00.000Z"),
    ]);
    expect(results.get("event-02")!.review).toBe("bridge_move_unmatched");
    expect(results.get("event-02")!.bridgeMove).toBeUndefined();
    expect(results.get("event-04")!.costBasis).toBe("0"); // nothing arrived, nothing to recognize
  });

  // B9 / B10 pin the post-sort reorder pass (AC3-8). The pair's IN carries log_index 0 and its
  // OUT log_index 5 at the same timestamp, so the default sort puts the IN first and the pass
  // has to move it back behind the OUT.
  const T1 = "2025-01-02T00:00:00.000Z";
  const pairAtT1 = [
    evt("0A", "IN", "0.99", "2970000", { ...leg(ETH_L2), log_index: 0 }, T1),
    evt("0B", "OUT", "1", "3000000", { ...leg(ETH_L1), log_index: 5 }, T1),
  ];
  const bookends = [
    evt("01", "IN", "1", "3000000", ETH_L1, "2025-01-01T00:00:00.000Z"),
    evt("04", "OUT", "0.99", "3200000", ETH_L2, "2025-01-03T00:00:00.000Z"),
  ];

  it("B9 reorders the pair without disturbing an unrelated same-timestamp event", () => {
    // C sits between the two legs (log_index 2) but trades a different asset on the source chain.
    const xyzAcquire = evt("00", "IN", "1", "800000", { asset_contract: "0xXYZ" }, "2024-12-31T00:00:00.000Z");
    const c = evt("0C", "OUT", "0.5", "500000", { asset_contract: "0xXYZ", log_index: 2 }, T1);

    const withBridge = computeCostBasis([...bookends, ...pairAtT1, xyzAcquire, c]);
    expect(withBridge.get("event-04")!.costBasis).toBe("3000000");
    expect(withBridge.get("event-04")!.realizedPnl).toBe("200000");
    expect(withBridge.get("event-04")!.review).toBeUndefined();

    // The pass must not perturb anything outside the pair: C is byte-identical to a control run
    // with the bridge events removed. Deleting the reorder pass makes the assertions above fail.
    const control = computeCostBasis([...bookends, xyzAcquire, c]);
    expect(withBridge.get("event-0C")).toEqual(control.get("event-0C"));
    expect(withBridge.get("event-0C")!.realizedPnl).toBe("100000");
  });

  it("B10 flags a destination disposal that lands between the reordered legs", () => {
    // Intended, not accidental: at an identical timestamp there is no evidence of the true
    // order, so D is evaluated before the credit arrives and gets a conservative flag rather
    // than a fabricated basis. Decision 0 keeps it out of the totals.
    const d = evt("0D", "OUT", "0.99", "3100000", { ...ETH_L2, log_index: 1 }, T1);
    const results = computeCostBasis([...bookends, ...pairAtT1, d]);
    const flagged = results.get("event-0D")!;
    expect(flagged.costBasis).toBe("0");
    expect(flagged.proceeds).toBe("3100000");
    expect(flagged.review).toBe("disposal_exceeds_holdings");
    // The move itself still lands: without the reorder pass the IN would hit an empty escrow,
    // the credit would be skipped and this sale would fall back to a zero basis.
    expect(results.get("event-04")!.costBasis).toBe("3000000");
    expect(results.get("event-0B")!.review).toBeUndefined();
  });
});

// --- PR-2: gas attribution --------------------------------------------------------

// 1 ETH = 4,000,000 KRW on every day used below, so 0.0025 ETH of gas is 10,000 KRW.
const NATIVE_PRICES = new Map(
  ["2025-01-01", "2025-01-02", "2025-01-03"].map((day) => [`1:${day}`, "4000000"] as const),
);
const GAS = { nativePrices: NATIVE_PRICES };
const DAY1 = "2025-01-01T12:00:00.000Z";
// An event on a chain with no close in the map: gas is known, its KRW value is not.
const UNPRICED_CHAIN = { chain_id: 999 };

describe("computeCostBasis — gas", () => {
  it("G1 capitalizes acquisition gas into the cost basis", () => {
    const results = computeCostBasis([evt("01", "IN", "1", "1000000", { gas_fee_native: "0.0025" }, DAY1)], GAS);
    const buy = results.get("event-01")!;
    expect(buy.costBasis).toBe("1010000");
    expect(buy.gasFiat).toBe("10000");
    expect(buy.review).toBeUndefined();
  });

  it("G2 deducts disposal gas from proceeds and sells against the capitalized basis", () => {
    const results = computeCostBasis(
      [
        evt("01", "IN", "1", "1000000", { gas_fee_native: "0.0025" }, DAY1),
        evt("02", "OUT", "1", "1500000", { gas_fee_native: "0.00125" }, "2025-01-02T12:00:00.000Z"),
      ],
      GAS,
    );
    const sell = results.get("event-02")!;
    expect(sell.proceeds).toBe("1495000");
    expect(sell.costBasis).toBe("1010000");
    expect(sell.realizedPnl).toBe("485000");
    expect(sell.gasFiat).toBe("5000");
  });

  it("G3 charges a swap's gas once, to the acquired leg", () => {
    const swap = { group_id: "1:0xabc", gas_fee_native: "0.00125" };
    const results = computeCostBasis(
      [
        evt("01", "OUT", "1", "1000000", { ...swap, classification: "EXCHANGE", log_index: 0 }, DAY1),
        evt("02", "IN", "1", "1000000", { ...swap, classification: "RECEIVE", asset_contract: "0xBBB", log_index: 1 }, DAY1),
      ],
      GAS,
    );
    const out = results.get("event-01")!;
    const inLeg = results.get("event-02")!;
    expect(out.proceeds).toBe("1000000"); // untouched: the fee lives on the other leg
    expect(out.gasFiat).toBeUndefined();
    expect(inLeg.costBasis).toBe("1005000");
    expect(inLeg.gasFiat).toBe("5000");
  });

  it("G4 leaves the numbers alone and flags review when the native close is unknown", () => {
    const results = computeCostBasis(
      [evt("01", "IN", "1", "1000000", { ...UNPRICED_CHAIN, gas_fee_native: "0.001" }, DAY1)],
      GAS,
    );
    const buy = results.get("event-01")!;
    expect(buy.gasFiat).toBeNull();
    expect(buy.costBasis).toBe("1000000");
    expect(buy.review).toBe("gas_unpriced");
  });

  it("G5 prefers disposal_exceeds_holdings over gas_unpriced", () => {
    const results = computeCostBasis(
      [evt("01", "OUT", "1", "1500000", { ...UNPRICED_CHAIN, gas_fee_native: "0.001" }, DAY1)],
      GAS,
    );
    const sell = results.get("event-01")!;
    expect(sell.review).toBe("disposal_exceeds_holdings");
    expect(sell.gasFiat).toBeNull();
    expect(sell.proceeds).toBe("1500000");
  });

  it("G6 ignores gas entirely when no price map is supplied", () => {
    const events = [
      evt("01", "IN", "1", "1000000", { gas_fee_native: "0.0025" }, DAY1),
      evt("02", "OUT", "1", "1500000", { gas_fee_native: "0.00125" }, "2025-01-02T12:00:00.000Z"),
    ];
    const sell = computeCostBasis(events).get("event-02")!;
    expect(sell.costBasis).toBe("1000000");
    expect(sell.proceeds).toBe("1500000");
    expect(sell.realizedPnl).toBe("500000");
    expect(sell.gasFiat).toBeUndefined();
    expect(sell.review).toBeUndefined();
  });

  it("G7 treats a zero fee as fully known", () => {
    const results = computeCostBasis([evt("01", "IN", "1", "1000000", { gas_fee_native: "0" }, DAY1)], GAS);
    const buy = results.get("event-01")!;
    expect(buy.gasFiat).toBe("0");
    expect(buy.costBasis).toBe("1000000");
    expect(buy.review).toBeUndefined();
  });

  it("G8 falls back to the disposal leg when the swap's acquisition is excluded", () => {
    const swap = { group_id: "1:0xabc", gas_fee_native: "0.00125" };
    const results = computeCostBasis(
      [
        evt("01", "OUT", "1", "1000000", { ...swap, classification: "EXCHANGE", log_index: 0 }, DAY1),
        evt("02", "IN", "1", null, { ...swap, classification: "RECEIVE", asset_contract: "0xBBB", log_index: 1 }, DAY1),
      ],
      GAS,
    );
    const out = results.get("event-01")!;
    expect(out.proceeds).toBe("995000");
    expect(out.gasFiat).toBe("5000");
    expect(results.get("event-02")!.excluded).toBe(true);
  });

  it("G9 charges the gas at most once per group", () => {
    const swap = { group_id: "1:0xabc", gas_fee_native: "0.00125", classification: "RECEIVE" };
    const results = computeCostBasis(
      [
        evt("01", "OUT", "1", "2000000", { group_id: "1:0xabc", gas_fee_native: "0.00125", classification: "EXCHANGE", log_index: 0 }, DAY1),
        evt("02", "IN", "1", "1000000", { ...swap, asset_contract: "0xBBB", log_index: 1 }, DAY1),
        evt("03", "IN", "1", "1000000", { ...swap, asset_contract: "0xCCC", log_index: 2 }, DAY1),
      ],
      GAS,
    );
    expect(results.get("event-02")!.costBasis).toBe("1005000");
    expect(results.get("event-03")!.costBasis).toBe("1000000");
    expect(results.get("event-03")!.gasFiat).toBeUndefined();
  });

  it("G10 uses the chosen leg's own fee, not the group's largest", () => {
    const results = computeCostBasis(
      [
        evt("01", "OUT", "1", "1000000", { group_id: "1:0xabc", classification: "EXCHANGE", gas_fee_native: "0.0025", log_index: 0 }, DAY1),
        evt("02", "IN", "1", "1000000", { group_id: "1:0xabc", classification: "RECEIVE", gas_fee_native: "0.00125", asset_contract: "0xBBB", log_index: 1 }, DAY1),
      ],
      GAS,
    );
    expect(results.get("event-02")!.costBasis).toBe("1005000"); // 5,000, not the OUT leg's 10,000
    expect(results.get("event-01")!.gasFiat).toBeUndefined();
  });

  it("never charges gas to a bridge leg", () => {
    const results = computeCostBasis(
      [
        evt("01", "IN", "1", "3000000", { ...ETH_L1, gas_fee_native: "0.0025" }, "2025-01-01T00:00:00.000Z"),
        evt("02", "OUT", "1", "3000000", { ...leg(ETH_L1), gas_fee_native: "0.0025" }, "2025-01-02T00:00:00.000Z"),
        evt("03", "IN", "0.99", "2970000", { ...leg(ETH_L2), gas_fee_native: "0.0025" }, "2025-01-02T00:05:00.000Z"),
      ],
      GAS,
    );
    expect(results.get("event-02")!.gasFiat).toBeUndefined();
    expect(results.get("event-03")!.gasFiat).toBeUndefined();
    expect(results.get("event-03")!.costBasis).toBe("3010000"); // exactly what the acquisition capitalized
  });
});
