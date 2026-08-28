// Pure framework-free port: a daily-close price cache keyed by (chain, asset, day).
// The cache makes the tax-basis oracle idempotent per (asset, date) so a resync of
// many events sharing an asset+day costs exactly one external lookup.
export type HistoricalPriceRecord = {
  chainId: number;
  assetKey: string; // "native" or the lowercased ERC20 contract
  date: string; // UTC calendar day, YYYY-MM-DD
  krw: string; // daily close, KRW per one whole token
};

export interface HistoricalPriceRepository {
  // Cached KRW close for the key, or null on a cache miss.
  get(chainId: number, assetKey: string, date: string): Promise<string | null>;
  // Idempotent upsert; a second write for the same key must not throw.
  put(record: HistoricalPriceRecord): Promise<void>;
}
