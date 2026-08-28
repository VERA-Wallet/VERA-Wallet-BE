import { Inject, Injectable, Logger } from "@nestjs/common";
import type { IndexedTransaction } from "@vera/interfaces";
import { PRICE_ORACLE } from "./indexer.tokens";
import type { PriceOracle, TokenMarket } from "./price-oracle";

export type MarketVerdict = "no_market" | "illiquid" | "priced";

// Interpret a CONFIRMED market snapshot. A token with zero DEX pairs has no market
// at all and, for an inbound-only receive, is dust/airdrop spam. A token that has a
// pair but no usable price is illiquid (kept visible, but never a tax basis).
export function marketVerdict(market: TokenMarket): MarketVerdict {
  if (market.pairCount === 0) return "no_market";
  if (market.priceUsd === null) return "illiquid";
  return "priced";
}

// Best-effort market enrichment run between provider fetch and persistence.
//
// Two jobs, both grounded in the same DexScreener snapshot:
//  1. Dust gate — an inbound-only ERC20 RECEIVE with NO on-chain market is retagged
//     SPAM. This catches clean-ticker dust (random symbols with a real-looking name
//     but zero liquidity) that the symbol/asset-type heuristic cannot.
//  2. Price visibility — every ERC20 leg gets informational `market_price_usd` /
//     `market_liquidity_usd`. These are CURRENT spot values for display only; they
//     are intentionally NOT written to the tax basis (`fiat_value`/`price_status`),
//     which requires historical price + FX and is a separate concern.
@Injectable()
export class PriceEnrichmentService {
  private readonly logger = new Logger(PriceEnrichmentService.name);

  constructor(@Inject(PRICE_ORACLE) private readonly oracle: PriceOracle) {}

  async enrich(transactions: IndexedTransaction[]): Promise<void> {
    const cache = new Map<string, TokenMarket | null>();
    for (const transaction of transactions) {
      const payload = transaction.payload;
      if (payload.asset_type !== "ERC20") continue;
      if (payload.classification === "SPAM") continue; // already dust by heuristic
      const contract = typeof payload.asset_contract === "string" ? payload.asset_contract : null;
      if (!contract) continue;

      const chainId = Number(payload.chain_id);
      const key = `${chainId}:${contract.toLowerCase()}`;
      let market = cache.get(key);
      if (market === undefined) {
        market = await this.safeLookup(chainId, contract);
        cache.set(key, market);
      }
      if (market === null) continue; // UNKNOWN — never downgrade on a failed lookup

      payload.market_price_usd = market.priceUsd;
      payload.market_liquidity_usd = market.liquidityUsd;
      // The dust gate applies ONLY to a pure-inbound receive (spam-filter.ts invariant): a group
      // the wallet never touched on the OUT side. A grouped swap acquisition (IN leg of a swap,
      // carries group_id) is the received side of a trade the wallet actively made, never
      // unsolicited dust -- retagging it SPAM would drop it (FE filters SPAM) and lose the swap's
      // cost basis. Exempt any grouped leg from the dust gate.
      if (payload.classification === "RECEIVE" && !payload.group_id && marketVerdict(market) === "no_market") {
        payload.classification = "SPAM";
        payload.confidence = 0;
      }
    }
  }

  private async safeLookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    try {
      return await this.oracle.lookup(chainId, contract);
    } catch (error) {
      this.logger.warn(`Price enrichment lookup threw for ${chainId}:${contract}: ${(error as Error).message}`);
      return null;
    }
  }
}
