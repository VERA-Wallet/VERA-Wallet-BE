import { Inject, Injectable, Logger } from "@nestjs/common";
import Decimal from "decimal.js";
import type { IndexedTransaction } from "@vera/interfaces";
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

  constructor(
    @Inject(HISTORICAL_PRICE_ORACLE) private readonly oracle: HistoricalPriceOracle,
    @Inject(HISTORICAL_PRICE_REPOSITORY) private readonly cache: HistoricalPriceRepository,
  ) {}

  async enrich(transactions: IndexedTransaction[]): Promise<void> {
    const memo = new Map<string, string | null>();
    for (const transaction of transactions) {
      const payload = transaction.payload;
      // Already-priced rows (e.g. the mock path) keep their basis untouched.
      if (payload.fiat_value !== null && payload.fiat_value !== undefined) continue;

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

      const chainId = Number(payload.chain_id);
      const date = this.dateOf(payload.block_timestamp ?? transaction.occurredAt);
      if (!date) continue;
      const assetKey = endpoint === "native" ? "native" : contract!.toLowerCase();
      const memoKey = `${chainId}:${assetKey}:${date}`;

      let unitKrw = memo.get(memoKey);
      if (unitKrw === undefined) {
        unitKrw = await this.resolveShared(memoKey, chainId, assetKey, contract, assetType, date);
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

  // Reduce a timestamp to its UTC calendar day. Two-step, so it both rejects impossible
  // dates AND preserves timezone semantics:
  //   1. the leading YYYY-MM-DD prefix must be a real calendar day (dayWindow round-trip),
  //      so 2025-02-30T12:00:00Z is rejected instead of normalized into March;
  //   2. the FULL string must still parse to a real instant (rejects trailing garbage),
  //      and the returned day is that instant's UTC day, so an offset like +09:00 maps to
  //      the correct UTC date rather than the raw local prefix.
  private dateOf(value: unknown): string | null {
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
}
