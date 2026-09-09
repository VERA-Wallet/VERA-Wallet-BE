import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { computeCostBasis, type CostBasisOptions, type CostBasisResult } from "@vera/tax-engine";
import type { TransactionRecord } from "../shared/repository.types";
import { HISTORICAL_PRICE_REPOSITORY } from "./indexer.tokens";
import type { CostBasisSnapshotPort } from "./cost-basis-snapshot.port";
import { historicalPriceKey, type HistoricalPriceKey, type HistoricalPriceRepository } from "./historical-price.repository";
import { utcDayOf } from "./historical-price-enrichment.service";

// The asset key every chain's native coin is cached under (historical-price-enrichment
// warms exactly this key, so reader and writer cannot drift).
const NATIVE_ASSET_KEY = "native";

// Second-level cache key used when gas accounting is off. A module-scope frozen object,
// so "no gas" is one stable identity rather than a fresh key per call.
const NO_GAS: object = Object.freeze({});

// Stand-in for "no native closes available": either nothing in the ledger is addressable,
// or the cache probe failed and we degraded. One shared instance, so a repeated
// degradation lands on the same second-level key and reuses the fold it already produced.
const NO_PRICES: ReadonlyMap<string, string> = Object.freeze(new Map<string, string>());

export type CostBasisFold = (events: TransactionRecord[], options?: CostBasisOptions) => Map<string, CostBasisResult>;

/**
 * The one place a user's cost-basis fold is computed, shared by every read path.
 *
 * `EventQueryService` and `FrontendTaxService` are separate instances, so a per-service
 * WeakMap folded the same ledger twice per request. Both now go through this provider.
 *
 * Cache contract (plan §PR-1):
 *  - two levels, both keyed by IDENTITY: the rows array instance, then the memoized
 *    `nativePrices` Map instance (or the NO_GAS sentinel). The price map is itself
 *    memoized on the rows instance, so the same snapshot always yields the same Map and
 *    no content hash is needed — a 32-bit fingerprint would only add collision risk.
 *  - the memo stores the PROMISE, not the settled result, the same way
 *    `CachedTransactionRepository` holds its in-flight loads. A dashboard firing list and
 *    summary concurrently would otherwise miss twice and fold twice; instead the second
 *    caller joins the fold already running.
 */
@Injectable()
export class CostBasisSnapshotService implements CostBasisSnapshotPort {
  private readonly logger = new Logger(CostBasisSnapshotService.name);
  private readonly folds = new WeakMap<TransactionRecord[], WeakMap<object, Promise<Map<string, CostBasisResult>>>>();
  private readonly nativePrices = new WeakMap<TransactionRecord[], Promise<ReadonlyMap<string, string>>>();

  constructor(
    @Inject(HISTORICAL_PRICE_REPOSITORY) private readonly prices: HistoricalPriceRepository,
    // Injected so a spec can count folds; Nest leaves it undefined and the default wins.
    @Optional() private readonly fold: CostBasisFold = computeCostBasis,
  ) {}

  /**
   * Moving-average fold over the user's FULL history, keyed by event id.
   *
   * Callers must pass the whole ledger: filtering to a period first would drop the
   * prior-year acquisitions that carry cost into this year's disposals. Gas valuation is
   * on by default; `{ gas: false }` takes the sentinel path and touches no repository.
   */
  async snapshotFor(userId: string, rows: TransactionRecord[], opts?: { gas?: boolean }): Promise<Map<string, CostBasisResult>> {
    const withGas = opts?.gas !== false;
    const nativePrices = withGas ? await this.nativePricesFor(userId, rows) : undefined;
    const cacheKey = nativePrices ?? NO_GAS;

    let byPrices = this.folds.get(rows);
    if (byPrices === undefined) {
      byPrices = new WeakMap();
      this.folds.set(rows, byPrices);
    }
    const memo = byPrices;
    const inflight = memo.get(cacheKey);
    if (inflight !== undefined) return inflight;

    // Deferred so the memo entry is installed before the fold runs; a concurrent caller
    // that arrives during the fold joins this promise instead of starting its own.
    const pending = Promise.resolve()
      .then(() => this.fold(rows, nativePrices === undefined ? undefined : { nativePrices }))
      .catch((error: unknown) => {
        // A rejected fold must never stay in the memo: every later read of this snapshot
        // would replay the same exception until the ledger cache expired. Drop the entry
        // and let the caller see the real error, so the next read retries from scratch.
        memo.delete(cacheKey);
        throw error;
      });
    memo.set(cacheKey, pending);
    return pending;
  }

  /**
   * `${chainId}:${YYYY-MM-DD}` -> KRW native close for every (chain, day) the ledger
   * touches, memoized on the rows instance so repeated reads share one Map identity
   * (that identity is the fold's second-level cache key).
   */
  private nativePricesFor(userId: string, rows: TransactionRecord[]): Promise<ReadonlyMap<string, string>> {
    const hit = this.nativePrices.get(rows);
    if (hit !== undefined) return hit;
    const pending = this.loadNativePrices(rows).catch((error: unknown) => {
      // Degrade, never fail. Before gas accounting existed these read paths never touched
      // the price cache at all, so letting a probe failure surface would turn a cache
      // outage into a 500 on the whole ledger. "모르면 비운다": the fee goes unvalued and
      // the engine flags gas_unpriced, which is exactly what a cache miss already means.
      this.logger.warn(`Native close probe failed for user ${userId}; gas left unpriced: ${error instanceof Error ? error.message : String(error)}`);
      // Forget the degraded attempt so the NEXT read retries the repository instead of
      // pinning "no prices" for the rest of the ledger snapshot's lifetime. The fold
      // memo needs no cleanup here: nothing rejected, and the entry it keeps is keyed by
      // NO_PRICES, which is the correct answer whenever the probe degrades again.
      this.nativePrices.delete(rows);
      return NO_PRICES;
    });
    this.nativePrices.set(rows, pending);
    return pending;
  }

  private async loadNativePrices(rows: TransactionRecord[]): Promise<ReadonlyMap<string, string>> {
    // Distinct (chain, day) coordinates, mapped to the engine key they will be read under.
    const wanted = new Map<string, { key: HistoricalPriceKey; engineKey: string }>();
    for (const row of rows) {
      const rawChain = row.payload.chain_id;
      const chainId = Number(rawChain);
      if (!Number.isFinite(chainId)) continue;
      // Same day derivation as the warming pass: block_timestamp first, occurredAt as
      // fallback. A row whose day cannot be established has no close to look up.
      const stamped = typeof row.payload.block_timestamp === "string" ? utcDayOf(row.payload.block_timestamp) : null;
      const date = stamped ?? utcDayOf(row.occurredAt);
      if (date === null) continue;
      const key: HistoricalPriceKey = { chainId, assetKey: NATIVE_ASSET_KEY, date };
      // `String(chain_id)` mirrors nativePriceKeyOf() in the engine exactly.
      wanted.set(historicalPriceKey(key), { key, engineKey: `${String(rawChain ?? "")}:${date}` });
    }
    if (wanted.size === 0) return NO_PRICES;

    const cached = await this.readCache([...wanted.values()].map((entry) => entry.key));
    const prices = new Map<string, string>();
    for (const [cacheKey, { engineKey }] of wanted) {
      const krw = cached.get(cacheKey);
      // A miss stays absent: the engine then reports gasFiat null + review gas_unpriced
      // rather than valuing the fee at zero.
      if (krw !== undefined) prices.set(engineKey, krw);
    }
    return prices;
  }

  // Thin seam over the repository's bulk probe so its shape is isolated to one line.
  private readCache(keys: readonly HistoricalPriceKey[]): Promise<Map<string, string>> {
    return this.prices.getMany(keys);
  }
}
