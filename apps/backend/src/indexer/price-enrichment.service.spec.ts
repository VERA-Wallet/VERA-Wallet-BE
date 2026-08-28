import { describe, expect, it } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { PriceEnrichmentService, marketVerdict } from "./price-enrichment.service";
import type { PriceOracle, TokenMarket } from "./price-oracle";

const tx = (payload: Record<string, unknown>): IndexedTransaction => ({
  source: "alchemy",
  txHash: "0x",
  chain: "1",
  eventType: "transfer_in",
  occurredAt: new Date("2025-01-01T00:00:00.000Z"),
  payload: { chain_id: 1, asset_type: "ERC20", direction: "IN", classification: "RECEIVE", asset_contract: "0xToken", ...payload },
});

const oracleOf = (result: TokenMarket | null): PriceOracle => ({ lookup: async () => result });

describe("marketVerdict", () => {
  it("classifies snapshots", () => {
    expect(marketVerdict({ priceUsd: null, liquidityUsd: 0, pairCount: 0 })).toBe("no_market");
    expect(marketVerdict({ priceUsd: null, liquidityUsd: 500, pairCount: 1 })).toBe("illiquid");
    expect(marketVerdict({ priceUsd: "1.0", liquidityUsd: 9000, pairCount: 2 })).toBe("priced");
  });
});

describe("PriceEnrichmentService.enrich", () => {
  it("retags a no-market inbound ERC20 RECEIVE as SPAM and records market fields", async () => {
    const t = tx({});
    await new PriceEnrichmentService(oracleOf({ priceUsd: null, liquidityUsd: 0, pairCount: 0 })).enrich([t]);
    expect(t.payload.classification).toBe("SPAM");
    expect(t.payload.confidence).toBe(0);
    expect(t.payload.market_liquidity_usd).toBe(0);
  });

  it("keeps a priced ERC20 RECEIVE and writes the informational price (not the tax basis)", async () => {
    const t = tx({ price_status: "UNKNOWN", fiat_value: null });
    await new PriceEnrichmentService(oracleOf({ priceUsd: "1.00", liquidityUsd: 119145, pairCount: 1 })).enrich([t]);
    expect(t.payload.classification).toBe("RECEIVE");
    expect(t.payload.market_price_usd).toBe("1.00");
    expect(t.payload.market_liquidity_usd).toBe(119145);
    // tax basis is left untouched
    expect(t.payload.price_status).toBe("UNKNOWN");
    expect(t.payload.fiat_value).toBeNull();
  });

  it("never downgrades on an UNKNOWN (null) lookup — an outage cannot create spam", async () => {
    const t = tx({});
    await new PriceEnrichmentService(oracleOf(null)).enrich([t]);
    expect(t.payload.classification).toBe("RECEIVE");
    expect(t.payload.market_price_usd).toBeUndefined();
  });

  it("never dust-gates a grouped swap acquisition (IN RECEIVE with group_id) even with no market", async () => {
    const t = tx({ group_id: "1:0xabc" });
    await new PriceEnrichmentService(oracleOf({ priceUsd: null, liquidityUsd: 0, pairCount: 0 })).enrich([t]);
    // A swap's received side is not unsolicited dust -> keep RECEIVE (retag would drop the cost basis).
    expect(t.payload.classification).toBe("RECEIVE");
    expect(t.payload.confidence).not.toBe(0);
    // market fields still recorded for visibility
    expect(t.payload.market_liquidity_usd).toBe(0);
  });

  it("does not apply the dust gate to a SEND (outbound) even with no market", async () => {
    const t = tx({ direction: "OUT", classification: "SEND" });
    await new PriceEnrichmentService(oracleOf({ priceUsd: null, liquidityUsd: 0, pairCount: 0 })).enrich([t]);
    expect(t.payload.classification).toBe("SEND");
    // market fields are still recorded for visibility
    expect(t.payload.market_liquidity_usd).toBe(0);
  });

  it("skips native and already-SPAM rows, and dedupes lookups per contract", async () => {
    let calls = 0;
    const oracle: PriceOracle = { lookup: async () => { calls += 1; return { priceUsd: null, liquidityUsd: 0, pairCount: 0 }; } };
    const rows = [
      tx({ asset_type: "NATIVE", asset_contract: null }),
      tx({ classification: "SPAM" }),
      tx({ asset_contract: "0xDupe" }),
      tx({ asset_contract: "0xDUPE" }), // same contract, different case -> one lookup
    ];
    await new PriceEnrichmentService(oracle).enrich(rows);
    expect(calls).toBe(1);
    expect(rows[2].payload.classification).toBe("SPAM");
    expect(rows[3].payload.classification).toBe("SPAM");
  });
});
