// Pure framework-free port: a daily-close price cache keyed by (chain, asset, day).
// The cache makes the tax-basis oracle idempotent per (asset, date) so a resync of
// many events sharing an asset+day costs exactly one external lookup.
export type HistoricalPriceRecord = {
  chainId: number;
  assetKey: string; // "native" or the lowercased ERC20 contract
  date: string; // UTC calendar day, YYYY-MM-DD
  krw: string; // daily close, KRW per one whole token
};

// The (chain, asset, day) coordinate of one cached close, without the price itself.
export type HistoricalPriceKey = Pick<HistoricalPriceRecord, "chainId" | "assetKey" | "date">;

// Canonical string form of a key, and the map key returned by `getMany`, so callers
// never have to reimplement the joining rule.
export function historicalPriceKey(key: HistoricalPriceKey): string {
  return `${key.chainId}:${key.assetKey}:${key.date}`;
}

export interface HistoricalPriceRepository {
  // Cached KRW close for the key, or null on a cache miss.
  get(chainId: number, assetKey: string, date: string): Promise<string | null>;
  // Bulk cache probe. Returns ONLY the keys that are present, mapped by
  // `${chainId}:${assetKey}:${date}`; a missing key is simply absent from the map.
  // Exists so a batch job (the native-price backfill) can decide what to look up in a
  // few round trips instead of one `get` per candidate.
  getMany(keys: readonly HistoricalPriceKey[]): Promise<Map<string, string>>;
  // Idempotent upsert; a second write for the same key must not throw.
  put(record: HistoricalPriceRecord): Promise<void>;
}
