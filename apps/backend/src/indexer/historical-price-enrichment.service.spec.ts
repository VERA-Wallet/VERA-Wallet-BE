import { describe, expect, it, vi } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import type { HistoricalPrice, HistoricalPriceOracle } from "./historical-price-oracle";
import { MockHistoricalPriceRepository } from "./historical-price.repository.adapters";

const tx = (payload: Record<string, unknown>): IndexedTransaction => ({
  source: "alchemy",
  txHash: "0x",
  chain: "1",
  eventType: "transfer_in",
  occurredAt: new Date("2025-01-03T12:00:00.000Z"),
  payload: {
    chain_id: 1,
    asset_type: "ERC20",
    asset_contract: "0xToken",
    direction: "IN",
    decimals: 18,
    raw_amount: `2${"0".repeat(18)}`, // 2 whole tokens
    block_timestamp: "2025-01-03T12:00:00.000Z",
    price_status: "UNKNOWN",
    fiat_value: null,
    ...payload,
  },
});

// Oracle stub that counts lookups and returns a fixed unit KRW close.
const countingOracle = (price: HistoricalPrice | null) => {
  let calls = 0;
  const oracle: HistoricalPriceOracle = {
    priceAt: async () => {
      calls += 1;
      return price;
    },
  };
  return { oracle, calls: () => calls };
};

describe("HistoricalPriceEnrichmentService.enrich", () => {
  it("fills fiat_value (unit close * quantity) and RESOLVED status for a null-basis ERC20", async () => {
    const t = tx({});
    const { oracle } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(t.payload.fiat_value).toBe("2000000"); // 1,000,000 * 2 tokens
    expect(t.payload.price_status).toBe("RESOLVED");
  });

  it("consults the oracle at most once per (asset, day) and caches the close", async () => {
    const rows = [tx({ raw_amount: `1${"0".repeat(18)}` }), tx({ raw_amount: `3${"0".repeat(18)}` })];
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const repo = new MockHistoricalPriceRepository();
    await new HistoricalPriceEnrichmentService(oracle, repo).enrich(rows);
    expect(calls()).toBe(1); // same asset+day -> one lookup for both rows
    expect(rows[0].payload.fiat_value).toBe("1000000");
    expect(rows[1].payload.fiat_value).toBe("3000000");
    expect(await repo.get(1, "0xtoken", "2025-01-03")).toBe("1000000"); // written back
  });

  it("does not touch the oracle when the price is already cached (cache-first)", async () => {
    const repo = new MockHistoricalPriceRepository();
    await repo.put({ chainId: 1, assetKey: "0xtoken", date: "2025-01-03", krw: "777" });
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ raw_amount: `1${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([t]);
    expect(calls()).toBe(0);
    expect(t.payload.fiat_value).toBe("777");
  });

  it("leaves the basis UNKNOWN on a null lookup and never coerces to 0", async () => {
    const t = tx({});
    const { oracle } = countingOracle(null);
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(t.payload.fiat_value).toBeNull();
    expect(t.payload.price_status).toBe("UNKNOWN");
  });

  it("never overwrites an already-priced row (mock path is untouched)", async () => {
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ price_status: "ESTIMATED", fiat_value: "42000.00" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(calls()).toBe(0);
    expect(t.payload.fiat_value).toBe("42000.00");
    expect(t.payload.price_status).toBe("ESTIMATED");
  });

  it("skips NFTs (no fungible price) and forces UNKNOWN", async () => {
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ asset_type: "ERC721", raw_amount: "1", decimals: 0, price_status: "RESOLVED" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(calls()).toBe(0);
    expect(t.payload.fiat_value).toBeNull();
    expect(t.payload.price_status).toBe("UNKNOWN"); // stale non-UNKNOWN status is normalized
  });

  it("forces price_status UNKNOWN for an unpriced row even if it arrived non-UNKNOWN", async () => {
    const { oracle } = countingOracle(null); // lookup fails
    const t = tx({ price_status: "RESOLVED", fiat_value: null });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(t.payload.price_status).toBe("UNKNOWN");
    expect(t.payload.fiat_value).toBeNull();
  });

  it("applies the canonical persisted close, not a losing concurrent lookup", async () => {
    // Models ON CONFLICT DO NOTHING: the first get misses, our put is dropped (a
    // concurrent winner already stored 900,000), and the post-put re-read returns the
    // winner. The service must apply 900,000, never its own losing 111,111 lookup.
    let firstGet = true;
    const winner = "900000";
    const raceRepo = {
      get: async () => {
        if (firstGet) { firstGet = false; return null; }
        return winner;
      },
      put: async () => undefined, // conflict loser: no-op
    };
    const { oracle } = countingOracle({ krw: "111111", status: "RESOLVED" });
    const t = tx({ raw_amount: `2${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, raceRepo).enrich([t]);
    expect(t.payload.fiat_value).toBe("1800000"); // 900,000 (winner) * 2
  });

  it("rejects a poisoned (non-positive) cached close instead of writing a bad basis", async () => {
    const repo = new MockHistoricalPriceRepository();
    await repo.put({ chainId: 1, assetKey: "0xtoken", date: "2025-01-03", krw: "0" });
    const { oracle } = countingOracle(null);
    const t = tx({ raw_amount: `1${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([t]);
    expect(t.payload.fiat_value).toBeNull();
    expect(t.payload.price_status).toBe("UNKNOWN");
  });

  it("rejects an impossible full timestamp instead of normalizing it to a wrong day", async () => {
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ block_timestamp: "2025-02-30T12:00:00.000Z" }); // Feb 30 does not exist
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(calls()).toBe(0); // never priced on the normalized March day
    expect(t.payload.fiat_value).toBeNull();
    expect(t.payload.price_status).toBe("UNKNOWN");
  });

  it("keys an offset timestamp by its UTC day, not the raw local date prefix", async () => {
    // 2025-01-03T00:30:00+09:00 is 2025-01-02T15:30:00Z -> UTC day is Jan 2.
    let seenDate = "";
    const oracle = {
      priceAt: async (_c: number, _ct: string | null, _a: string, date: string) => {
        seenDate = date;
        return { krw: "1000000", status: "RESOLVED" as const };
      },
    };
    const t = tx({ block_timestamp: "2025-01-03T00:30:00+09:00", raw_amount: `1${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(seenDate).toBe("2025-01-02"); // UTC day, not "2025-01-03"
    expect(t.payload.fiat_value).toBe("1000000");
  });

  it("rejects a valid-prefix timestamp with trailing garbage", async () => {
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ block_timestamp: "2025-01-03XYZ", raw_amount: `1${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(calls()).toBe(0);
    expect(t.payload.fiat_value).toBeNull();
    expect(t.payload.price_status).toBe("UNKNOWN");
  });

  it("does not cache a poisoned oracle close (stays retryable, not permanently UNKNOWN)", async () => {
    const repo = new MockHistoricalPriceRepository();
    const oracle = { priceAt: async () => ({ krw: "-5", status: "RESOLVED" as const }) };
    const t = tx({});
    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([t]);
    expect(t.payload.fiat_value).toBeNull();
    // The bad value was NOT written to the cache.
    expect(await repo.get(1, "0xtoken", "2025-01-03")).toBeNull();
  });

  it("coalesces concurrent enrich calls into one oracle lookup per key (single-flight)", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const oracle = {
      priceAt: async () => {
        calls += 1;
        await gate; // hold both callers in-flight simultaneously
        return { krw: "1000000", status: "RESOLVED" as const };
      },
    };
    const repo = new MockHistoricalPriceRepository();
    const service = new HistoricalPriceEnrichmentService(oracle, repo);
    const a = tx({ raw_amount: `1${"0".repeat(18)}` });
    const b = tx({ raw_amount: `2${"0".repeat(18)}` });
    const runA = service.enrich([a]);
    const runB = service.enrich([b]);
    release();
    await Promise.all([runA, runB]);
    expect(calls).toBe(1); // both concurrent calls shared one lookup
    expect(a.payload.fiat_value).toBe("1000000");
    expect(b.payload.fiat_value).toBe("2000000");
  });

  it("does not fail the batch when the oracle throws (best-effort)", async () => {
    const oracle: HistoricalPriceOracle = { priceAt: async () => { throw new Error("boom"); } };
    const t = tx({});
    await expect(new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t])).resolves.toBeUndefined();
    expect(t.payload.price_status).toBe("UNKNOWN");
  });
});

describe("HistoricalPriceEnrichmentService quota guards", () => {
  it("never prices SPAM rows — they are excluded from tax and would only spend provider quota", async () => {
    const spam = tx({ classification: "SPAM", price_status: "RESOLVED" });
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([spam]);
    expect(calls()).toBe(0);
    expect(spam.payload.fiat_value).toBeNull();
    expect(spam.payload.price_status).toBe("UNKNOWN");
  });

  it("remembers an UNLISTED asset and stops asking for other days of the same asset", async () => {
    let calls = 0;
    const oracle: HistoricalPriceOracle = { priceAt: async () => { calls += 1; return { status: "UNLISTED" }; } };
    const service = new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository());
    await service.enrich([tx({}), tx({ block_timestamp: "2025-01-04T12:00:00.000Z" })]);
    expect(calls).toBe(1); // second day of the same asset is answered from the negative memory
    // A later sync of the same asset is also answered without the provider.
    const later = tx({ block_timestamp: "2025-02-01T12:00:00.000Z" });
    await service.enrich([later]);
    expect(calls).toBe(1);
    expect(later.payload.price_status).toBe("UNKNOWN");
  });

  it("does not remember a transient null — the next sync asks again", async () => {
    let calls = 0;
    const oracle: HistoricalPriceOracle = { priceAt: async () => { calls += 1; return null; } };
    const service = new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository());
    await service.enrich([tx({})]);
    await service.enrich([tx({})]);
    expect(calls).toBe(2);
  });
});
