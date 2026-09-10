import { describe, expect, it, vi } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { MOCK_NATIVE_CLOSE_KRW, MockHistoricalPriceOracle, type HistoricalPrice, type HistoricalPriceOracle } from "./historical-price-oracle";
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
//
// Counts are split because enrich() now makes TWO kinds of lookup per row: the row's own
// basis (a contract, for an ERC20) and the chain's native close, warmed for the read-time
// gas valuation. A test about the row's basis asserts on `assetCalls`; a test about warming
// asserts on `nativeCalls`.
const countingOracle = (price: HistoricalPrice | null) => {
  let native = 0;
  let asset = 0;
  const oracle: HistoricalPriceOracle = {
    priceAt: async (_chainId, contract) => {
      if (contract === null) native += 1;
      else asset += 1;
      return price;
    },
  };
  return { oracle, calls: () => native + asset, nativeCalls: () => native, assetCalls: () => asset };
};

// Oracle stub recording every day it was asked to price, for tests about day derivation.
const dateRecordingOracle = () => {
  const days: string[] = [];
  const oracle: HistoricalPriceOracle = {
    priceAt: async (_chainId, _contract, _assetType, date) => {
      days.push(date);
      return { krw: "1000000", status: "RESOLVED" as const };
    },
  };
  return { oracle, days };
};

// Pre-seed the native close so a test can isolate the row's own basis lookup from warming.
const withNativeClose = async (repo: MockHistoricalPriceRepository, chainId = 1, date = "2025-01-03") => {
  await repo.put({ chainId, assetKey: "native", date, krw: "500" });
  return repo;
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
    const { oracle, assetCalls, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const repo = new MockHistoricalPriceRepository();
    await new HistoricalPriceEnrichmentService(oracle, repo).enrich(rows);
    expect(assetCalls()).toBe(1); // same asset+day -> one lookup for both rows
    expect(nativeCalls()).toBe(1); // and one warm of the chain's native close for that day
    expect(rows[0].payload.fiat_value).toBe("1000000");
    expect(rows[1].payload.fiat_value).toBe("3000000");
    expect(await repo.get(1, "0xtoken", "2025-01-03")).toBe("1000000"); // written back
  });

  it("does not touch the oracle when the price is already cached (cache-first)", async () => {
    const repo = await withNativeClose(new MockHistoricalPriceRepository());
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
    const { oracle, assetCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ price_status: "ESTIMATED", fiat_value: "42000.00" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(assetCalls()).toBe(0); // its basis is never re-looked-up (the native warm still runs)
    expect(t.payload.fiat_value).toBe("42000.00");
    expect(t.payload.price_status).toBe("ESTIMATED");
  });

  it("skips NFTs (no fungible price) and forces UNKNOWN", async () => {
    const { oracle, assetCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ asset_type: "ERC721", raw_amount: "1", decimals: 0, price_status: "RESOLVED" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(assetCalls()).toBe(0);
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
      // Key-aware: the native warm is served from cache so only the token key races.
      get: async (_chainId: number, assetKey: string) => {
        if (assetKey === "native") return "500";
        if (firstGet) { firstGet = false; return null; }
        return winner;
      },
      getMany: async () => new Map<string, string>(),
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

  it("never normalizes an impossible timestamp into a wrong day, and uses occurredAt instead", async () => {
    // Date.parse would turn Feb 30 into Mar 2. The row must never be priced on that day;
    // it falls back to occurredAt (Jan 3), which is what the read path uses too.
    const { oracle, days } = dateRecordingOracle();
    const t = tx({ block_timestamp: "2025-02-30T12:00:00.000Z" }); // Feb 30 does not exist
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(days).not.toContain("2025-03-02"); // the normalized day is never used
    expect(new Set(days)).toEqual(new Set(["2025-01-03"])); // occurredAt's UTC day
    expect(t.payload.fiat_value).toBe("2000000");
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

  it("rejects a valid-prefix timestamp with trailing garbage and falls back to occurredAt", async () => {
    const { oracle, days } = dateRecordingOracle();
    // occurredAt is a different day from the garbage string's prefix, so the assertion
    // shows the fallback is doing the work rather than the prefix accidentally matching.
    const t = tx({ block_timestamp: "2025-01-09XYZ", raw_amount: `1${"0".repeat(18)}` });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([t]);
    expect(days).not.toContain("2025-01-09"); // the unparseable string is never trusted
    expect(new Set(days)).toEqual(new Set(["2025-01-03"])); // occurredAt's UTC day
    expect(t.payload.fiat_value).toBe("1000000");
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
    const repo = await withNativeClose(new MockHistoricalPriceRepository());
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

// The read-time cost-basis fold values gas fees from (chain, day) -> native close, but the
// fold is a pure function and cannot fetch. Sync-time warming is what fills that cache, so
// it has to run for EVERY row the sync sees, including rows whose own basis we never price.
// The only row that cannot be warmed is one with no usable day.
describe("HistoricalPriceEnrichmentService native-close warming", () => {
  it("W1 warms the chain's native close once per (chain, day), reusing it for later rows", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const rows = [tx({}), tx({ txHash: "0x2" })]; // same chain, same day

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich(rows);

    expect(nativeCalls()).toBe(1); // the second row reuses the first row's answer
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000");
  });

  it("W2 warms from a SPAM-only batch (warming precedes the spam exit)", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls, assetCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const spam = tx({ classification: "SPAM" });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([spam]);

    expect(nativeCalls()).toBe(1);
    expect(assetCalls()).toBe(0); // the spam token itself is still never priced
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000");
    expect(spam.payload.fiat_value).toBeNull(); // warming writes nothing to the payload
    expect(spam.payload.price_status).toBe("UNKNOWN");
  });

  it("W3 warms from an ERC721-only batch (warming precedes the unpriceable-kind exit)", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls, assetCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const nft = tx({ asset_type: "ERC721", raw_amount: "1", decimals: 0 });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([nft]);

    expect(nativeCalls()).toBe(1);
    expect(assetCalls()).toBe(0);
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000");
    expect(nft.payload.fiat_value).toBeNull();
  });

  it("W3b warms from a zero-quantity row (warming precedes the quantity exit)", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([tx({ raw_amount: "0" })]);

    expect(nativeCalls()).toBe(1);
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000");
  });

  it("W4 warms on occurredAt's day when block_timestamp cannot be parsed", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([tx({ block_timestamp: "not-a-timestamp" })]);

    expect(nativeCalls()).toBe(1);
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000"); // occurredAt's UTC day
  });

  it("W4b does not warm when neither timestamp yields a day", async () => {
    // The principled exception: with no day at all there is nothing to price, and guessing
    // (e.g. today) would cache a wrong close under a real key.
    const repo = new MockHistoricalPriceRepository();
    const { oracle, calls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const broken = tx({ block_timestamp: "not-a-timestamp" });
    broken.occurredAt = new Date(Number.NaN); // the occurredAt fallback is unusable too

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([broken]);

    expect(calls()).toBe(0); // neither the native warm nor the row's own basis
    expect(await repo.get(1, "native", "2025-01-03")).toBeNull();
  });

  it("W5 shares one ETH lookup across chains with the same native symbol", async () => {
    // Chain 1 and Base both settle gas in ETH, so the same day's close serves both. The
    // provider is asked once and the answer is cached under each chain's key.
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const rows = [tx({}), tx({ chain_id: 8453 })];

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich(rows);

    expect(nativeCalls()).toBe(1);
    expect(await repo.get(1, "native", "2025-01-03")).toBe("1000000");
    expect(await repo.get(8453, "native", "2025-01-03")).toBe("1000000");
  });

  it("W5b does not share across chains with different native symbols", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([tx({}), tx({ chain_id: 137 })]); // ETH + POL

    expect(nativeCalls()).toBe(2);
    expect(await repo.get(137, "native", "2025-01-03")).toBe("1000000");
  });

  it("does not warm a chain outside the registry", async () => {
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([tx({ chain_id: 56, asset_type: "ERC721", raw_amount: "1" })]);

    expect(nativeCalls()).toBe(0);
    expect(await repo.get(56, "native", "2025-01-03")).toBeNull();
  });

  it("reuses one warmed close for a native row's own basis", async () => {
    // A native transfer's basis key IS the warm key, so it must not cost a second lookup.
    const repo = new MockHistoricalPriceRepository();
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const t = tx({ asset_type: "NATIVE", asset_contract: null, raw_amount: `2${"0".repeat(18)}` });

    await new HistoricalPriceEnrichmentService(oracle, repo).enrich([t]);

    expect(nativeCalls()).toBe(1);
    expect(t.payload.fiat_value).toBe("2000000");
    expect(t.payload.price_status).toBe("RESOLVED");
  });

  it("retries a sibling chain whose shared write failed, instead of leaving it empty", async () => {
    // Regression: memoizing the sibling before the write made a failed write look resolved,
    // so that chain short-circuited for the rest of the batch and never got cached.
    const written = new Map<string, string>();
    let failedOnce = false;
    const flaky = {
      get: async (chainId: number, assetKey: string, date: string) => written.get(`${chainId}:${assetKey}:${date}`) ?? null,
      getMany: async () => new Map<string, string>(),
      put: async (record: { chainId: number; assetKey: string; date: string; krw: string }) => {
        if (record.chainId === 8453 && !failedOnce) {
          failedOnce = true; // the cross-chain share fails exactly once
          throw new Error("connection reset");
        }
        written.set(`${record.chainId}:${record.assetKey}:${record.date}`, record.krw);
      },
    };
    const { oracle, nativeCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });

    await new HistoricalPriceEnrichmentService(oracle, flaky).enrich([tx({}), tx({ chain_id: 8453 })]);

    expect(failedOnce).toBe(true);
    expect(written.get("8453:native:2025-01-03")).toBe("1000000"); // filled on its own turn
    expect(nativeCalls()).toBe(2); // the retry costs one extra lookup, which is the trade
  });

  it("warms a native close in MOCK_MODE so mock gas is priceable", async () => {
    // The offline oracle answers native lookups; without it every mock event reports
    // gas_unpriced even though the mock ledger carries a real gas_fee_native.
    const repo = new MockHistoricalPriceRepository();

    await new HistoricalPriceEnrichmentService(new MockHistoricalPriceOracle(), repo).enrich([tx({})]);

    expect(await repo.get(1, "native", "2025-01-03")).toBe(MOCK_NATIVE_CLOSE_KRW);
    expect(await repo.get(1, "0xtoken", "2025-01-03")).toBeNull(); // contracts stay UNKNOWN
  });

  it("does not fail the batch when a shared cache write fails", async () => {
    let puts = 0;
    const flaky = {
      get: async () => null,
      getMany: async () => new Map<string, string>(),
      put: async () => {
        puts += 1;
        if (puts > 1) throw new Error("connection reset"); // the sibling-chain write fails
      },
    };
    const { oracle } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    const rows = [tx({}), tx({ chain_id: 8453 })];

    await expect(new HistoricalPriceEnrichmentService(oracle, flaky).enrich(rows)).resolves.toBeUndefined();
  });
});

describe("HistoricalPriceEnrichmentService quota guards", () => {
  it("never prices SPAM rows — they are excluded from tax and would only spend provider quota", async () => {
    const spam = tx({ classification: "SPAM", price_status: "RESOLVED" });
    const { oracle, assetCalls } = countingOracle({ krw: "1000000", status: "RESOLVED" });
    await new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository()).enrich([spam]);
    expect(assetCalls()).toBe(0);
    expect(spam.payload.fiat_value).toBeNull();
    expect(spam.payload.price_status).toBe("UNKNOWN");
  });

  it("remembers an UNLISTED asset and stops asking for other days of the same asset", async () => {
    let calls = 0;
    const oracle: HistoricalPriceOracle = { priceAt: async (_c, contract) => { if (contract !== null) calls += 1; return { status: "UNLISTED" }; } };
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
    const oracle: HistoricalPriceOracle = { priceAt: async (_c, contract) => { if (contract !== null) calls += 1; return null; } };
    const service = new HistoricalPriceEnrichmentService(oracle, new MockHistoricalPriceRepository());
    await service.enrich([tx({})]);
    await service.enrich([tx({})]);
    expect(calls).toBe(2);
  });
});
