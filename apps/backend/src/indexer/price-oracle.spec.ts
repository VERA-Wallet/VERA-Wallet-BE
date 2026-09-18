import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerPriceOracle, summarizeMarket } from "./price-oracle";

const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const asBase = (priceUsd: string, usd: number, chainId = "base") => ({ chainId, priceUsd, liquidity: { usd }, baseToken: { address: TOKEN }, quoteToken: { address: OTHER } });
const asQuote = (priceUsd: string, usd: number, chainId = "base") => ({ chainId, priceUsd, liquidity: { usd }, baseToken: { address: OTHER }, quoteToken: { address: TOKEN } });

describe("summarizeMarket (pure)", () => {
  it("reports a confirmed no-market as pairCount 0 for empty/null pairs", () => {
    expect(summarizeMarket(null, "base", TOKEN)).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
    expect(summarizeMarket([], "base", TOKEN)).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
  });

  it("filters out pairs from other chains", () => {
    const pairs = [asBase("5", 1000, "ethereum"), asBase("1.00", 500)];
    expect(summarizeMarket(pairs, "base", TOKEN)).toEqual({ priceUsd: "1.00", liquidityUsd: 500, pairCount: 1 });
  });

  it("picks the price of the deepest-liquidity pair on the chain", () => {
    const pairs = [asBase("0.90", 100), asBase("1.01", 9000)];
    expect(summarizeMarket(pairs, "base", TOKEN)).toEqual({ priceUsd: "1.01", liquidityUsd: 9000, pairCount: 2 });
  });

  // 회귀: Base USDC를 물으면 최고 유동성 페어가 AERO/USDC라서 AERO 가격($0.6287)이 USDC 단가로 나왔다.
  // priceUsd는 늘 baseToken의 가격이므로, 물어본 토큰이 quote인 페어는 단가 후보가 될 수 없다.
  it("ignores the price of pairs where the queried token is the quote side", () => {
    const pairs = [asQuote("0.6287", 36_000_000), asBase("1.000071", 145_000)];
    expect(summarizeMarket(pairs, "base", TOKEN)).toEqual({ priceUsd: "1.000071", liquidityUsd: 36_000_000, pairCount: 2 });
  });

  // 유동성·페어수는 quote 페어까지 센다 — "이 토큰이 거래되긴 하나"를 스팸 필터가 그 값으로 판단하기 때문이다.
  it("keeps liquidity and pair count across all on-chain pairs, even quote-side only", () => {
    expect(summarizeMarket([asQuote("0.6287", 36_000_000)], "base", TOKEN)).toEqual({ priceUsd: null, liquidityUsd: 36_000_000, pairCount: 1 });
  });

  it("matches the contract case-insensitively", () => {
    const pairs = [{ chainId: "base", priceUsd: "1.00", liquidity: { usd: 500 }, baseToken: { address: TOKEN.toLowerCase() } }];
    expect(summarizeMarket(pairs, "base", TOKEN.toUpperCase())).toEqual({ priceUsd: "1.00", liquidityUsd: 500, pairCount: 1 });
  });
});

describe("DexScreenerPriceOracle.lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null (UNKNOWN) for an unsupported chain without any fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await new DexScreenerPriceOracle().lookup(999, "0xabc")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null (UNKNOWN) on a non-ok HTTP response, never a confirmed no-market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xabc")).toBeNull();
  });

  it("returns null (UNKNOWN) when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xabc")).toBeNull();
  });

  it("returns a confirmed market snapshot on a 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pairs: [{ chainId: "base", priceUsd: "1.00", liquidity: { usd: 119145 }, baseToken: { address: "0xUSDC" } }] }),
    })));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xUSDC")).toEqual({ priceUsd: "1.00", liquidityUsd: 119145, pairCount: 1 });
  });

  it("returns pairCount 0 for a token with no pairs (confirmed dust)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pairs: [] }) })));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xSHIT")).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
  });
});
