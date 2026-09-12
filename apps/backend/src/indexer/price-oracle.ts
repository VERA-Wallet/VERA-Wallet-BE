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
