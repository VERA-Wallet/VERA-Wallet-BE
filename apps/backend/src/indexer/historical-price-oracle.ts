import { Injectable, Logger } from "@nestjs/common";

// Historical (tax-basis) price for an asset on a specific UTC day, quoted directly
// in KRW. This is a SEPARATE concern from the DexScreener spot oracle (price-oracle.ts):
// that one is a display-only CURRENT price, this one is the historical basis that
// feeds fiat_value / price_status and, downstream, cost-basis P/L.
//
// CRITICAL correctness boundary (mirrors price-oracle.ts): a `null` return means the
// price could NOT be resolved (unsupported chain/asset, network/HTTP/parse failure) —
// the basis stays UNKNOWN and MUST NEVER be coerced to 0 or treated as spam.
export type HistoricalPrice = { krw: string; status: "RESOLVED" };
// The provider positively does not know this asset (404). Unlike a transient null this is a
// durable fact for the asset (not just the day), so callers may stop asking for a while.
export type HistoricalPriceUnlisted = { status: "UNLISTED" };
export type HistoricalLookup = HistoricalPrice | HistoricalPriceUnlisted | null;

export interface HistoricalPriceOracle {
  // `date` is a UTC calendar day, YYYY-MM-DD. `contract` is null for the native coin.
  priceAt(chainId: number, contract: string | null, assetType: string, date: string): Promise<HistoricalLookup>;
}

// chainId -> CoinGecko ids. `platform` addresses ERC20 contracts on that chain;
// `nativeCoinId` prices the chain's native coin (contract === null).
type ChainCoingecko = { platform: string; nativeCoinId: string };
const CHAIN_COINGECKO: Record<number, ChainCoingecko> = {
  1: { platform: "ethereum", nativeCoinId: "ethereum" },
  8453: { platform: "base", nativeCoinId: "ethereum" },
  42161: { platform: "arbitrum-one", nativeCoinId: "ethereum" },
  10: { platform: "optimistic-ethereum", nativeCoinId: "ethereum" },
  137: { platform: "polygon-pos", nativeCoinId: "matic-network" },
};

// Live oracle backed by the CoinGecko market_chart/range endpoint (KRW quote), Demo tier.
// One day window; the daily close is the last point inside the day.
//
// Requires a free CoinGecko Demo API key (`x-cg-demo-api-key`). Without a key the endpoint
// is skipped entirely: the keyless public tier is now unreliable (401/429) and hammering
// it would only produce UNKNOWN with wasted latency, so no key -> immediate UNKNOWN.
// The Demo tier answers 401 "exceeds the allowed time range" for anything older than this many days.
// Asking anyway burns quota on every resync for every (asset, day) pair outside the window — a wallet with
// 2021-2024 history re-asks ~800 times per sync for answers that are known to be denied.
export const DEMO_HISTORY_WINDOW_DAYS = 365;

@Injectable()
export class CoinGeckoHistoricalPriceOracle implements HistoricalPriceOracle {
  private readonly logger = new Logger(CoinGeckoHistoricalPriceOracle.name);
  private readonly base = "https://api.coingecko.com/api/v3";
  private warnedOutOfRange = false;

  /**
   * @param historyWindowDays how far back the plan may query. 0 = unlimited. Dates outside the window are
   *   UNKNOWN without a request. The module factory passes COINGECKO_HISTORY_DAYS (Demo default 365); direct
   *   construction defaults to unlimited so specs that pin fixed past dates keep exercising the request path.
   * @param now injectable clock for tests.
   */
  constructor(
    private readonly apiKey: string | null = null,
    private readonly historyWindowDays: number = 0,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async priceAt(chainId: number, contract: string | null, assetType: string, date: string): Promise<HistoricalLookup> {
    // No Demo key configured -> the tax basis stays UNKNOWN (never a fabricated 0).
    if (!this.apiKey) return null;
    if (this.outsideHistoryWindow(date)) {
      if (!this.warnedOutOfRange) {
        this.warnedOutOfRange = true;
        this.logger.warn(`CoinGecko plan window is ${this.historyWindowDays} days; older days (e.g. ${date}) stay UNKNOWN without a request. Set COINGECKO_HISTORY_DAYS=0 on a paid plan.`);
      }
      return null;
    }
    // Whitelist: only the native coin (null contract) or an ERC20 with a real contract is
    // fungibly priceable. NFTs and any other/unknown kind are UNKNOWN (null), never routed
    // to a mismatched endpoint.
    const endpoint = endpointKind(assetType, contract);
    if (endpoint === null) return null;
    const chain = CHAIN_COINGECKO[chainId];
    if (!chain) return null;
    const window = dayWindow(date);
    if (!window) return null;

    const path =
      endpoint === "native"
        ? `${this.base}/coins/${chain.nativeCoinId}/market_chart/range`
        : `${this.base}/coins/${chain.platform}/contract/${contract!.toLowerCase()}/market_chart/range`;
    const url = `${path}?vs_currency=krw&from=${window.from}&to=${window.to}`;

    try {
      const response = await fetch(url, { headers: { accept: "application/json", "x-cg-demo-api-key": this.apiKey } });
      // 404 = CoinGecko has no listing for this contract/coin at all. Long-tail and airdrop tokens hit this on
      // every (asset, day) pair; surfacing it lets the enrichment stop re-asking for the same asset each sync.
      if (response.status === 404) return { status: "UNLISTED" };
      if (!response.ok) return null; // transient (429/5xx), never a confirmed zero
      const body = (await response.json()) as { prices?: unknown };
      const krw = summarizeDailyClose(body.prices, window.from, window.to);
      return krw === null ? null : { krw, status: "RESOLVED" };
    } catch (error) {
      this.logger.warn(`CoinGecko historical lookup failed for ${chainId}:${contract ?? "native"}@${date}: ${(error as Error).message}`);
      return null;
    }
  }

  private outsideHistoryWindow(date: string): boolean {
    if (!(this.historyWindowDays > 0)) return false;
    const window = dayWindow(date);
    if (!window) return false; // malformed dates are rejected by the caller's own dayWindow check
    const oldestAllowedSec = Math.floor(this.now().getTime() / 1000) - this.historyWindowDays * 86_400;
    return window.to <= oldestAllowedSec;
  }
}


// "NATIVE + null contract" -> native coin endpoint; "ERC20 + non-empty contract" ->
// contract endpoint; everything else (NFT, unknown kind, NATIVE-with-contract, ERC20
// without contract) is unpriceable here.
export function endpointKind(assetType: string, contract: string | null): "native" | "contract" | null {
  if (assetType === "NATIVE") return contract === null ? "native" : null;
  if (assetType === "ERC20") return typeof contract === "string" && contract.trim().length > 0 ? "contract" : null;
  return null;
}

// [from, to) unix-second bounds for a UTC calendar day. Rejects malformed AND
// impossible calendar dates (e.g. 2025-02-30) by requiring an exact UTC round-trip,
// so Date.parse normalization can never price an event on the wrong day.
export function dayWindow(date: string): { from: number; to: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, y, m, d] = match;
  const start = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const round = new Date(start);
  if (round.getUTCFullYear() !== Number(y) || round.getUTCMonth() + 1 !== Number(m) || round.getUTCDate() !== Number(d)) return null;
  const from = Math.floor(start / 1000);
  return { from, to: from + 86400 };
}

// Daily close = the last price point whose timestamp falls inside [fromSec, toSec).
// CoinGecko `prices` is [[msTimestamp, price], ...]. A 200 with no in-window point
// is a real "no data" -> null (distinct from the adapter's transport-failure null).
export function summarizeDailyClose(prices: unknown, fromSec: number, toSec: number): string | null {
  if (!Array.isArray(prices)) return null;
  const fromMs = fromSec * 1000;
  const toMs = toSec * 1000;
  let bestTs = -1;
  let close: string | null = null;
  for (const point of prices) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const ts = Number(point[0]);
    const price = point[1];
    if (!Number.isFinite(ts) || ts < fromMs || ts >= toMs) continue;
    // Reject non-numeric, non-finite, and non-positive closes (a KRW price is always > 0).
    const numeric = typeof price === "number" || (typeof price === "string" && price.trim().length > 0) ? Number(price) : Number.NaN;
    if (ts > bestTs && Number.isFinite(numeric) && numeric > 0) {
      bestTs = ts;
      close = String(price);
    }
  }
  return close;
}

// Test/offline oracle: every lookup is UNKNOWN, so the mock sync path never fills a
// basis and never touches the network.
@Injectable()
export class MockHistoricalPriceOracle implements HistoricalPriceOracle {
  async priceAt(): Promise<HistoricalLookup> {
    return null;
  }
}
