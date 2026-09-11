import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CHAIN_REGISTRY, type ChainRegistryEntry } from "../indexer/chain-registry";
import type { BalanceReader, BalanceSnapshot, ChainBalances, TokenBalance, TokenMetadata } from "./balance-reader";

// Same bounded fan-out as the indexer adapter (indexer.adapters.ts CHAIN_CONCURRENCY): the compute-unit
// budget is shared across every network host on one key.
const CHAIN_CONCURRENCY = 3;
// `alchemy_getTokenBalances` pages at 100 contracts. A wallet with >2,000 distinct ERC20s is spam-bombed;
// past this point the rest is dropped and the chain is reported as truncated in the log, not withheld.
const MAX_TOKEN_PAGES = 20;
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;
// This path serves a user-facing GET, unlike the indexer's background sync: a provider-sent
// Retry-After of minutes must not park the request, and a hung socket must not hang the memoized read.
const MAX_RETRY_DELAY_MS = 3_000;
const REQUEST_TIMEOUT_MS = 8_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Strict 0x-hex quantity → bigint. Anything else (decimal, trailing junk, null) is a malformed reply:
// the caller withholds the chain instead of coercing (a coerced "0" would render as an empty wallet).
export function parseHexBalance(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  return BigInt(raw);
}

// ---------------------------------------------------------------------------
// Mock reader — the demo wallet the FE used to hard-code, now served from here so mock mode keeps a
// populated portfolio while the read path is the real one end to end.
// ---------------------------------------------------------------------------

const DEMO_USDT_POLYGON = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"; // USDT (PoS) — same constant as spam-filter.ts CONTRACT_ALLOWLIST
const DEMO_USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

const DEMO_METADATA: Record<string, TokenMetadata> = {
  [`137:${DEMO_USDT_POLYGON}`]: { symbol: "USDT", name: "Tether USD", decimals: 6 },
  [`8453:${DEMO_USDC_BASE}`]: { symbol: "USDC", name: "USD Coin", decimals: 6 },
};

@Injectable()
export class MockBalanceReader implements BalanceReader {
  async readBalances(_address: string): Promise<BalanceSnapshot> {
    return {
      chains: [
        { chainId: 1, nativeRaw: 750_000_000_000_000_000n, tokens: [] }, // 0.75 ETH
        { chainId: 8453, nativeRaw: 0n, tokens: [{ contract: DEMO_USDC_BASE, rawBalance: 500_000_000n }] }, // 500 USDC
        { chainId: 42161, nativeRaw: 0n, tokens: [] },
        { chainId: 10, nativeRaw: 0n, tokens: [] },
        { chainId: 137, nativeRaw: 0n, tokens: [{ contract: DEMO_USDT_POLYGON, rawBalance: 850_000_000n }] }, // 850 USDT
      ],
      skippedChainIds: [],
      truncatedChainIds: [],
    };
  }

  async readTokenMetadata(chainId: number, contract: string): Promise<TokenMetadata | null> {
    const hit = DEMO_METADATA[`${chainId}:${contract.toLowerCase()}`];
    return hit ? { ...hit } : null;
  }
}

// ---------------------------------------------------------------------------
// Alchemy reader
// ---------------------------------------------------------------------------

interface RpcBody {
  error?: { code?: number; message?: string };
  result?: unknown;
}

@Injectable()
export class AlchemyBalanceReader implements BalanceReader {
  private readonly logger = new Logger(AlchemyBalanceReader.name);

  constructor(private readonly config: ConfigService) {}

  async readBalances(address: string): Promise<BalanceSnapshot> {
    const apiKey = this.requireApiKey();
    const wallet = address.toLowerCase();

    type Outcome = { entry: ChainRegistryEntry; balances: ChainBalances; truncated: boolean } | { entry: ChainRegistryEntry; error: Error };
    const outcomes = await mapWithConcurrency<ChainRegistryEntry, Outcome>(CHAIN_REGISTRY, CHAIN_CONCURRENCY, async (entry) => {
      try {
        const url = this.urlFor(entry, apiKey);
        const nativeRaw = await this.fetchNativeBalance(entry, url, wallet);
        const { tokens, truncated } = await this.fetchTokenBalances(entry, url, wallet);
        return { entry, balances: { chainId: entry.chainId, nativeRaw, tokens }, truncated };
      } catch (error) {
        return { entry, error: error as Error };
      }
    });

    const chains: ChainBalances[] = [];
    const skippedChainIds: number[] = [];
    const truncatedChainIds: number[] = [];
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        skippedChainIds.push(outcome.entry.chainId);
        this.logger.warn(`Skipping balances on chain ${outcome.entry.chainId} (${outcome.entry.network}): ${outcome.error.message}`);
        continue;
      }
      chains.push(outcome.balances);
      if (outcome.truncated) truncatedChainIds.push(outcome.entry.chainId);
    }
    // Same truthful-empty boundary as the indexer: no observed chain is an outage, never an empty wallet.
    if (chains.length === 0) throw new ServiceUnavailableException(`Balance read observed no chain; ${skippedChainIds.length} chain(s) unavailable.`);
    return { chains, skippedChainIds, truncatedChainIds };
  }

  // Failures propagate (see the port's contract): the caller decides between a ledger fallback and an
  // "unresolved" count. Only a provider that answered with nothing usable yields `null`.
  async readTokenMetadata(chainId: number, contract: string): Promise<TokenMetadata | null> {
    const entry = CHAIN_REGISTRY.find((candidate) => candidate.chainId === chainId);
    if (!entry) return null;
    const url = this.urlFor(entry, this.requireApiKey());
    const result = await this.rpcResult(entry, url, "alchemy_getTokenMetadata", [contract]);
    const meta = (result ?? {}) as { symbol?: unknown; name?: unknown; decimals?: unknown };
    const symbol = typeof meta.symbol === "string" ? meta.symbol.trim() : "";
    const decimals = typeof meta.decimals === "number" && Number.isInteger(meta.decimals) && meta.decimals >= 0 && meta.decimals <= 36 ? meta.decimals : null;
    // A token with no symbol or no decimals cannot be rendered or scaled; treat as unknown rather than guess 18.
    if (!symbol || decimals === null) return null;
    return { symbol, name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : symbol, decimals };
  }

  private requireApiKey(): string {
    const apiKey = this.config.get<string>("ALCHEMY_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("Alchemy balance reader requires ALCHEMY_API_KEY.");
    return apiKey;
  }

  private urlFor(entry: ChainRegistryEntry, apiKey: string): string {
    return `https://${entry.network}.g.alchemy.com/v2/${apiKey}`;
  }

  private async fetchNativeBalance(entry: ChainRegistryEntry, url: string, wallet: string): Promise<bigint> {
    const result = await this.rpcResult(entry, url, "eth_getBalance", [wallet, "latest"]);
    const balance = parseHexBalance(result);
    if (balance === null) throw new Error(`${entry.network} malformed native balance ${String(result)}`);
    return balance;
  }

  private async fetchTokenBalances(entry: ChainRegistryEntry, url: string, wallet: string): Promise<{ tokens: TokenBalance[]; truncated: boolean }> {
    const tokens: TokenBalance[] = [];
    let pageKey: string | undefined;
    for (let page = 0; page < MAX_TOKEN_PAGES; page += 1) {
      const params: unknown[] = pageKey ? [wallet, "erc20", { pageKey }] : [wallet, "erc20"];
      const result = (await this.rpcResult(entry, url, "alchemy_getTokenBalances", params)) as { tokenBalances?: unknown; pageKey?: unknown } | null;
      const rows = Array.isArray(result?.tokenBalances) ? (result!.tokenBalances as Array<Record<string, unknown>>) : null;
      if (rows === null) throw new Error(`${entry.network} malformed token balances`);
      for (const row of rows) {
        // A per-token `error` (reverting balanceOf, non-standard contract) is that token's problem, not the chain's.
        if (row.error) continue;
        const contract = typeof row.contractAddress === "string" ? row.contractAddress.toLowerCase() : null;
        const rawBalance = parseHexBalance(row.tokenBalance);
        if (!contract || rawBalance === null || rawBalance === 0n) continue;
        tokens.push({ contract, rawBalance });
      }
      pageKey = typeof result?.pageKey === "string" && result.pageKey ? result.pageKey : undefined;
      if (!pageKey) return { tokens, truncated: false };
    }
    this.logger.warn(`${entry.network} token balances truncated after ${MAX_TOKEN_PAGES} pages for ${wallet}`);
    return { tokens, truncated: true };
  }

  private async rpcResult(entry: ChainRegistryEntry, url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await this.rpcPost(url, { id: 1, jsonrpc: "2.0", method, params });
    if (!response.ok) throw new Error(`${entry.network} ${method} HTTP ${response.status}`);
    const body = (await response.json()) as RpcBody;
    if (body?.error) throw new Error(`${entry.network} ${method} RPC error: ${body.error.message ?? "unknown"}`);
    return body.result;
  }

  // 429 is the only status retried (Retry-After, else exponential backoff, both capped) — mirrors
  // AlchemyAdapter.rpcPost, duplicated rather than shared because that helper is private to the indexer's
  // chain-atomic contract and has no reason to cap (it runs in a background job).
  private async rpcPost(url: string, body: Record<string, unknown>): Promise<Response> {
    const configured = this.config.get<string>("ALCHEMY_RETRY_BASE_MS");
    const parsed = Number(configured);
    const baseDelay = configured !== undefined && Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_BASE_MS;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const delay = Math.min(MAX_RETRY_DELAY_MS, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : baseDelay * 2 ** attempt);
      this.logger.warn(`Alchemy rate limited (429); retry ${attempt + 1}/${RATE_LIMIT_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }
}
