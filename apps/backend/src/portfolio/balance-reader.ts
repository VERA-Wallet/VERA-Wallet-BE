/**
 * Live on-chain balance source for the portfolio read path.
 *
 * Balances are a *present-state* fact, not a ledger fact: they come straight from the node
 * (`eth_getBalance`, `alchemy_getTokenBalances`) and are never persisted. The ledger (indexed
 * events) is joined on later for symbol/decimals and cost basis — see holdings.service.ts.
 */

export interface TokenBalance {
  /** Lowercased ERC20 contract address. */
  contract: string;
  /** Raw integer balance in the token's smallest unit. Always > 0: zero rows are dropped at the source. */
  rawBalance: bigint;
}

export interface ChainBalances {
  chainId: number;
  /** Native coin balance in wei (18 decimals on every supported chain). */
  nativeRaw: bigint;
  tokens: TokenBalance[];
}

export interface BalanceSnapshot {
  chains: ChainBalances[];
  /**
   * Chains that could not be read this pass (provider outage, rate limit exhausted, malformed
   * reply). Absent from `chains` rather than reported empty: "we do not know" must never render
   * as "you hold nothing here".
   */
  skippedChainIds: number[];
  /** Chains whose ERC20 list hit the page cap; the rows returned are real but not the whole wallet. */
  truncatedChainIds: number[];
}

export interface TokenMetadata {
  symbol: string;
  name: string;
  decimals: number;
}

export interface BalanceReader {
  /** Every supported chain for one address. Throws only when NO chain could be observed. */
  readBalances(address: string): Promise<BalanceSnapshot>;
  /**
   * Symbol/name/decimals straight from the provider. Two outcomes are deliberately distinct:
   * `null` = the provider answered and knows nothing usable (no symbol / no decimals);
   * a thrown error = the lookup itself failed (HTTP, RPC, timeout). The caller must never turn
   * a failure into "no such asset".
   */
  readTokenMetadata(chainId: number, contract: string): Promise<TokenMetadata | null>;
}
