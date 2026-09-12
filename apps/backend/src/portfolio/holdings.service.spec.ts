import { NotFoundException } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeHoldingsCostBasis } from "@vera/tax-engine";
import type { CostBasisSnapshotPort } from "../indexer/cost-basis-snapshot.port";
import type { PriceOracle, TokenMarket } from "../indexer/price-oracle";
import type { TransactionAvailabilityPort } from "../indexer/transaction.repository";
import type { BindingRecord, TransactionRecord } from "../shared/repository.types";
import type { WalletRepository } from "../wallet/wallet.repository";
import type { BalanceReader, BalanceSnapshot, TokenMetadata } from "./balance-reader";
import { HOLDINGS_TTL_MS, MAX_UNKNOWN_TOKENS_PER_CHAIN, PortfolioHoldingsService, formatUnits, indexLedgerAssets, mergeSnapshots } from "./holdings.service";

const WALLET_A = "0x1111111111111111111111111111111111111111";
const WALLET_B = "0x2222222222222222222222222222222222222222";
const USDC = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DUST = "0xdddddddddddddddddddddddddddddddddddddddd";
const NEW_TOKEN = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const WETH_MAINNET = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const AT = new Date("2026-09-11T05:00:00.000Z");

const binding = (walletAddress: string): BindingRecord => ({ id: `b-${walletAddress.slice(-2)}`, userId: "u1", walletAddress, bindingHash: null, verificationMethod: "siwe", verifiedAt: AT, boundAt: AT, initialSyncedAt: AT });

function row(id: string, overrides: Record<string, unknown>): TransactionRecord {
  const payload = { id, direction: "IN", asset_type: "ERC20", asset_contract: USDC, token_id: null, chain_id: 1, decimals: 6, symbol: "USDC", raw_amount: "1000000", classification: "RECEIVE", price_status: "RESOLVED", fiat_value: "1400", fiat_currency: "KRW", ...overrides };
  return { id, bindingId: "b-11", txHash: `0x${id}`, eventType: "transfer_in", chain: String(payload.chain_id), payload, occurredAt: new Date(`2025-01-${id.slice(-2)}T00:00:00.000Z`) };
}

interface Fakes {
  bindings?: BindingRecord[];
  snapshots?: Record<string, BalanceSnapshot>;
  metadata?: Record<string, TokenMetadata | null | Error>;
  rows?: TransactionRecord[];
  markets?: Record<string, TokenMarket | null | Error>;
}

function makeService(fakes: Fakes) {
  const wallets = { findAllByUser: vi.fn(async () => fakes.bindings ?? [binding(WALLET_A)]) } as unknown as WalletRepository;
  const readBalances = vi.fn(async (address: string): Promise<BalanceSnapshot> => fakes.snapshots?.[address] ?? { chains: [], skippedChainIds: [], truncatedChainIds: [] });
  const readTokenMetadata = vi.fn(async (chainId: number, contract: string): Promise<TokenMetadata | null> => {
    const meta = fakes.metadata?.[`${chainId}:${contract}`];
    if (meta instanceof Error) throw meta;
    return meta ?? null;
  });
  const balances: BalanceReader = { readBalances, readTokenMetadata };
  const rows = fakes.rows ?? [];
  const available = { listOrSync: vi.fn(async () => rows) } as unknown as TransactionAvailabilityPort;
  const snapshot = { snapshotFor: vi.fn(), holdingsFor: vi.fn(async (_u: string, ledger: TransactionRecord[]) => computeHoldingsCostBasis(ledger)) } as unknown as CostBasisSnapshotPort;
  const lookup = vi.fn(async (chainId: number, contract: string) => {
    const market = fakes.markets?.[`${chainId}:${contract}`];
    if (market instanceof Error) throw market;
    return market ?? null;
  });
  const oracle: PriceOracle = { lookup };
  let now = AT;
  const service = new PortfolioHoldingsService(wallets, balances, available, snapshot, oracle, () => now);
  return { service, readBalances, readTokenMetadata, lookup, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const priced = (priceUsd: string): TokenMarket => ({ priceUsd, liquidityUsd: 1_000_000, pairCount: 5 });

afterEach(() => vi.restoreAllMocks());

describe("formatUnits / mergeSnapshots / indexLedgerAssets", () => {
  it("scales raw integers exactly and trims trailing zeros", () => {
    expect(formatUnits(750_000_000_000_000_000n, 18)).toBe("0.75");
    expect(formatUnits(500_000_000n, 6)).toBe("500");
    expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatUnits(123_456_789_012_345_678_901_234n, 18)).toBe("123456.789012345678901234");
    expect(formatUnits(42n, 0)).toBe("42");
  });

  it("sums the same asset across wallets and unions skipped chains", () => {
    const merged = mergeSnapshots([
      { chains: [{ chainId: 1, nativeRaw: 5n, tokens: [{ contract: USDC.toUpperCase(), rawBalance: 10n }] }], skippedChainIds: [10], truncatedChainIds: [8453] },
      { chains: [{ chainId: 1, nativeRaw: 0n, tokens: [{ contract: USDC, rawBalance: 5n }] }], skippedChainIds: [137, 10], truncatedChainIds: [] },
    ]);
    expect(merged.skippedChainIds).toEqual([10, 137]);
    expect(merged.truncatedChainIds).toEqual([8453]);
    expect(merged.candidates).toEqual([
      { chainId: 1, assetType: "NATIVE", contract: null, rawAmount: 5n },
      { chainId: 1, assetType: "ERC20", contract: USDC, rawAmount: 15n },
    ]);
  });

  it("indexes ERC20 symbol/decimals from the ledger and keeps a cell spam-only until a non-spam row appears", () => {
    const assets = indexLedgerAssets([
      row("01", { asset_contract: DUST, symbol: "FREE", decimals: 18, classification: "SPAM" }),
      row("02", {}),
      row("03", { asset_contract: NEW_TOKEN, symbol: "", decimals: 18 }), // no symbol: unusable
      row("04", { asset_type: "NATIVE", asset_contract: null, symbol: "ETH", decimals: 18 }),
    ]);
    expect(assets.get(`1:ERC20:${DUST}:`)).toEqual({ symbol: "FREE", name: "FREE", decimals: 18, spamOnly: true });
    expect(assets.get(`1:ERC20:${USDC}:`)).toEqual({ symbol: "USDC", name: "USDC", decimals: 6, spamOnly: false });
    expect(assets.size).toBe(2);
  });
});

describe("PortfolioHoldingsService.holdings", () => {
  it("requires a bound wallet", async () => {
    const { service } = makeService({ bindings: [] });
    await expect(service.holdings("u1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("joins live balances with ledger metadata, market price, and moving-average cost", async () => {
    const { service, lookup } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 750_000_000_000_000_000n, tokens: [{ contract: USDC, rawBalance: 500_000_000n }] }], skippedChainIds: [], truncatedChainIds: [] } },
      rows: [
        row("01", { raw_amount: "600000000", fiat_value: "840000" }), // 600 USDC @ 1,400 KRW each
        row("02", { direction: "OUT", classification: "SEND", raw_amount: "100000000", fiat_value: "140000" }), // sold 100 → 500 left
        row("03", { asset_type: "NATIVE", asset_contract: null, symbol: "ETH", decimals: 18, raw_amount: "750000000000000000", fiat_value: "3000000" }),
      ],
      metadata: { [`1:${USDC}`]: { symbol: "USDC", name: "USD Coin", decimals: 6 } },
      markets: { [`1:${WETH_MAINNET}`]: priced("3200"), [`1:${USDC}`]: priced("1.00") },
    });

    const result = await service.holdings("u1");

    expect(result.walletAddresses).toEqual([WALLET_A]);
    expect(result.skippedChainIds).toEqual([]);
    expect(result.truncatedChainIds).toEqual([]);
    expect(result.unresolvedCount).toBe(0);
    expect(result.asOf).toBe(AT.toISOString());
    expect(result.holdings.map((holding) => holding.symbol)).toEqual(["ETH", "USDC"]); // by USD value desc
    const [eth, usdc] = result.holdings;
    expect(eth).toMatchObject({ chainId: 1, assetType: "NATIVE", contract: null, decimals: 18, amount: "0.75", priceUsd: "3200", valueUsd: "2400", priceStatus: "priced" });
    expect(eth.costBasis).toEqual({ currency: "KRW", totalCost: "3000000", avgCost: "4000000", trackedAmount: "0.75" });
    expect(usdc).toMatchObject({ assetType: "ERC20", contract: USDC, name: "USD Coin", decimals: 6, amount: "500", valueUsd: "500", priceStatus: "priced" });
    expect(usdc.costBasis).toEqual({ currency: "KRW", totalCost: "700000", avgCost: "1400", trackedAmount: "500" });
    // 정식 자산 키: 네이티브 ETH는 eth, 표에 없는 컨트랙트(USDC 픽스처 주소는 실제 USDC가 아니다)는 null.
    expect(eth.canonicalAssetId).toBe("eth");
    expect(usdc.canonicalAssetId).toBeNull();
    expect(result.totalValueUsd).toBe("2900");
    expect(result.unpricedCount).toBe(0);
    expect(result.byWallet).toEqual([{ address: WALLET_A, verificationMethod: "siwe", totalValueUsd: "2900", chainIds: [1], holdingsCount: 2, unpricedCount: 0 }]);
    // Native price is read through the chain's wrapped-native contract.
    expect(lookup).toHaveBeenCalledWith(1, WETH_MAINNET);
  });

  it("hides balances the ledger tagged SPAM and drops confirmed no-market unknown tokens; keeps unknown-market ones", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const NO_MARKET = "0x1234567890123456789012345678901234567890";
    const FAILED = "0x0987654321098765432109876543210987654321";
    const { service } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 0n, tokens: [
        { contract: DUST, rawBalance: 1n },
        { contract: NEW_TOKEN, rawBalance: 2_000_000_000_000_000_000n },
        { contract: NO_MARKET, rawBalance: 7n },
        { contract: FAILED, rawBalance: 9n },
        { contract: "0xbadbadbadbadbadbadbadbadbadbadbadbadbad1", rawBalance: 3n },
      ] }], skippedChainIds: [], truncatedChainIds: [] } },
      rows: [row("01", { asset_contract: DUST, symbol: "FREE", classification: "SPAM" })],
      metadata: {
        [`1:${NEW_TOKEN}`]: { symbol: "NEW", name: "New Token", decimals: 18 },
        [`1:${NO_MARKET}`]: { symbol: "GHOST", name: "Ghost", decimals: 0 },
        [`1:${FAILED}`]: { symbol: "MAYBE", name: "Maybe", decimals: 0 },
        ["1:0xbadbadbadbadbadbadbadbadbadbadbadbadbad1"]: { symbol: "claim-airdrop.xyz", name: "x", decimals: 18 },
      },
      markets: { [`1:${NEW_TOKEN}`]: { priceUsd: null, liquidityUsd: 100, pairCount: 1 }, [`1:${NO_MARKET}`]: { priceUsd: null, liquidityUsd: 0, pairCount: 0 }, [`1:${FAILED}`]: new Error("dexscreener down") },
    });

    const result = await service.holdings("u1");

    expect(result.holdings.map((holding) => [holding.symbol, holding.priceStatus])).toEqual([["MAYBE", "unknown"], ["NEW", "illiquid"]]);
    expect(result.holdings[1]).toMatchObject({ name: "New Token", amount: "2", priceUsd: null, valueUsd: null, costBasis: null });
    expect(result.unpricedCount).toBe(2);
    expect(result.totalValueUsd).toBe("0");
  });

  it("aggregates every bound wallet, surfaces skipped chains, and caps unknown-token resolution per chain", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const many = Array.from({ length: MAX_UNKNOWN_TOKENS_PER_CHAIN + 1 }, (_, index) => ({ contract: `0x${(index + 1).toString(16).padStart(40, "0")}`, rawBalance: 1n }));
    const metadata: Record<string, TokenMetadata> = {};
    for (const token of many) metadata[`8453:${token.contract}`] = { symbol: "T", name: "T", decimals: 0 };
    const { service, readBalances, readTokenMetadata } = makeService({
      bindings: [binding(WALLET_A), binding(WALLET_B.toUpperCase()), binding(WALLET_A)],
      snapshots: {
        [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 1_000_000_000_000_000_000n, tokens: [] }], skippedChainIds: [137], truncatedChainIds: [] },
        [WALLET_B]: { chains: [{ chainId: 1, nativeRaw: 2_000_000_000_000_000_000n, tokens: [] }, { chainId: 8453, nativeRaw: 0n, tokens: many }], skippedChainIds: [10], truncatedChainIds: [] },
      },
      metadata,
    });

    const result = await service.holdings("u1");

    expect(readBalances).toHaveBeenCalledTimes(2); // duplicate binding reads once
    expect(result.walletAddresses).toEqual([WALLET_A, WALLET_B]);
    expect(result.skippedChainIds).toEqual([10, 137]);
    expect(result.truncatedChainIds).toEqual([8453]);
    expect(readTokenMetadata).toHaveBeenCalledTimes(MAX_UNKNOWN_TOKENS_PER_CHAIN);
    const eth = result.holdings.find((holding) => holding.assetType === "NATIVE")!;
    expect(eth.amount).toBe("3");
    expect(eth.priceStatus).toBe("unknown");
    // 지갑별 요약: 각 지갑의 잔액만, 살아남은 자산만, 시세 없는 것은 0이 아니라 unpriced로.
    expect(result.byWallet.map((wallet) => [wallet.address, wallet.chainIds, wallet.holdingsCount, wallet.unpricedCount, wallet.totalValueUsd])).toEqual([
      [WALLET_A, [1], 1, 1, "0"],
      [WALLET_B, [1, 8453], 1 + MAX_UNKNOWN_TOKENS_PER_CHAIN, 1 + MAX_UNKNOWN_TOKENS_PER_CHAIN, "0"],
    ]);

    // ?address= 는 그 지갑만 읽는다(다른 지갑의 잔액 조회를 하지 않는다). 미등록 주소는 404.
    readBalances.mockClear();
    const only = await service.holdings("u1", WALLET_B.toUpperCase());
    expect(readBalances).toHaveBeenCalledTimes(1);
    expect(only.walletAddresses).toEqual([WALLET_B]);
    expect(only.byWallet).toHaveLength(1);
    expect(only.holdings.find((holding) => holding.assetType === "NATIVE")!.amount).toBe("2");
    await expect(service.holdings("u1", "0x9999999999999999999999999999999999999999")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("prices every ETH-native chain through mainnet WETH once (Base/Optimism share a WETH address that starves DexScreener's per-chain filter)", async () => {
    const { service, lookup } = makeService({
      snapshots: { [WALLET_A]: { chains: [
        { chainId: 10, nativeRaw: 1_000_000_000_000_000_000n, tokens: [] },
        { chainId: 8453, nativeRaw: 1_000_000_000_000_000_000n, tokens: [] },
        { chainId: 137, nativeRaw: 1_000_000_000_000_000_000n, tokens: [] },
      ], skippedChainIds: [], truncatedChainIds: [] } },
      markets: { [`1:${WETH_MAINNET}`]: priced("3200"), ["137:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270"]: priced("0.09") },
    });
    const result = await service.holdings("u1");
    expect(result.holdings.map((holding) => [holding.chainId, holding.symbol, holding.valueUsd])).toEqual([[10, "ETH", "3200"], [8453, "ETH", "3200"], [137, "POL", "0.09"]]);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith(1, WETH_MAINNET);
    expect(lookup).not.toHaveBeenCalledWith(10, expect.anything());
  });

  it("memoizes per user for the TTL and forgets a failed read immediately", async () => {
    const { service, readBalances, advance } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 1n, tokens: [] }], skippedChainIds: [], truncatedChainIds: [] } },
    });
    await service.holdings("u1");
    await service.holdings("u1");
    expect(readBalances).toHaveBeenCalledTimes(1);
    advance(HOLDINGS_TTL_MS + 1);
    await service.holdings("u1");
    expect(readBalances).toHaveBeenCalledTimes(2);

    readBalances.mockRejectedValueOnce(new Error("outage"));
    advance(HOLDINGS_TTL_MS + 1);
    await expect(service.holdings("u1")).rejects.toThrow("outage");
    await service.holdings("u1"); // retried, not pinned
    expect(readBalances).toHaveBeenCalledTimes(4);
  });

  it("prefers provider decimals over the ledger's guess, falls back to the ledger when the lookup fails, and caches answers", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const GUESSED = "0x9999999999999999999999999999999999999999";
    const { service, readTokenMetadata, advance } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 0n, tokens: [{ contract: USDC, rawBalance: 500_000_000n }, { contract: GUESSED, rawBalance: 7_000_000n }] }], skippedChainIds: [], truncatedChainIds: [] } },
      rows: [
        row("01", { decimals: 18 }), // indexer guessed 18 for a 6-decimal stable
        row("02", { asset_contract: GUESSED, symbol: "GS", decimals: 6 }),
      ],
      metadata: { [`1:${USDC}`]: { symbol: "USDC", name: "USD Coin", decimals: 6 }, [`1:${GUESSED}`]: new Error("429") },
    });

    const result = await service.holdings("u1");
    const usdc = result.holdings.find((holding) => holding.contract === USDC)!;
    expect(usdc.amount).toBe("500"); // not 0.0000000000005
    const guessed = result.holdings.find((holding) => holding.contract === GUESSED)!;
    expect(guessed).toMatchObject({ symbol: "GS", decimals: 6, amount: "7" }); // ledger fallback
    expect(result.unresolvedCount).toBe(0); // a ledger-known token is never "unresolved"

    advance(HOLDINGS_TTL_MS + 1);
    await service.holdings("u1");
    // USDC's answer was cached; the failed lookup was not, so it is retried.
    expect(readTokenMetadata.mock.calls.filter(([, contract]) => contract === USDC)).toHaveLength(1);
    expect(readTokenMetadata.mock.calls.filter(([, contract]) => contract === GUESSED)).toHaveLength(2);
  });

  it("counts an unknown token whose metadata lookup failed instead of silently dropping it", async () => {
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { service } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 0n, tokens: [{ contract: NEW_TOKEN, rawBalance: 1n }, { contract: DUST, rawBalance: 1n }] }], skippedChainIds: [], truncatedChainIds: [10] } },
      metadata: { [`1:${NEW_TOKEN}`]: new Error("timeout"), [`1:${DUST}`]: null },
    });
    const result = await service.holdings("u1");
    expect(result.holdings).toEqual([]);
    expect(result.unresolvedCount).toBe(1); // the provider answering "nothing usable" is not a failure
    expect(result.truncatedChainIds).toEqual([10]); // reader-side truncation is surfaced too
  });

  it("treats an unparseable oracle price as unknown for that row only", async () => {
    const { service } = makeService({
      snapshots: { [WALLET_A]: { chains: [{ chainId: 1, nativeRaw: 1_000_000_000_000_000_000n, tokens: [] }], skippedChainIds: [], truncatedChainIds: [] } },
      markets: { [`1:${WETH_MAINNET}`]: { priceUsd: "N/A", liquidityUsd: 1, pairCount: 1 } },
    });
    const result = await service.holdings("u1");
    expect(result.holdings[0]).toMatchObject({ symbol: "ETH", priceUsd: null, valueUsd: null, priceStatus: "unknown" });
    expect(result.unpricedCount).toBe(1);
  });
});
