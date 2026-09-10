import { Inject, Injectable, Logger } from "@nestjs/common";
import Decimal from "decimal.js";
import type { IndexedTransaction } from "@vera/interfaces";
import { nativeSymbolOf } from "./chain-registry";
import { HISTORICAL_PRICE_ORACLE, HISTORICAL_PRICE_REPOSITORY } from "./indexer.tokens";
import { dayWindow, endpointKind, type HistoricalPriceOracle } from "./historical-price-oracle";
import type { HistoricalPriceRepository } from "./historical-price.repository";

// A KRW close is only usable when it parses to a finite, strictly-positive Decimal. Used
// to reject poisoned oracle output before caching and to quarantine bad cached values.
function isFinitePositive(raw: string): boolean {
  try {
    const value = new Decimal(raw);
    return value.isFinite() && value.greaterThan(0);
  } catch {
    return false;
  }
}

// An unlisted asset is re-checked after this long — listings do appear over time, so the memory is not permanent.
const UNLISTED_TTL_MS = 24 * 60 * 60 * 1_000;
const UNLISTED_MAX_ENTRIES = 10_000;

// Fills the TAX BASIS (fiat_value + price_status) that the real Alchemy adapter leaves
// null, using historical KRW closes. Distinct from PriceEnrichmentService, which only
// writes the display-only DexScreener spot price and never touches the basis.
//
// Idempotent + cache-first: the oracle is consulted at most once per (asset, day); the
// resolved unit close is cached (Prisma) and reused. fiat_value is the TOTAL event value
// (unit close * quantity), matching the shape cost-basis / summary already consume.
@Injectable()
export class HistoricalPriceEnrichmentService {
  private readonly logger = new Logger(HistoricalPriceEnrichmentService.name);
  // Process-level single-flight: concurrent enrich() calls (e.g. two users syncing the
  // same popular token+day) share ONE oracle lookup per (chain, assetKey, date). Entries
  // are deleted once settled, so a failed lookup stays retryable (never permanently null).
  private readonly inflight = new Map<string, Promise<string | null>>();
  // Assets the provider positively does not list (404), keyed by chain:asset, with an expiry.
  // Without this every resync re-asks CoinGecko for every (unlisted asset, day) pair — on a wallet with
  // hundreds of long-tail tokens that alone burns the free-tier quota (~30 calls/min) for an hour.
  // Only UNLISTED is remembered; transient failures (429/network) stay retryable as before.
  private readonly unlisted = new Map<string, number>();

  constructor(
    @Inject(HISTORICAL_PRICE_ORACLE) private readonly oracle: HistoricalPriceOracle,
    @Inject(HISTORICAL_PRICE_REPOSITORY) private readonly cache: HistoricalPriceRepository,
  ) {}

  async enrich(transactions: IndexedTransaction[]): Promise<void> {
    const memo = new Map<string, string | null>();
    // Every chain this batch touches. One ETH close then serves chains 1/8453/42161/10
    // (A5): the oracle is asked once and the answer is cached under each of those keys.
    const batchChainIds = new Set<number>();
    for (const transaction of transactions) {
      const chainId = Number(transaction.payload.chain_id);
      if (Number.isFinite(chainId)) batchChainIds.add(chainId);
    }

    for (const transaction of transactions) {
      const payload = transaction.payload;
      // Derived BEFORE the early exits below, because the gas fee of a row we do not
      // price is still paid in the chain's native coin and the read-time cost-basis fold
      // needs that day's native close. A row skipped for spam / NFT-ness / zero quantity
      // therefore still warms the cache. Nothing is written to the payload here.
      const chainId = Number(payload.chain_id);
      // Fall back on a block_timestamp that will not PARSE, not merely on a missing one.
      // The read path (cost-basis-snapshot.service.ts) resolves the day this way, and a row
      // valued on no day here but on occurredAt's day there would price its basis and its
      // gas from different calendars.
      const date = this.dateOf(payload.block_timestamp) ?? this.dateOf(transaction.occurredAt);
      // Principled exception: when neither field yields a day there is nothing to price, so
      // this row cannot be warmed at all (never guessed from "today").
      await this.warmNativeClose(chainId, date, batchChainIds, memo);

      // Already-priced rows (e.g. the mock path) keep their basis untouched.
      if (payload.fiat_value !== null && payload.fiat_value !== undefined) continue;
      // Dust/airdrop spam is excluded from tax and hidden by default; pricing it only spends provider quota.
      // A heavy wallet is mostly spam by row count (3,000+ inbound airdrops observed on 2026-09-08).
      if (payload.classification === "SPAM") {
        payload.price_status = "UNKNOWN";
        continue;
      }

      // Every row we take ownership of is UNKNOWN until a validated close resolves it.
      // This makes the invariant self-contained instead of trusting an upstream default.
      payload.price_status = "UNKNOWN";

      const assetType = String(payload.asset_type ?? "");
      const rawContract = typeof payload.asset_contract === "string" ? payload.asset_contract : null;
      const endpoint = endpointKind(assetType, rawContract);
      if (endpoint === null) continue; // NFT / unknown kind / mismatched contract -> stays UNKNOWN
      const contract = endpoint === "native" ? null : rawContract;

      const quantity = this.quantityOf(payload);
      if (quantity === null || quantity.lessThanOrEqualTo(0)) continue;

      if (!date) continue;
      const assetKey = endpoint === "native" ? "native" : contract!.toLowerCase();
      const memoKey = `${chainId}:${assetKey}:${date}`;

      let unitKrw = memo.get(memoKey);
      if (unitKrw === undefined) {
        unitKrw = this.isUnlisted(chainId, assetKey) ? null : await this.resolveShared(memoKey, chainId, assetKey, contract, assetType, date);
        memo.set(memoKey, unitKrw);
      }
      if (unitKrw === null) continue; // UNKNOWN: never coerce a basis

      // resolve() already guarantees a finite positive close; this is a last-line guard.
      const unit = new Decimal(unitKrw);
      if (!unit.isFinite() || unit.lessThanOrEqualTo(0)) continue;
      payload.fiat_value = unit.mul(quantity).toFixed();
      payload.price_status = "RESOLVED";
    }
  }

  // Cache-only warming of the chain's native daily close. The read-time cost-basis fold
  // needs (chain, day) -> native KRW to value gas fees, but the fee itself is an observed
  // fact we do NOT store as a derived fiat amount on the payload; this fills the cache the
  // fold reads from. Nothing here touches `payload`.
  //
  // One oracle call per (native symbol, day): the resolved close is written under every
  // chain in this batch sharing that symbol, so an ETH batch spanning mainnet and Base
  // costs one lookup and two cache rows.
  private async warmNativeClose(chainId: number, date: string | null, batchChainIds: ReadonlySet<number>, memo: Map<string, string | null>): Promise<void> {
    if (date === null || !Number.isFinite(chainId)) return;
    const symbol = nativeSymbolOf(chainId);
    if (symbol === null) return; // chain we do not index: no native coin to price
    const memoKey = `${chainId}:native:${date}`;
    if (memo.has(memoKey)) return; // already resolved (or already known-unresolvable) in this batch

    const unitKrw = this.isUnlisted(chainId, "native") ? null : await this.resolveShared(memoKey, chainId, "native", null, "NATIVE", date);
    memo.set(memoKey, unitKrw);
    if (unitKrw === null) return; // transient/unlisted: stays UNKNOWN, retried next sync

    for (const sibling of batchChainIds) {
      if (sibling === chainId || nativeSymbolOf(sibling) !== symbol) continue;
      const siblingKey = `${sibling}:native:${date}`;
      if (memo.has(siblingKey)) continue;
      try {
        await this.cache.put({ chainId: sibling, assetKey: "native", date, krw: unitKrw });
        // Memoized only AFTER the write lands. Memoizing first would make a failed write
        // look resolved, so that chain's own rows would short-circuit here and leave it
        // uncached for the whole batch; instead it retries on its own turn.
        memo.set(siblingKey, unitKrw);
      } catch (error) {
        // A failed sibling write costs one extra lookup; it must never fail the batch.
        this.logger.warn(`Native close share failed for ${sibling}:native@${date}: ${(error as Error).message}`);
      }
    }
  }

  // Single-flight wrapper: coalesces concurrent resolves of the same key into one shared
  // Promise, then evicts the entry so failures stay retryable. This is the process-level
  // guarantee of one external lookup per key; the persistent cache + canonical re-read
  // cover restarts. (A daily close is immutable, so a single-instance guard suffices; no
  // distributed lock is warranted.)
  private resolveShared(key: string, chainId: number, assetKey: string, contract: string | null, assetType: string, date: string): Promise<string | null> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const pending = this.resolve(chainId, assetKey, contract, assetType, date).finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  // Cache-first: a VALID hit never touches the oracle. On a miss (or an invalid/poisoned
  // cached value) the oracle is consulted once; only a finite positive close is written
  // back, so a bad value can never poison the cache. A failed lookup is not cached.
  private async resolve(chainId: number, assetKey: string, contract: string | null, assetType: string, date: string): Promise<string | null> {
    try {
      const cached = await this.cache.get(chainId, assetKey, date);
      if (cached !== null && isFinitePositive(cached)) return cached;
      const looked = await this.oracle.priceAt(chainId, contract, assetType, date);
      if (looked !== null && looked.status === "UNLISTED") {
        this.rememberUnlisted(chainId, assetKey);
        return null;
      }
      if (looked === null || !isFinitePositive(looked.krw)) return null; // never cache poison
      await this.cache.put({ chainId, assetKey, date, krw: looked.krw });
      // Consume the CANONICAL persisted close: under a concurrent miss ON CONFLICT DO NOTHING
      // keeps one winner and re-reading it makes every caller apply the same value.
      const canonical = await this.cache.get(chainId, assetKey, date);
      return canonical !== null && isFinitePositive(canonical) ? canonical : looked.krw;
    } catch (error) {
      this.logger.warn(`Historical price resolve failed for ${chainId}:${assetKey}@${date}: ${(error as Error).message}`);
      return null;
    }
  }

  private isUnlisted(chainId: number, assetKey: string): boolean {
    const expiresAt = this.unlisted.get(`${chainId}:${assetKey}`);
    if (expiresAt === undefined) return false;
    if (expiresAt > Date.now()) return true;
    this.unlisted.delete(`${chainId}:${assetKey}`);
    return false;
  }

  private rememberUnlisted(chainId: number, assetKey: string): void {
    if (this.unlisted.size >= UNLISTED_MAX_ENTRIES) {
      const oldest = this.unlisted.keys().next().value;
      if (oldest !== undefined) this.unlisted.delete(oldest);
    }
    this.unlisted.set(`${chainId}:${assetKey}`, Date.now() + UNLISTED_TTL_MS);
  }

  private quantityOf(payload: Record<string, unknown>): Decimal | null {
    const raw = payload.raw_amount;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const decimals = Number(payload.decimals ?? 0);
    try {
      const amount = new Decimal(raw);
      if (!amount.isFinite()) return null; // reject NaN/Infinity from a malformed raw_amount
      return Number.isFinite(decimals) && decimals > 0 ? amount.div(Decimal.pow(10, decimals)) : amount;
    } catch {
      return null;
    }
  }

  private dateOf(value: unknown): string | null {
    return utcDayOf(value);
  }
}

// Reduce a timestamp to its UTC calendar day. Two-step, so it both rejects impossible
// dates AND preserves timezone semantics:
//   1. the leading YYYY-MM-DD prefix must be a real calendar day (dayWindow round-trip),
//      so 2025-02-30T12:00:00Z is rejected instead of normalized into March;
//   2. the FULL string must still parse to a real instant (rejects trailing garbage),
//      and the returned day is that instant's UTC day, so an offset like +09:00 maps to
//      the correct UTC date rather than the raw local prefix.
//
// Exported because the native-price backfill must bucket stored rows into exactly the
// same days the sync-time warming used; two implementations would drift and re-fetch.
export function utcDayOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value === "string") {
    const trimmed = value.trim();
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
    if (!match || dayWindow(match[1]) === null) return null;
    const ms = Date.parse(trimmed);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}
