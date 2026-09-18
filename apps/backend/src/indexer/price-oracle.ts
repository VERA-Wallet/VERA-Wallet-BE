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
      });
      if (!response.ok) return null; // transient/unknown, never a confirmed no-market
      const body = (await response.json()) as { pairs?: unknown };
      return summarizeMarket(body.pairs, slug, contract);
    } catch (error) {
      this.logger.warn(`DexScreener lookup failed for ${chainId}:${contract}: ${(error as Error).message}`);
      return null;
    }
  }
}

// A 200 response with `pairs: null` / `[]` is a CONFIRMED no-market (pairCount 0),
// distinct from the adapter's `null` (lookup failed). Kept pure for direct testing.
//
// `priceUsd` is only read from pairs where the QUERIED token is the pair's baseToken.
// DexScreener's `priceUsd` is always the BASE token's price, and /tokens/{address}
// returns every pair the address appears in — including the ones where it is the
// quote side. Without this filter, asking for USDC on Base returned the deepest pair
// (AERO/USDC, $36M liquidity) and reported AERO's $0.6287 as USDC's price. Quote-heavy
// assets (stablecoins, WETH) were the ones getting it wrong, which is exactly the set
// whose price matters most.
//
// `liquidityUsd` and `pairCount` intentionally stay over ALL on-chain pairs: they answer
// "does this token trade anywhere", which the spam filter relies on, and a token quoted
// against others still trades. Narrowing them would silently reclassify holdings as dust.
export function summarizeMarket(pairs: unknown, chainSlug: string, contract: string): TokenMarket {
  const list = Array.isArray(pairs) ? pairs : [];
  const onChain = list.filter(
    (pair): pair is Record<string, unknown> => typeof pair === "object" && pair !== null && (pair as { chainId?: unknown }).chainId === chainSlug,
  );
  const wanted = contract.toLowerCase();
  let liquidityUsd = 0;
  let priceUsd: string | null = null;
  let bestLiquidity = -1;
  for (const pair of onChain) {
    const liquidity = Number((pair.liquidity as { usd?: unknown } | undefined)?.usd) || 0;
    if (liquidity > liquidityUsd) liquidityUsd = liquidity;
    const base = (pair.baseToken as { address?: unknown } | undefined)?.address;
    if (typeof base !== "string" || base.toLowerCase() !== wanted) continue;
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
  async lookup(): Promise<TokenMarket | null> {
    return null;
  }
}
