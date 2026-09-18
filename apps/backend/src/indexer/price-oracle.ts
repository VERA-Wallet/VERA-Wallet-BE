import { Injectable, Logger } from "@nestjs/common";

// Market snapshot for a token contract on a specific chain.
//
// CRITICAL correctness boundary: a `null` return means the lookup could NOT be
// completed (network/HTTP/parse failure) — the market is UNKNOWN and the caller
// MUST NOT treat it as spam. A CONFIRMED absence of any market is a real
// `TokenMarket` with `pairCount === 0`. Conflating the two would let a transient
// DexScreener outage flag legitimate holdings as dust.
export interface TokenMarket {
  priceUsd: string | null; // current USD price of the deepest priced pair, or null
  liquidityUsd: number; // deepest on-chain pair liquidity in USD (0 when no market)
  pairCount: number; // number of DEX pairs for this token on this chain (0 => no market)
}

export interface PriceOracle {
  lookup(chainId: number, contract: string): Promise<TokenMarket | null>;
}

// Supported chain id -> DexScreener chain slug. A token address is chain-scoped,
// so pairs from other chains in the shared response are filtered out.
const DEX_CHAIN_SLUG: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
  10: "optimism",
  137: "polygon",
};

const DEXSCREENER_TIMEOUT_MS = 8_000;

// Live oracle backed by the public DexScreener token endpoint (no API key).
@Injectable()
export class DexScreenerPriceOracle implements PriceOracle {
  private readonly logger = new Logger(DexScreenerPriceOracle.name);

  async lookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    const slug = DEX_CHAIN_SLUG[chainId];
    if (!slug) return null;
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${contract}`, {
        headers: { accept: "application/json" },
        // A hung socket must not hang a read that awaits this lookup (the portfolio endpoint memoizes its promise).
        signal: AbortSignal.timeout(DEXSCREENER_TIMEOUT_MS),
      });
      if (!response.ok) return null; // transient/unknown, never a confirmed no-market
      const body = (await response.json()) as { pairs?: unknown };
      return summarizeMarket(body.pairs, slug);
    } catch (error) {
      this.logger.warn(`DexScreener lookup failed for ${chainId}:${contract}: ${(error as Error).message}`);
      return null;
    }
  }
}

// A 200 response with `pairs: null` / `[]` is a CONFIRMED no-market (pairCount 0),
// distinct from the adapter's `null` (lookup failed). Kept pure for direct testing.
export function summarizeMarket(pairs: unknown, chainSlug: string): TokenMarket {
  const list = Array.isArray(pairs) ? pairs : [];
  const onChain = list.filter(
    (pair): pair is Record<string, unknown> => typeof pair === "object" && pair !== null && (pair as { chainId?: unknown }).chainId === chainSlug,
  );
  let liquidityUsd = 0;
  let priceUsd: string | null = null;
  let bestLiquidity = -1;
  for (const pair of onChain) {
    const liquidity = Number((pair.liquidity as { usd?: unknown } | undefined)?.usd) || 0;
    if (liquidity > liquidityUsd) liquidityUsd = liquidity;
    const price = pair.priceUsd;
    if (liquidity > bestLiquidity && typeof price === "string") {
      bestLiquidity = liquidity;
      priceUsd = price;
    }
  }
  return { priceUsd, liquidityUsd, pairCount: onChain.length };
}

// Supported chain id -> CoinGecko asset platform id (same table as historical-price-oracle.ts).
const COINGECKO_PLATFORM: Record<number, string> = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum-one",
  10: "optimistic-ethereum",
  137: "polygon-pos",
};

const COINGECKO_TIMEOUT_MS = 8_000;

// Secondary spot oracle backed by CoinGecko `simple/token_price` (Demo key). Only asked when
// DexScreener could not answer, so its ~30 req/min budget is spent on failures, not on every asset.
//
// It can only ever say "priced" or UNKNOWN: CoinGecko not listing a contract says nothing about
// whether a DEX market exists, so an unlisted token is `null`, never a confirmed no-market.
// `pairCount` is 1 (a market is known to exist) and `liquidityUsd` is 0 (not reported by this source).
@Injectable()
export class CoinGeckoSpotPriceOracle implements PriceOracle {
  private readonly logger = new Logger(CoinGeckoSpotPriceOracle.name);

  // No key -> skipped entirely, same policy as the historical oracle (the keyless tier is 401/429).
  constructor(private readonly apiKey: string | null = null) {}

  async lookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    if (!this.apiKey) return null;
    const platform = COINGECKO_PLATFORM[chainId];
    if (!platform) return null;
    const address = contract.toLowerCase();
    try {
      const response = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/${platform}?contract_addresses=${address}&vs_currencies=usd&precision=full`, {
        headers: { accept: "application/json", "x-cg-demo-api-key": this.apiKey },
        signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as Record<string, { usd?: unknown } | undefined>;
      const usd = body[address]?.usd;
      if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
      return { priceUsd: String(usd), liquidityUsd: 0, pairCount: 1 };
    } catch (error) {
      this.logger.warn(`CoinGecko spot lookup failed for ${chainId}:${contract}: ${(error as Error).message}`);
      return null;
    }
  }
}

// Canonical USD stablecoin deployments, keyed `${chainId}:${lowercasedContract}`. Contract-keyed on
// purpose: a symbol is forgeable, so a token merely CALLED "USDT" never gets the $1 peg.
const USD_STABLE_CONTRACTS: ReadonlySet<string> = new Set([
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC ethereum
  "10:0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC optimism
  "137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", // USDC polygon
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC arbitrum
  "1:0xdac17f958d2ee523a2206206994597c13d831ec7", // USDT ethereum
  "10:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58", // USDT optimism
  "137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT polygon
  "8453:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", // USDT base
  "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", // USDT arbitrum
  "1:0x6b175474e89094c44da98b954eedeac495271d0f", // DAI ethereum
]);

export function isUsdStable(chainId: number, contract: string): boolean {
  return USD_STABLE_CONTRACTS.has(`${chainId}:${contract.toLowerCase()}`);
}

// The live PRICE_ORACLE: DexScreener -> CoinGecko -> $1 peg for canonical stables.
//
// A fallback is taken ONLY when the previous source returned `null` (429 / timeout / parse failure).
// A confirmed DexScreener answer — including a confirmed no-market — is final, so the dust gate in
// price-enrichment.service.ts keeps its meaning. The peg is display-only like every spot price here;
// the tax basis comes from the historical oracle and is untouched.
@Injectable()
export class FallbackPriceOracle implements PriceOracle {
  private readonly logger = new Logger(FallbackPriceOracle.name);

  constructor(
    private readonly primary: PriceOracle,
    private readonly secondary: PriceOracle,
  ) {}

  async lookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    const first = await this.primary.lookup(chainId, contract);
    if (first !== null) return first;
    const second = await this.secondary.lookup(chainId, contract);
    if (second !== null) return second;
    if (!isUsdStable(chainId, contract)) return null;
    this.logger.warn(`Both spot sources failed for stablecoin ${chainId}:${contract}; using the 1.00 USD peg.`);
    return { priceUsd: "1.00", liquidityUsd: 0, pairCount: 1 };
  }
}

// Test/offline oracle: every lookup is UNKNOWN, so the mock sync path never mutates
// classification and never touches the network.
@Injectable()
export class MockPriceOracle implements PriceOracle {
  // Demo markets for the assets the mock balance reader hands out (see portfolio/balance-reader.adapters.ts),
  // so the mock-mode portfolio has a value column. Everything else stays `null` (= lookup unavailable):
  // the enrichment gate must keep treating an unknown market as "not spam", and the indexer specs rely on it.
  async lookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    const market = MOCK_MARKETS[`${chainId}:${contract.toLowerCase()}`];
    return market ? { ...market } : null;
  }
}

const MOCK_MARKETS: Record<string, TokenMarket> = {
  "1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": { priceUsd: "3200.00", liquidityUsd: 500_000_000, pairCount: 40 }, // WETH (native ETH price)
  "137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f": { priceUsd: "1.00", liquidityUsd: 80_000_000, pairCount: 30 }, // USDT on Polygon
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { priceUsd: "1.00", liquidityUsd: 120_000_000, pairCount: 35 }, // USDC on Base
};
