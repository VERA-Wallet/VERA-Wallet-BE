import { describe, expect, it } from "vitest";
import type { HistoricalLookup, HistoricalPriceOracle } from "./historical-price-oracle";
import { MockHistoricalPriceRepository } from "./historical-price.repository.adapters";
import { DEFAULT_CALLS_PER_MINUTE, NativePriceBackfill, PrismaLedgerChainDaySource, type ChainDay } from "./native-price-backfill";

const source = (chainDays: ChainDay[]) => ({ listChainDays: async () => chainDays });

// Oracle stub recording every (chainId, date) it was asked for.
const recordingOracle = (answer: HistoricalLookup = { krw: "1000000", status: "RESOLVED" }) => {
  const asked: { chainId: number; date: string }[] = [];
  const oracle: HistoricalPriceOracle = {
    priceAt: async (chainId, _contract, _assetType, date) => {
      asked.push({ chainId, date });
      return answer;
    },
  };
  return { oracle, asked };
};

// Fake clock whose only way to advance is an awaited sleep, so any throttle wait is
// observable and a missing wait cannot be papered over by real elapsed time.
const fakeClock = () => {
  let current = 1_700_000_000_000;
  const slept: number[] = [];
  return {
    now: () => current,
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
  };
};

describe("NativePriceBackfill.run", () => {
  it("resolves one close per (native symbol, day) and caches it under every chain sharing the symbol", async () => {
    // Chains 1 and 8453 are both ETH; 137 is POL and must be priced separately.
    const cache = new MockHistoricalPriceRepository();
    const { oracle, asked } = recordingOracle();
    const backfill = new NativePriceBackfill(
      source([
        { chainId: 1, date: "2025-01-03" },
        { chainId: 8453, date: "2025-01-03" },
        { chainId: 137, date: "2025-01-03" },
      ]),
      cache,
      oracle,
      { log: () => {} },
    );

    const result = await backfill.run();

    expect(result.combos).toBe(2); // (ETH, day) and (POL, day)
    expect(result.oracleCalls).toBe(2); // NOT 3: chains 1 and 8453 shared one lookup
    expect(result.cachePuts).toBe(3); // every chain key still gets its own cache row
    expect(asked.map((call) => call.date)).toEqual(["2025-01-03", "2025-01-03"]);
    expect(await cache.get(1, "native", "2025-01-03")).toBe("1000000");
    expect(await cache.get(8453, "native", "2025-01-03")).toBe("1000000");
    expect(await cache.get(137, "native", "2025-01-03")).toBe("1000000");
  });

  it("is idempotent: a second run makes zero oracle calls", async () => {
    const cache = new MockHistoricalPriceRepository();
    const { oracle, asked } = recordingOracle();
    const ledger = source([
      { chainId: 1, date: "2025-01-03" },
      { chainId: 8453, date: "2025-01-04" },
      { chainId: 137, date: "2025-01-03" },
    ]);

    const first = await new NativePriceBackfill(ledger, cache, oracle, { log: () => {} }).run();
    expect(first.oracleCalls).toBeGreaterThan(0);

    const second = await new NativePriceBackfill(ledger, cache, oracle, { log: () => {} }).run();
    expect(second.oracleCalls).toBe(0);
    expect(second.missingCombos).toBe(0);
    expect(second.cachePuts).toBe(0);
    expect(asked.length).toBe(first.oracleCalls); // nothing was asked the second time
  });

  it("copies a known close to a sibling chain instead of re-asking the oracle", async () => {
    // Chain 1 was warmed by an earlier sync; Base was not. Same symbol, same day, so the
    // cached value is authoritative for both and no quota should be spent.
    const cache = new MockHistoricalPriceRepository();
    await cache.put({ chainId: 1, assetKey: "native", date: "2025-01-03", krw: "1234" });
    const { oracle, asked } = recordingOracle();

    const result = await new NativePriceBackfill(
      source([
        { chainId: 1, date: "2025-01-03" },
        { chainId: 8453, date: "2025-01-03" },
      ]),
      cache,
      oracle,
      { log: () => {} },
    ).run();

    expect(asked).toEqual([]);
    expect(result.oracleCalls).toBe(0);
    expect(result.cachePuts).toBe(1);
    expect(await cache.get(8453, "native", "2025-01-03")).toBe("1234");
  });

  it("throttles to the configured calls per minute", async () => {
    const clock = fakeClock();
    const callsPerMinute = 3;
    const days = Array.from({ length: 7 }, (_, index) => ({ chainId: 1, date: dayFromIndex(index) }));
    // Stamp each lookup with the fake clock so the pacing itself is observable.
    const callTimes: number[] = [];
    const oracle: HistoricalPriceOracle = {
      priceAt: async () => {
        callTimes.push(clock.now());
        return { krw: "1000000", status: "RESOLVED" as const };
      },
    };

    const result = await new NativePriceBackfill(source(days), new MockHistoricalPriceRepository(), oracle, {
      callsPerMinute,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }).run();

    expect(result.oracleCalls).toBe(7);
    expect(clock.slept.length).toBeGreaterThan(0); // it actually waited rather than bursting
    // The bucket guarantee: call i cannot start until the call `callsPerMinute` before it
    // has aged out of the 60s window.
    for (let i = callsPerMinute; i < callTimes.length; i += 1) {
      expect(callTimes[i] - callTimes[i - callsPerMinute]).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("does not sleep while the rolling window still has room", async () => {
    const clock = fakeClock();
    const { oracle } = recordingOracle();

    await new NativePriceBackfill(source([{ chainId: 1, date: "2025-01-03" }]), new MockHistoricalPriceRepository(), oracle, {
      callsPerMinute: 25,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    }).run();

    expect(clock.slept).toEqual([]);
  });

  it("reports N and the estimated runtime in --dry-run without calling the oracle", async () => {
    const cache = new MockHistoricalPriceRepository();
    await cache.put({ chainId: 1, assetKey: "native", date: "2025-01-01", krw: "1000000" }); // already resolved
    const { oracle, asked } = recordingOracle();
    const lines: string[] = [];
    const days = [
      { chainId: 1, date: "2025-01-01" },
      ...Array.from({ length: 30 }, (_, index) => ({ chainId: 137, date: dayFromIndex(index) })),
    ];

    const result = await new NativePriceBackfill(source(days), cache, oracle, { log: (line) => lines.push(line) }).run({ dryRun: true });

    expect(asked).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.missingCombos).toBe(30); // the pre-cached ETH day is excluded
    expect(result.estimatedMinutes).toBe(Math.ceil(30 / DEFAULT_CALLS_PER_MINUTE)); // 2
    const output = lines.join("\n");
    expect(output).toContain("N = combos missing from the cache: 30");
    expect(output).toContain("estimated runtime at 25 calls/min: 2 minute(s)");
    expect(output).toContain("N <= 750: run it now.");
    // A dry run must not write anything either.
    expect(await cache.get(137, "native", "2025-02-01")).toBeNull();
  });

  it("prints the low-traffic and hold verdicts at the runbook thresholds", async () => {
    const dryRunVerdict = async (missing: number) => {
      const lines: string[] = [];
      const days = Array.from({ length: missing }, (_, index) => ({ chainId: 1, date: dayFromIndex(index) }));
      await new NativePriceBackfill(source(days), new MockHistoricalPriceRepository(), recordingOracle().oracle, {
        log: (line) => lines.push(line),
      }).run({ dryRun: true });
      return lines.join("\n");
    };

    expect(await dryRunVerdict(751)).toContain("750 < N <= 2000: run during low traffic");
    expect(await dryRunVerdict(2_001)).toContain("N > 2000: HOLD.");
  });

  it("leaves an unresolved combo uncached so a later run retries it", async () => {
    const cache = new MockHistoricalPriceRepository();
    const { oracle } = recordingOracle(null); // transient failure
    const result = await new NativePriceBackfill(source([{ chainId: 1, date: "2025-01-03" }]), cache, oracle, { log: () => {} }).run();

    expect(result.unresolvedCombos).toBe(1);
    expect(result.cachePuts).toBe(0);
    expect(await cache.get(1, "native", "2025-01-03")).toBeNull();
  });

  it("never caches a poisoned close", async () => {
    const cache = new MockHistoricalPriceRepository();
    const { oracle } = recordingOracle({ krw: "-5", status: "RESOLVED" });
    const result = await new NativePriceBackfill(source([{ chainId: 1, date: "2025-01-03" }]), cache, oracle, { log: () => {} }).run();

    expect(result.resolvedCombos).toBe(0);
    expect(await cache.get(1, "native", "2025-01-03")).toBeNull();
  });

  it("skips chains the registry does not index instead of pricing them", async () => {
    const { oracle, asked } = recordingOracle();
    const result = await new NativePriceBackfill(
      source([
        { chainId: 1, date: "2025-01-03" },
        { chainId: 56, date: "2025-01-03" }, // BNB chain: not in CHAIN_REGISTRY
      ]),
      new MockHistoricalPriceRepository(),
      oracle,
      { log: () => {} },
    ).run();

    expect(result.skippedChainDays).toBe(1);
    expect(asked.map((call) => call.chainId)).toEqual([1]);
  });

  it("survives a cache write failure without aborting the remaining combos", async () => {
    const failing = {
      get: async () => null,
      getMany: async () => new Map<string, string>(),
      put: async () => {
        throw new Error("connection reset");
      },
    };
    const { oracle } = recordingOracle();
    const result = await new NativePriceBackfill(
      source([
        { chainId: 1, date: "2025-01-03" },
        { chainId: 137, date: "2025-01-03" },
      ]),
      failing,
      oracle,
      { log: () => {} },
    ).run();

    expect(result.oracleCalls).toBe(2);
    expect(result.cachePuts).toBe(0);
  });
});

describe("PrismaLedgerChainDaySource.listChainDays", () => {
  it("pages the ledger and collapses rows into distinct (chain, UTC day) pairs", async () => {
    const rows = [
      row("a", { chain_id: 1, block_timestamp: "2025-01-03T01:00:00.000Z" }, new Date("2024-01-01T00:00:00.000Z")),
      row("b", { chain_id: 1, block_timestamp: "2025-01-03T23:00:00.000Z" }, new Date("2024-01-01T00:00:00.000Z")),
      row("c", { chain_id: 8453, block_timestamp: "2025-01-03T05:00:00.000Z" }, new Date("2024-01-01T00:00:00.000Z")),
      // No block_timestamp: the stored occurredAt is the fallback, matching the sync path.
      row("d", { chain_id: 137 }, new Date("2025-02-09T12:00:00.000Z")),
      // Unparseable timestamp and missing chain: both dropped rather than guessed.
      row("e", { chain_id: 1, block_timestamp: "not-a-date" }, new Date("2025-03-01T00:00:00.000Z")),
      row("f", { block_timestamp: "2025-01-03T01:00:00.000Z" }, new Date("2025-03-01T00:00:00.000Z")),
    ];
    const pages: unknown[] = [];
    const prisma = {
      transactionNormalized: {
        findMany: async (args: unknown) => {
          pages.push(args);
          const { take, cursor } = args as { take: number; cursor?: { id: string } };
          const start = cursor === undefined ? 0 : rows.findIndex((r) => r.id === cursor.id) + 1;
          return rows.slice(start, start + take);
        },
      },
    };

    const pairs = await new PrismaLedgerChainDaySource(prisma, 2).listChainDays();

    expect(pairs).toEqual([
      { chainId: 1, date: "2025-01-03" },
      { chainId: 8453, date: "2025-01-03" },
      { chainId: 137, date: "2025-02-09" },
    ]);
    expect(pages.length).toBeGreaterThan(1); // actually paged, not one unbounded read
  });

  it("keys an offset timestamp by its UTC day, matching sync-time warming", async () => {
    // 2025-01-03T00:30:00+09:00 is 2025-01-02T15:30:00Z.
    const prisma = {
      transactionNormalized: {
        findMany: async (args: unknown) =>
          (args as { cursor?: unknown }).cursor === undefined
            ? [row("a", { chain_id: 1, block_timestamp: "2025-01-03T00:30:00+09:00" }, new Date("2024-01-01T00:00:00.000Z"))]
            : [],
      },
    };

    expect(await new PrismaLedgerChainDaySource(prisma, 10).listChainDays()).toEqual([{ chainId: 1, date: "2025-01-02" }]);
  });
});

function row(id: string, payload: Record<string, unknown>, occurredAt: Date) {
  return { id, payload, occurredAt };
}

// Spreads N combos over distinct days without ever hitting an invalid calendar date.
function dayFromIndex(index: number): string {
  return new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);
}
