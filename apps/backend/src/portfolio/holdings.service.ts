import { Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import Decimal from "decimal.js";
import { holdingAssetKey, type HoldingCostBasis } from "@vera/tax-engine";
import { CHAIN_REGISTRY, type ChainRegistryEntry } from "../indexer/chain-registry";
import type { CostBasisSnapshotPort } from "../indexer/cost-basis-snapshot.port";
import { COST_BASIS_SNAPSHOT, PRICE_ORACLE, TRANSACTION_AVAILABILITY } from "../indexer/indexer.tokens";
import { marketVerdict, type MarketVerdict } from "../indexer/price-enrichment.service";
import type { PriceOracle, TokenMarket } from "../indexer/price-oracle";
import { CONTRACT_ALLOWLIST, isInboundSpam } from "../indexer/spam-filter";
import type { TransactionAvailabilityPort } from "../indexer/transaction.repository";
import type { TransactionRecord } from "../shared/repository.types";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import type { BalanceReader, BalanceSnapshot, TokenMetadata } from "./balance-reader";
import { canonicalAssetIdOf } from "./canonical-asset";
import { BALANCE_READER } from "./portfolio.tokens";

// The ledger's fiat unit. Every event carries `fiat_currency: "KRW"` (indexer.adapters.ts), so the
// cost fold — and therefore every cost figure here — is KRW. Spot prices are USD (DexScreener).
// The two are reported side by side with explicit units; converting is the caller's decision.
export const COST_CURRENCY = "KRW";

// Reads are memoized per user for this long. A portfolio pull fans out to 5 chains + one market lookup
// per asset; a dashboard that refetches on focus would otherwise hammer both providers.
export const HOLDINGS_TTL_MS = 30_000;
// Market / metadata lookups in flight at once. DexScreener's public limit is ~300 req/min.
const LOOKUP_CONCURRENCY = 4;
// Tokens per chain the ledger has never seen that we are willing to resolve through provider metadata.
// A spam-bombed wallet can hold thousands of unsolicited contracts; past this cap the remainder is
// dropped and the chain is reported as truncated so the UI can say "more assets not shown".
export const MAX_UNKNOWN_TOKENS_PER_CHAIN = 40;
// Token metadata (symbol/decimals) is immutable on-chain, so a resolved answer is kept for the process
// lifetime. Bounded so a spam-bombed wallet cannot grow it without limit; oldest entries are evicted.
const METADATA_CACHE_MAX = 5_000;

export type HoldingPriceStatus = MarketVerdict | "unknown";

export interface HoldingCostDto {
  currency: string;
  /** Total moving-average cost of the quantity the ledger still tracks. */
  totalCost: string;
  avgCost: string;
  /** Quantity the ledger believes is held. Compare with `amount`: a gap means events are missing or still importing. */
  trackedAmount: string;
}

export interface HoldingDto {
  chainId: number;
  assetType: "NATIVE" | "ERC20";
  /** Lowercased contract; `null` for the native coin. */
  contract: string | null;
  symbol: string;
  name: string;
  decimals: number;
  rawAmount: string;
  /** Human-readable quantity, exact (no rounding), trailing zeros trimmed. */
  amount: string;
  priceUsd: string | null;
  valueUsd: string | null;
  /** `priced` / `illiquid` / `no_market` are confirmed market states; `unknown` means the lookup failed. */
  priceStatus: HoldingPriceStatus;
  costBasis: HoldingCostDto | null;
  /**
   * 표시용 정식 자산 키(`eth`, `usdc`…). 다른 체인의 같은 발행처 토큰이 같은 키를 갖는다 — 화면이 행을 합칠 때 쓴다.
   * 표에 없는 토큰은 null이라 합쳐지지 않는다. 심볼로 정하지 않는다(canonical-asset.ts).
   */
  canonicalAssetId: string | null;
}

/** 지갑 하나의 요약. 목록 화면이 행마다 "이 지갑에 얼마가, 어느 체인에" 있는지를 이걸로 말한다. */
export interface WalletSummaryDto {
  /** 소문자 주소. */
  address: string;
  verificationMethod: string;
  /** 이 지갑의 시세 있는 보유분 USD 합. */
  totalValueUsd: string;
  /** 잔액이 실제로 있는 체인(스팸·더스트 제외 후). */
  chainIds: number[];
  holdingsCount: number;
  unpricedCount: number;
}

export interface HoldingsDto {
  walletAddresses: string[];
  /** 지갑별 요약. `?address=`로 하나만 조회하면 그 지갑 하나다. */
  byWallet: WalletSummaryDto[];
  holdings: HoldingDto[];
  /** Chains that could not be read for at least one wallet; their assets are absent, not zero. */
  skippedChainIds: number[];
  /** Chains where the token list or unknown-token resolution hit a cap; some small/spam positions are hidden. */
  truncatedChainIds: number[];
  /** ERC20 balances dropped because the provider's metadata lookup FAILED (not "unknown token"). >0 means the list is incomplete. */
  unresolvedCount: number;
  /** Total USD value of every priced holding. Unpriced positions contribute nothing and are not "0". */
  totalValueUsd: string;
  unpricedCount: number;
  asOf: string;
}

// What the ledger already knows about an asset cell, so a live balance does not need provider metadata.
interface LedgerAsset {
  symbol: string;
  name: string;
  /**
   * The indexer's value — a GUESS of 18 when the provider omitted it (indexer.adapters.ts). Used only
   * when provider metadata is unavailable, never in preference to it: a 6-decimal stable read as 18
   * renders 500 USDC as 0.0000000000005 and the error is self-concealing (trackedAmount agrees).
   */
  decimals: number;
  /** Every row for this asset is tagged SPAM — the balance is dust, hide it. */
  spamOnly: boolean;
}

type AssetCandidate = {
  chainId: number;
  assetType: "NATIVE" | "ERC20";
  contract: string | null;
  rawAmount: bigint;
};

@Injectable()
export class PortfolioHoldingsService {
  private readonly logger = new Logger(PortfolioHoldingsService.name);
  private readonly memo = new Map<string, { expiresAt: number; pending: Promise<HoldingsDto> }>();
  private readonly metadata = new Map<string, TokenMetadata | null>();

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(BALANCE_READER) private readonly balances: BalanceReader,
    @Inject(TRANSACTION_AVAILABILITY) private readonly available: TransactionAvailabilityPort,
    @Inject(COST_BASIS_SNAPSHOT) private readonly snapshot: CostBasisSnapshotPort,
    @Inject(PRICE_ORACLE) private readonly oracle: PriceOracle,
    // Injected only by specs to pin the clock; Nest leaves it undefined and the default wins.
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  /** `address`를 주면 그 지갑 하나만(등록돼 있지 않으면 404). 없으면 등록한 지갑 전부를 합산한다. */
  async holdings(userId: string, address?: string): Promise<HoldingsDto> {
    const scope = address ? address.toLowerCase() : "*";
    const memoKey = `${userId}:${scope}`;
    const at = this.now().getTime();
    const hit = this.memo.get(memoKey);
    if (hit && hit.expiresAt > at) return hit.pending;
    // Sweep expired entries on write so the table is bounded by concurrently-active users, not by every
    // user id the process has ever served.
    for (const [key, entry] of this.memo) if (entry.expiresAt <= at) this.memo.delete(key);
    const entry = { expiresAt: at + HOLDINGS_TTL_MS, pending: undefined as unknown as Promise<HoldingsDto> };
    entry.pending = this.load(userId, scope === "*" ? undefined : scope).catch((error: unknown) => {
      // A failed read must not pin its rejection for the TTL: the next caller retries the providers.
      // Identity-checked so a late rejection cannot evict a newer, healthy entry for the same user.
      if (this.memo.get(memoKey) === entry) this.memo.delete(memoKey);
      throw error;
    });
    this.memo.set(memoKey, entry);
    return entry.pending;
  }

  private async load(userId: string, onlyAddress?: string): Promise<HoldingsDto> {
    const all = await this.wallets.findAllByUser(userId);
    if (all.length === 0) throw new NotFoundException("A bound wallet is required before reading holdings.");
    const bindings = onlyAddress === undefined ? all : all.filter((binding) => binding.walletAddress.toLowerCase() === onlyAddress);
    if (bindings.length === 0) throw new NotFoundException("That wallet is not registered to this user.");
    const addresses = [...new Set(bindings.map((binding) => binding.walletAddress.toLowerCase()))];
    // 같은 주소를 두 방식(siwe·watch_only)으로 등록했으면 더 강한 검증을 말한다.
    const verificationOf = new Map<string, string>();
    for (const binding of bindings) {
      const current = verificationOf.get(binding.walletAddress.toLowerCase());
      if (current === undefined || (current === "watch_only" && binding.verificationMethod !== "watch_only")) verificationOf.set(binding.walletAddress.toLowerCase(), binding.verificationMethod);
    }

    // Ledger first: it gates the initial sync exactly like the events read (so a fresh binding is
    // indexed once, here or there, never twice) and provides symbol/decimals + cost for known assets.
    const rows = await this.available.listOrSync(userId);
    // Wallets are read one after another: the reader already fans out per chain under the provider's
    // shared compute-unit budget, and a second wallet in parallel would double that burst.
    const [snapshots, cost] = await Promise.all([
      mapWithConcurrency(addresses, 1, (address) => this.balances.readBalances(address)),
      this.snapshot.holdingsFor(userId, rows),
    ]);
    const ledger = indexLedgerAssets(rows);

    const { candidates, skippedChainIds, truncatedChainIds } = mergeSnapshots(snapshots);
    const truncated = new Set<number>(truncatedChainIds);
    const { resolved, unresolvedCount } = await this.resolveAssets(candidates, ledger, truncated);
    const priced = await this.priceAssets(resolved);

    const holdings = priced
      .map((asset) => toHoldingDto(asset, cost.get(holdingAssetKey(asset.chainId, asset.assetType, asset.contract))))
      .sort(compareHoldings);
    const byWallet = addresses.map((address, index) => walletSummary(address, verificationOf.get(address) ?? "watch_only", snapshots[index], priced));

    let totalValueUsd = new Decimal(0);
    let unpricedCount = 0;
    for (const holding of holdings) {
      if (holding.valueUsd === null) unpricedCount += 1;
      else totalValueUsd = totalValueUsd.plus(holding.valueUsd);
    }
    return {
      walletAddresses: addresses,
      byWallet,
      holdings,
      skippedChainIds,
      truncatedChainIds: [...truncated].sort((a, b) => a - b),
      unresolvedCount,
      totalValueUsd: totalValueUsd.toFixed(),
      unpricedCount,
      asOf: this.now().toISOString(),
    };
  }

  /**
   * Attach symbol/name/decimals to every balance and drop dust.
   *
   * Provider metadata is the authority for decimals (immutable, cached for the process); the ledger
   * only answers when the provider cannot. The ledger's SPAM verdict always sticks, and a contract
   * the ledger never saw goes through the same inbound heuristics the indexer applies. Unknown
   * contracts are bounded per chain; a failed lookup with no ledger fallback is COUNTED, not hidden.
   */
  private async resolveAssets(candidates: AssetCandidate[], ledger: Map<string, LedgerAsset>, truncated: Set<number>): Promise<{ resolved: ResolvedAsset[]; unresolvedCount: number }> {
    const natives: ResolvedAsset[] = [];
    const known: Array<{ candidate: AssetCandidate; seen: LedgerAsset }> = [];
    const unknownByChain = new Map<number, AssetCandidate[]>();
    for (const candidate of candidates) {
      if (candidate.assetType === "NATIVE") {
        const entry = registryEntryOf(candidate.chainId);
        if (!entry) continue; // the reader only emits registry chains; never fabricate a symbol
        natives.push({ ...candidate, symbol: entry.nativeSymbol, name: entry.nativeSymbol, decimals: entry.nativeDecimals });
        continue;
      }
      const seen = ledger.get(holdingAssetKey(candidate.chainId, "ERC20", candidate.contract));
      if (seen) {
        if (!seen.spamOnly) known.push({ candidate, seen });
        continue;
      }
      const bucket = unknownByChain.get(candidate.chainId) ?? [];
      bucket.push(candidate);
      unknownByChain.set(candidate.chainId, bucket);
    }

    const unknown: AssetCandidate[] = [];
    for (const [chainId, bucket] of unknownByChain) {
      if (bucket.length > MAX_UNKNOWN_TOKENS_PER_CHAIN) {
        truncated.add(chainId);
        this.logger.warn(`Chain ${chainId}: ${bucket.length} unknown tokens, resolving the first ${MAX_UNKNOWN_TOKENS_PER_CHAIN}.`);
      }
      unknown.push(...bucket.slice(0, MAX_UNKNOWN_TOKENS_PER_CHAIN));
    }

    let unresolvedCount = 0;
    const fromLedger = await mapWithConcurrency(known, LOOKUP_CONCURRENCY, async ({ candidate, seen }) => {
      const meta = await this.metadataFor(candidate.chainId, candidate.contract!);
      // `undefined` = lookup failed → the ledger's (possibly guessed) decimals are the best we have.
      const source = meta === undefined ? seen : meta ?? seen;
      return { ...candidate, symbol: source.symbol, name: source.name, decimals: source.decimals } satisfies ResolvedAsset;
    });
    const fromProvider = await mapWithConcurrency(unknown, LOOKUP_CONCURRENCY, async (candidate) => {
      const meta = await this.metadataFor(candidate.chainId, candidate.contract!);
      if (meta === undefined) {
        unresolvedCount += 1;
        return null;
      }
      if (meta === null) return null; // provider answered: nothing renderable — not a failure
      // An unsolicited contract the ledger never classified goes through the same inbound heuristics
      // the indexer applies to a bare RECEIVE — a weaponized ticker is dust here too.
      if (isInboundSpam({ assetType: "ERC20", symbol: meta.symbol, assetContract: candidate.contract })) return null;
      return { ...candidate, symbol: meta.symbol, name: meta.name, decimals: meta.decimals } satisfies ResolvedAsset;
    });
    return { resolved: [...natives, ...fromLedger, ...fromProvider.filter((asset): asset is ResolvedAsset => asset !== null)], unresolvedCount };
  }

  /** `TokenMetadata` (answered), `null` (answered: nothing usable), or `undefined` (lookup failed). Answers are cached. */
  private async metadataFor(chainId: number, contract: string): Promise<TokenMetadata | null | undefined> {
    const key = `${chainId}:${contract}`;
    if (this.metadata.has(key)) return this.metadata.get(key);
    try {
      const meta = await this.balances.readTokenMetadata(chainId, contract);
      if (this.metadata.size >= METADATA_CACHE_MAX) this.metadata.delete(this.metadata.keys().next().value!);
      this.metadata.set(key, meta);
      return meta;
    } catch (error) {
      this.logger.warn(`Token metadata lookup failed for ${key}: ${(error as Error).message}`);
      return undefined;
    }
  }

  private async priceAssets(assets: ResolvedAsset[]): Promise<PricedAsset[]> {
    const cache = new Map<string, Promise<TokenMarket | null>>();
    const priced = await mapWithConcurrency(assets, LOOKUP_CONCURRENCY, async (asset) => {
      const source = asset.assetType === "NATIVE" ? nativePriceSourceOf(asset.chainId) : asset.contract ? { chainId: asset.chainId, contract: asset.contract } : null;
      if (!source) return { ...asset, market: null };
      const key = `${source.chainId}:${source.contract}`;
      let lookup = cache.get(key);
      if (!lookup) {
        lookup = this.safeLookup(source.chainId, source.contract);
        cache.set(key, lookup);
      }
      return { ...asset, market: await lookup };
    });
    // A confirmed no-market ERC20 the wallet never traded is dust (same gate as price-enrichment.service.ts).
    // The allowlist and the native coin are exempt; an unknown (failed) lookup is kept, never downgraded.
    return priced.filter((asset) => {
      if (asset.assetType === "NATIVE" || asset.market === null) return true;
      if (asset.contract && CONTRACT_ALLOWLIST.has(asset.contract)) return true;
      return marketVerdict(asset.market) !== "no_market";
    });
  }

  private async safeLookup(chainId: number, contract: string): Promise<TokenMarket | null> {
    try {
      return await this.oracle.lookup(chainId, contract);
    } catch (error) {
      this.logger.warn(`Market lookup threw for ${chainId}:${contract}: ${(error as Error).message}`);
      return null;
    }
  }
}

type ResolvedAsset = AssetCandidate & { symbol: string; name: string; decimals: number };
type PricedAsset = ResolvedAsset & { market: TokenMarket | null };

function registryEntryOf(chainId: number): ChainRegistryEntry | undefined {
  return CHAIN_REGISTRY.find((entry) => entry.chainId === chainId);
}

/**
 * 네이티브 코인의 시세를 읽을 (체인, 래핑 컨트랙트). 같은 네이티브 심볼(ETH·POL)은 체인이 달라도 같은 자산이므로
 * 레지스트리에서 그 심볼이 **처음** 나오는 체인(ETH → Ethereum, POL → Polygon)의 래핑 토큰으로 한 번만 조회한다.
 * 체인별로 따로 읽으면 Base·Optimism처럼 WETH 주소가 같은 체인에서 DexScreener 응답(상위 30개 페어)이
 * 한쪽 체인 페어로만 채워져 다른 쪽이 "시장 없음"이 된다(2026-09-11 실지갑에서 Optimism ETH가 no_market).
 */
function nativePriceSourceOf(chainId: number): { chainId: number; contract: string } | null {
  const own = registryEntryOf(chainId);
  if (!own) return null;
  const home = CHAIN_REGISTRY.find((entry) => entry.nativeSymbol === own.nativeSymbol) ?? own;
  return home.wrappedNativeContract ? { chainId: home.chainId, contract: home.wrappedNativeContract } : null;
}

/**
 * 지갑 하나의 요약. 합산 결과(`priced`)에 살아남은 자산만 센다 — 스팸·더스트로 걸러진 잔액은 지갑별 합에도 들어가지 않는다.
 * 시세가 없는 자산은 0이 아니라 빠지고 `unpricedCount`에 센다.
 */
export function walletSummary(address: string, verificationMethod: string, snapshot: BalanceSnapshot, priced: readonly PricedAsset[]): WalletSummaryDto {
  const byKey = new Map(priced.map((asset) => [holdingAssetKey(asset.chainId, asset.assetType, asset.contract), asset] as const));
  const { candidates } = mergeSnapshots([snapshot]);
  let total = new Decimal(0);
  let holdingsCount = 0;
  let unpricedCount = 0;
  const chains = new Set<number>();
  for (const candidate of candidates) {
    const asset = byKey.get(holdingAssetKey(candidate.chainId, candidate.assetType, candidate.contract));
    if (!asset) continue;
    holdingsCount += 1;
    chains.add(candidate.chainId);
    const price = parseDecimalOrNull(asset.market?.priceUsd ?? null);
    if (price === null) {
      unpricedCount += 1;
      continue;
    }
    total = total.plus(new Decimal(formatUnits(candidate.rawAmount, asset.decimals)).mul(price));
  }
  return { address, verificationMethod, totalValueUsd: total.toDecimalPlaces(8).toFixed(), chainIds: [...chains].sort((a, b) => a - b), holdingsCount, unpricedCount };
}

/** Sum the same asset across every bound wallet; union the skipped and truncated chains. */
export function mergeSnapshots(snapshots: BalanceSnapshot[]): { candidates: AssetCandidate[]; skippedChainIds: number[]; truncatedChainIds: number[] } {
  const byKey = new Map<string, AssetCandidate>();
  const skipped = new Set<number>();
  const truncated = new Set<number>();
  for (const snapshot of snapshots) {
    for (const chainId of snapshot.skippedChainIds) skipped.add(chainId);
    for (const chainId of snapshot.truncatedChainIds) truncated.add(chainId);
    for (const chain of snapshot.chains) {
      if (chain.nativeRaw > 0n) accumulate(byKey, { chainId: chain.chainId, assetType: "NATIVE", contract: null, rawAmount: chain.nativeRaw });
      for (const token of chain.tokens) {
        if (token.rawBalance <= 0n) continue;
        accumulate(byKey, { chainId: chain.chainId, assetType: "ERC20", contract: token.contract.toLowerCase(), rawAmount: token.rawBalance });
      }
    }
  }
  return { candidates: [...byKey.values()], skippedChainIds: [...skipped].sort((a, b) => a - b), truncatedChainIds: [...truncated].sort((a, b) => a - b) };
}

function accumulate(byKey: Map<string, AssetCandidate>, candidate: AssetCandidate): void {
  const key = holdingAssetKey(candidate.chainId, candidate.assetType, candidate.contract);
  const existing = byKey.get(key);
  if (existing) existing.rawAmount += candidate.rawAmount;
  else byKey.set(key, { ...candidate });
}

/** Symbol/decimals per ERC20 asset cell the ledger has seen, plus whether every row is SPAM. */
export function indexLedgerAssets(rows: TransactionRecord[]): Map<string, LedgerAsset> {
  const assets = new Map<string, LedgerAsset>();
  for (const row of rows) {
    const payload = row.payload;
    if (payload.asset_type !== "ERC20" || typeof payload.asset_contract !== "string") continue;
    const chainId = Number(payload.chain_id);
    if (!Number.isFinite(chainId)) continue;
    const key = holdingAssetKey(chainId, "ERC20", payload.asset_contract);
    const symbol = typeof payload.symbol === "string" && payload.symbol.trim() ? payload.symbol.trim() : null;
    const decimals = typeof payload.decimals === "number" && Number.isInteger(payload.decimals) && payload.decimals >= 0 ? payload.decimals : null;
    if (symbol === null || decimals === null) continue;
    const spam = payload.classification === "SPAM";
    const existing = assets.get(key);
    if (!existing) {
      // The ledger carries no long-form token name; the symbol stands in until provider metadata does.
      assets.set(key, { symbol, name: symbol, decimals, spamOnly: spam });
      continue;
    }
    if (!spam) existing.spamOnly = false;
  }
  return assets;
}

/** Exact raw → decimal string scaling with BigInt; trailing zeros trimmed, no float in the path. */
export function formatUnits(raw: bigint, decimals: number): string {
  const digits = raw.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals) || "0";
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return fraction ? `${whole}.${fraction}` : whole;
}

function toHoldingDto(asset: PricedAsset, cost: HoldingCostBasis | undefined): HoldingDto {
  const amount = formatUnits(asset.rawAmount, asset.decimals);
  // A price string the oracle passed through unparsed ("", "N/A") is a broken row, not a broken endpoint.
  const priceUsd = parseDecimalOrNull(asset.market?.priceUsd ?? null);
  const priceStatus: HoldingPriceStatus = asset.market === null || (asset.market.priceUsd !== null && priceUsd === null) ? "unknown" : marketVerdict(asset.market);
  const valueUsd = priceUsd === null ? null : new Decimal(amount).mul(priceUsd).toDecimalPlaces(8).toFixed();
  return {
    chainId: asset.chainId,
    assetType: asset.assetType,
    contract: asset.contract,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    rawAmount: asset.rawAmount.toString(),
    amount,
    priceUsd,
    valueUsd,
    priceStatus,
    costBasis: cost ? { currency: COST_CURRENCY, totalCost: cost.totalCost, avgCost: cost.avgCost, trackedAmount: cost.qty } : null,
    canonicalAssetId: canonicalAssetIdOf(asset.chainId, asset.assetType, asset.contract),
  };
}

function parseDecimalOrNull(value: string | null): string | null {
  if (value === null) return null;
  try {
    const parsed = new Decimal(value);
    return parsed.isFinite() ? value : null;
  } catch {
    return null;
  }
}

// Priced positions by value desc; unpriced after them; deterministic tail by chain then symbol.
function compareHoldings(left: HoldingDto, right: HoldingDto): number {
  if (left.valueUsd !== null && right.valueUsd !== null) {
    const byValue = new Decimal(right.valueUsd).comparedTo(left.valueUsd);
    if (byValue !== 0) return byValue;
  } else if (left.valueUsd !== null) return -1;
  else if (right.valueUsd !== null) return 1;
  return left.chainId - right.chainId || left.symbol.localeCompare(right.symbol);
}

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
