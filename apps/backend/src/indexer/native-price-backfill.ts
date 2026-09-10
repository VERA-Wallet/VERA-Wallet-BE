import { Logger } from "@nestjs/common";
import Decimal from "decimal.js";
import { nativeSymbolOf } from "./chain-registry";
import { utcDayOf } from "./historical-price-enrichment.service";
import type { HistoricalPriceOracle } from "./historical-price-oracle";
import { historicalPriceKey, type HistoricalPriceKey, type HistoricalPriceRepository } from "./historical-price.repository";

// Why this command exists: sync-time warming (HistoricalPriceEnrichmentService) only fills
// the native-close cache for rows it syncs, and `listOrSync` syncs a binding exactly once.
// Every user who finished their first sync before warming shipped would keep an empty
// native cache forever, so the read-time cost-basis fold would report gas as unpriced
// indefinitely. This is the one-shot repair for that population.
//
// It is deliberately a batch job, not lazy warming on the read path: lazily filling a year
// of history inside a user request would both slow the request and burst straight through
// the provider's free-tier quota.

// CoinGecko's free tier allows roughly 30 calls/minute. 25 leaves headroom for the live
// sync path, which keeps serving users while the backfill runs.
export const DEFAULT_CALLS_PER_MINUTE = 25;
const WINDOW_MS = 60_000;

// Runbook thresholds on N = the number of (native symbol, day) combos still missing.
// Printed by --dry-run so the operator decides from the same numbers the plan states.
export const RUNBOOK_RUN_NOW_MAX = 750;
export const RUNBOOK_LOW_TRAFFIC_MAX = 2_000;

// One (chain, UTC day) pair observed in the stored ledger.
export type ChainDay = { chainId: number; date: string };

// The ledger side of the backfill, kept behind a port so the core is testable without a
// database. Duplicate pairs are tolerated but wasteful.
export interface LedgerChainDaySource {
  listChainDays(): Promise<ChainDay[]>;
}

export type NativePriceBackfillResult = {
  // Distinct (chain, day) pairs found in the ledger, after dropping unindexed chains.
  chainDays: number;
  // Distinct (native symbol, day) combos those pairs collapse into.
  combos: number;
  // N: combos with no cached close on ANY of their chains. Drives the runbook decision.
  missingCombos: number;
  // (chain, day) pairs on a chain the registry does not know; skipped, never priced.
  skippedChainDays: number;
  oracleCalls: number;
  cachePuts: number;
  resolvedCombos: number;
  // Combos the oracle could not answer (unlisted or transient). Safe to re-run.
  unresolvedCombos: number;
  estimatedMinutes: number;
  dryRun: boolean;
};

type Combo = { symbol: string; date: string; keys: HistoricalPriceKey[] };

function isFinitePositive(raw: string): boolean {
  try {
    const value = new Decimal(raw);
    return value.isFinite() && value.greaterThan(0);
  } catch {
    return false;
  }
}

// Core of `backfill:native-prices`, with the ledger, cache, oracle, clock and sleep all
// injected so the throttle and the idempotency are unit-testable without waiting a minute.
export class NativePriceBackfill {
  private readonly callsPerMinute: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  // Timestamps of oracle calls inside the current rolling minute.
  private readonly recentCalls: number[] = [];

  constructor(
    private readonly source: LedgerChainDaySource,
    private readonly cache: HistoricalPriceRepository,
    private readonly oracle: HistoricalPriceOracle,
    options: {
      callsPerMinute?: number;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
      log?: (line: string) => void;
    } = {},
  ) {
    this.callsPerMinute = options.callsPerMinute ?? DEFAULT_CALLS_PER_MINUTE;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((line) => console.log(line));
  }

  async run(options: { dryRun?: boolean } = {}): Promise<NativePriceBackfillResult> {
    const dryRun = options.dryRun === true;
    const chainDays = await this.source.listChainDays();

    // Group by (native symbol, day). Chains sharing a symbol share one lookup, so an ETH
    // wallet active on mainnet + Base + Arbitrum costs one call per day, not three.
    const combos = new Map<string, Combo>();
    const seenPairs = new Set<string>();
    let skippedChainDays = 0;
    let keptChainDays = 0;
    for (const { chainId, date } of chainDays) {
      const pairKey = `${chainId}:${date}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const symbol = nativeSymbolOf(chainId);
      if (symbol === null || utcDayOf(date) !== date) {
        skippedChainDays += 1;
        continue;
      }
      keptChainDays += 1;
      const comboKey = `${symbol}:${date}`;
      const combo = combos.get(comboKey) ?? { symbol, date, keys: [] };
      combo.keys.push({ chainId, assetKey: "native", date });
      combos.set(comboKey, combo);
    }

    // One bulk probe decides what is already cached, which is what makes a re-run cost
    // zero oracle calls.
    const cached = await this.cache.getMany([...combos.values()].flatMap((combo) => combo.keys));

    // A combo needs the oracle only when NONE of its chain keys is cached. When some are,
    // the known close is copied across: a symbol's close on a day is chain-independent.
    const pending: Combo[] = [];
    const copies: { key: HistoricalPriceKey; krw: string }[] = [];
    for (const combo of combos.values()) {
      const known = combo.keys
        .map((key) => cached.get(historicalPriceKey(key)))
        .find((krw): krw is string => krw !== undefined && isFinitePositive(krw));
      if (known === undefined) {
        pending.push(combo);
        continue;
      }
      for (const key of combo.keys) {
        if (cached.get(historicalPriceKey(key)) === undefined) copies.push({ key, krw: known });
      }
    }

    const result: NativePriceBackfillResult = {
      chainDays: keptChainDays,
      combos: combos.size,
      missingCombos: pending.length,
      skippedChainDays,
      oracleCalls: 0,
      cachePuts: 0,
      resolvedCombos: 0,
      unresolvedCombos: 0,
      estimatedMinutes: Math.ceil(pending.length / this.callsPerMinute),
      dryRun,
    };

    if (dryRun) {
      this.reportDryRun(result);
      return result;
    }

    for (const { key, krw } of copies) await this.put(key, krw, result);

    for (const combo of pending) {
      await this.throttle();
      result.oracleCalls += 1;
      const looked = await this.lookup(combo);
      if (looked === null) {
        result.unresolvedCombos += 1;
        continue;
      }
      result.resolvedCombos += 1;
      for (const key of combo.keys) await this.put(key, looked, result);
    }

    this.log(
      `backfill:native-prices done - combos ${result.combos}, oracle calls ${result.oracleCalls}, ` +
        `resolved ${result.resolvedCombos}, unresolved ${result.unresolvedCombos}, cache writes ${result.cachePuts}.`,
    );
    if (result.unresolvedCombos > 0) {
      this.log(`${result.unresolvedCombos} combo(s) stayed unresolved (unlisted or transient). Re-running is safe and retries only those.`);
    }
    this.log("Read-time snapshots memoize their native-close map for up to 60s, so gas may still read as unpriced for one TTL cycle after this run.");
    return result;
  }

  private reportDryRun(result: NativePriceBackfillResult): void {
    this.log("backfill:native-prices --dry-run (no oracle calls made)");
    this.log(`  ledger (chain, day) pairs: ${result.chainDays}${result.skippedChainDays > 0 ? ` (+${result.skippedChainDays} on unindexed chains, skipped)` : ""}`);
    this.log(`  (native symbol, day) combos: ${result.combos}`);
    this.log(`  N = combos missing from the cache: ${result.missingCombos}`);
    this.log(`  estimated runtime at ${this.callsPerMinute} calls/min: ${result.estimatedMinutes} minute(s)`);
    const verdict =
      result.missingCombos <= RUNBOOK_RUN_NOW_MAX
        ? `N <= ${RUNBOOK_RUN_NOW_MAX}: run it now.`
        : result.missingCombos <= RUNBOOK_LOW_TRAFFIC_MAX
          ? `${RUNBOOK_RUN_NOW_MAX} < N <= ${RUNBOOK_LOW_TRAFFIC_MAX}: run during low traffic and monitor to completion.`
          : `N > ${RUNBOOK_LOW_TRAFFIC_MAX}: HOLD. Check chain count, date range, and symbol sharing before running.`;
    this.log(`  runbook: ${verdict}`);
    this.log("  Interrupting is safe: the run is idempotent and a re-run only fetches what is still missing.");
  }

  private async lookup(combo: Combo): Promise<string | null> {
    // Any chain in the combo prices the same coin, so the first one is representative.
    const chainId = combo.keys[0].chainId;
    try {
      const looked = await this.oracle.priceAt(chainId, null, "NATIVE", combo.date);
      if (looked === null || looked.status !== "RESOLVED") return null;
      return isFinitePositive(looked.krw) ? looked.krw : null; // never cache poison
    } catch (error) {
      this.log(`  lookup failed for ${combo.symbol}@${combo.date}: ${(error as Error).message}`);
      return null;
    }
  }

  private async put(key: HistoricalPriceKey, krw: string, result: NativePriceBackfillResult): Promise<void> {
    try {
      await this.cache.put({ ...key, krw });
      result.cachePuts += 1;
    } catch (error) {
      // One failed write costs a lookup on the next run; it must not abort the backfill.
      this.log(`  cache write failed for ${historicalPriceKey(key)}: ${(error as Error).message}`);
    }
  }

  // Rolling-window token bucket over the last 60s. It sleeps only when the window is full,
  // rather than pacing every call, so a run shorter than the budget finishes at full speed.
  private async throttle(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - WINDOW_MS;
      while (this.recentCalls.length > 0 && this.recentCalls[0] <= cutoff) this.recentCalls.shift();
      if (this.recentCalls.length < this.callsPerMinute) break;
      await this.sleep(this.recentCalls[0] - cutoff);
    }
    this.recentCalls.push(this.now());
  }
}

// Minimal shape of the Prisma delegate this scan needs, so the source can be unit-tested
// and does not drag the generated client into every importer.
export type LedgerRowPager = {
  transactionNormalized: {
    findMany(args: unknown): Promise<{ id: string; payload: unknown; occurredAt: Date }[]>;
  };
};

// Prisma-backed ledger scan. Pages by primary key and derives the day with the same rule
// the sync path uses (`block_timestamp` when present, else the stored `occurredAt`), so the
// backfill fills exactly the keys warming would have filled. Deriving in JS rather than SQL
// is deliberate: a malformed `block_timestamp` in one row must not abort the whole scan.
export class PrismaLedgerChainDaySource implements LedgerChainDaySource {
  private readonly logger = new Logger(PrismaLedgerChainDaySource.name);

  constructor(
    private readonly prisma: LedgerRowPager,
    private readonly pageSize = 1_000,
  ) {}

  async listChainDays(): Promise<ChainDay[]> {
    const pairs = new Map<string, ChainDay>();
    let cursor: string | null = null;
    let scanned = 0;
    for (;;) {
      const rows = await this.prisma.transactionNormalized.findMany({
        select: { id: true, payload: true, occurredAt: true },
        orderBy: { id: "asc" },
        take: this.pageSize,
        ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
      });
      if (rows.length === 0) break;
      scanned += rows.length;
      for (const row of rows) {
        const payload = (row.payload ?? {}) as Record<string, unknown>;
        const chainId = Number(payload.chain_id);
        if (!Number.isFinite(chainId)) continue;
        const date = utcDayOf(payload.block_timestamp ?? row.occurredAt);
        if (date === null) continue; // same principled exception as sync-time warming
        pairs.set(`${chainId}:${date}`, { chainId, date });
      }
      cursor = rows[rows.length - 1].id;
      if (rows.length < this.pageSize) break;
    }
    this.logger.log(`Scanned ${scanned} ledger rows into ${pairs.size} distinct (chain, day) pairs.`);
    return [...pairs.values()];
  }
}
