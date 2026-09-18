import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CHAIN_REGISTRY, type ChainRegistryEntry } from "../indexer/chain-registry";
import type { BalanceReader, BalanceSnapshot, TokenBalance } from "./balance.reader";

/** 체인 동시 조회 수. 인덱서(CHAIN_CONCURRENCY)와 같은 이유로 묶는다 — 5개를 한꺼번에 때리면 429를 부른다. */
const CHAIN_CONCURRENCY = 3;
/**
 * 체인당 ERC-20 상한. `alchemy_getTokenBalances`는 **한 번이라도 스친** 토큰을 전부 돌려주므로
 * 에어드랍 스팸이 수백 개씩 섞인다. 토큰마다 메타데이터 1회 + 시세 1회가 붙어 비용이 선형으로 늘어난다.
 * 잘린 체인은 화면에 그 사실을 알린다 — 조용히 자르면 "내 토큰이 없어졌다"가 된다.
 */
const MAX_TOKENS_PER_CHAIN = 60;

interface TokenBalanceEntry {
  contractAddress?: unknown;
  tokenBalance?: unknown;
}

interface TokenMetadata {
  symbol?: unknown;
  name?: unknown;
  decimals?: unknown;
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]);
  });
  await Promise.all(runners);
  return results;
}

/** 0x-hex 정수를 bigint로. 형식이 어긋나면 null — 0으로 뭉개면 "잔액 없음"이라는 거짓말이 된다. */
function parseHexQuantity(raw: unknown): bigint | null {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) return null;
  return raw === "0x" ? BigInt(0) : BigInt(raw);
}

/** 최소 단위 정수를 사람이 읽는 십진 문자열로. Number를 거치지 않아 2^53 밖에서도 값이 안 바뀐다. */
export function formatUnits(value: bigint, decimals: number): string {
  if (decimals <= 0) return value.toString();
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

@Injectable()
export class AlchemyBalanceReader implements BalanceReader {
  private readonly logger = new Logger(AlchemyBalanceReader.name);

  constructor(private readonly config: ConfigService) {}

  async read(address: string): Promise<BalanceSnapshot> {
    const apiKey = this.config.get<string>("ALCHEMY_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("Alchemy balance reader requires ALCHEMY_API_KEY.");

    type Outcome =
      | { entry: ChainRegistryEntry; balances: TokenBalance[]; truncated: boolean }
      | { entry: ChainRegistryEntry; error: Error };

    const outcomes = await mapWithConcurrency<ChainRegistryEntry, Outcome>(CHAIN_REGISTRY, CHAIN_CONCURRENCY, async (entry) => {
      try {
        const url = `https://${entry.network}.g.alchemy.com/v2/${apiKey}`;
        const [native, tokens] = await Promise.all([this.readNative(entry, url, address), this.readTokens(entry, url, address)]);
        return { entry, balances: [...native, ...tokens.balances], truncated: tokens.truncated };
      } catch (error) {
        return { entry, error: error as Error };
      }
    });

    const balances: TokenBalance[] = [];
    const skippedChainIds: number[] = [];
    const truncatedChainIds: number[] = [];
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        skippedChainIds.push(outcome.entry.chainId);
        this.logger.warn(`Skipping balances for chain ${outcome.entry.chainId} (${outcome.entry.network}): ${outcome.error.message}`);
        continue;
      }
      balances.push(...outcome.balances);
      if (outcome.truncated) truncatedChainIds.push(outcome.entry.chainId);
    }

    // 전 체인 실패를 "잔액 0"으로 내려보내면 화면이 빈 지갑을 그린다. 인덱서와 같은 경계다.
    if (skippedChainIds.length === CHAIN_REGISTRY.length) {
      throw new ServiceUnavailableException(`Alchemy balance read observed no chain; ${skippedChainIds.length} chain(s) unavailable.`);
    }
    return { balances, skippedChainIds, truncatedChainIds };
  }

  private async readNative(entry: ChainRegistryEntry, url: string, address: string): Promise<TokenBalance[]> {
    const raw = await this.rpc(entry, url, "eth_getBalance", [address, "latest"]);
    const value = parseHexQuantity(raw);
    if (value === null) throw new Error(`${entry.network} malformed eth_getBalance ${String(raw)}`);
    if (value === BigInt(0)) return [];
    return [{
      chainId: entry.chainId,
      contract: null,
      symbol: entry.nativeSymbol,
      name: entry.nativeSymbol,
      decimals: entry.nativeDecimals,
      amount: formatUnits(value, entry.nativeDecimals),
    }];
  }

  private async readTokens(entry: ChainRegistryEntry, url: string, address: string): Promise<{ balances: TokenBalance[]; truncated: boolean }> {
    const result = await this.rpc(entry, url, "alchemy_getTokenBalances", [address, "erc20"]);
    const entries = (result as { tokenBalances?: unknown })?.tokenBalances;
    if (!Array.isArray(entries)) throw new Error(`${entry.network} malformed getTokenBalances: tokenBalances not an array`);

    const nonZero: { contract: string; value: bigint }[] = [];
    for (const item of entries as TokenBalanceEntry[]) {
      const contract = typeof item?.contractAddress === "string" ? item.contractAddress : null;
      const value = parseHexQuantity(item?.tokenBalance);
      // 개별 항목의 형식 오류는 그 토큰만 버린다 — 하나 때문에 체인 전체를 날리면 나머지 잔액까지 사라진다.
      if (!contract || value === null || value === BigInt(0)) continue;
      nonZero.push({ contract, value });
    }

    const truncated = nonZero.length > MAX_TOKENS_PER_CHAIN;
    const selected = truncated ? nonZero.slice(0, MAX_TOKENS_PER_CHAIN) : nonZero;

    const balances = await mapWithConcurrency<{ contract: string; value: bigint }, TokenBalance | null>(selected, CHAIN_CONCURRENCY, async ({ contract, value }) => {
      const metadata = (await this.rpc(entry, url, "alchemy_getTokenMetadata", [contract])) as TokenMetadata | null;
      const decimals = typeof metadata?.decimals === "number" && Number.isInteger(metadata.decimals) && metadata.decimals >= 0 && metadata.decimals <= 36 ? metadata.decimals : null;
      const symbol = typeof metadata?.symbol === "string" && metadata.symbol.trim() ? metadata.symbol.trim() : null;
      // decimals를 모르면 수량 자체를 만들 수 없다. 18로 가정하면 자릿수가 틀린 숫자를 사실처럼 보여주게 된다.
      if (decimals === null || symbol === null) return null;
      return {
        chainId: entry.chainId,
        contract,
        symbol,
        name: typeof metadata?.name === "string" && metadata.name.trim() ? metadata.name.trim() : symbol,
        decimals,
        amount: formatUnits(value, decimals),
      };
    });

    return { balances: balances.filter((item): item is TokenBalance => item !== null), truncated };
  }

  /** JSON-RPC 1회. 인덱서의 rpcPost와 달리 재시도를 두지 않는다 — 잔액은 화면 요청당 즉시 응답이 목적이고, 실패한 체인은 위에서 건너뛴다. */
  private async rpc(entry: ChainRegistryEntry, url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${entry.network} ${method} HTTP ${response.status}`);
    const body = (await response.json()) as { error?: { message?: string }; result?: unknown };
    if (body?.error) throw new Error(`${entry.network} ${method} RPC error: ${body.error.message ?? "unknown"}`);
    return body?.result;
  }
}

/** MOCK_MODE용. 고정 잔액을 돌려준다 — 화면 계약을 키 없이 돌려보기 위한 것이다. */
@Injectable()
export class MockBalanceReader implements BalanceReader {
  async read(): Promise<BalanceSnapshot> {
    return {
      balances: [
        { chainId: 1, contract: null, symbol: "ETH", name: "ETH", decimals: 18, amount: "0.75" },
        { chainId: 137, contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", name: "Tether USD", decimals: 6, amount: "850" },
        { chainId: 8453, contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6, amount: "500" },
      ],
      skippedChainIds: [],
      truncatedChainIds: [],
    };
  }
}
