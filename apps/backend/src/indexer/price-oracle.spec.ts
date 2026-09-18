import { afterEach, describe, expect, it, vi } from "vitest";
import { CoinGeckoSpotPriceOracle, DexScreenerPriceOracle, FallbackPriceOracle, isUsdStable, summarizeMarket, type PriceOracle, type TokenMarket } from "./price-oracle";

describe("summarizeMarket (pure)", () => {
  it("reports a confirmed no-market as pairCount 0 for empty/null pairs", () => {
    expect(summarizeMarket(null, "base")).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
    expect(summarizeMarket([], "base")).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
  });

  it("filters out pairs from other chains", () => {
    const pairs = [
      { chainId: "ethereum", priceUsd: "5", liquidity: { usd: 1000 } },
      { chainId: "base", priceUsd: "1.00", liquidity: { usd: 500 } },
    ];
    expect(summarizeMarket(pairs, "base")).toEqual({ priceUsd: "1.00", liquidityUsd: 500, pairCount: 1 });
  });

  it("picks the price of the deepest-liquidity pair on the chain", () => {
    const pairs = [
      { chainId: "base", priceUsd: "0.90", liquidity: { usd: 100 } },
      { chainId: "base", priceUsd: "1.01", liquidity: { usd: 9000 } },
    ];
    expect(summarizeMarket(pairs, "base")).toEqual({ priceUsd: "1.01", liquidityUsd: 9000, pairCount: 2 });
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
      json: async () => ({ pairs: [{ chainId: "base", priceUsd: "1.00", liquidity: { usd: 119145 } }] }),
    })));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xUSDC")).toEqual({ priceUsd: "1.00", liquidityUsd: 119145, pairCount: 1 });
  });

  it("returns pairCount 0 for a token with no pairs (confirmed dust)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pairs: [] }) })));
    expect(await new DexScreenerPriceOracle().lookup(8453, "0xSHIT")).toEqual({ priceUsd: null, liquidityUsd: 0, pairCount: 0 });
  });
});

const ARB_USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";

describe("CoinGeckoSpotPriceOracle.lookup", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns null without a key and never fetches", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await new CoinGeckoSpotPriceOracle(null).lookup(42161, ARB_USDT)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the chain's platform with the lowercased contract and the demo key", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ [ARB_USDT.toLowerCase()]: { usd: 0.9998 } }) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await new CoinGeckoSpotPriceOracle("key").lookup(42161, ARB_USDT)).toEqual({ priceUsd: "0.9998", liquidityUsd: 0, pairCount: 1 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain(`/simple/token_price/arbitrum-one?contract_addresses=${ARB_USDT.toLowerCase()}&vs_currencies=usd`);
    expect(init.headers["x-cg-demo-api-key"]).toBe("key");
  });

  it("treats an unlisted contract (200 with no entry) as UNKNOWN, never a confirmed no-market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    expect(await new CoinGeckoSpotPriceOracle("key").lookup(42161, ARB_USDT)).toBeNull();
  });

  it("returns null on a non-ok response, a thrown fetch, and an unsupported chain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    expect(await new CoinGeckoSpotPriceOracle("key").lookup(42161, ARB_USDT)).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    expect(await new CoinGeckoSpotPriceOracle("key").lookup(42161, ARB_USDT)).toBeNull();
    expect(await new CoinGeckoSpotPriceOracle("key").lookup(999, ARB_USDT)).toBeNull();
  });
});

describe("FallbackPriceOracle.lookup", () => {
  const oracle = (answer: TokenMarket | null) => ({ lookup: vi.fn(async () => answer) }) satisfies PriceOracle;
  const NO_MARKET: TokenMarket = { priceUsd: null, liquidityUsd: 0, pairCount: 0 };

  it("returns the primary answer without asking the secondary", async () => {
    const primary = oracle({ priceUsd: "1.00", liquidityUsd: 5, pairCount: 2 });
    const secondary = oracle({ priceUsd: "9", liquidityUsd: 0, pairCount: 1 });
    expect(await new FallbackPriceOracle(primary, secondary).lookup(42161, ARB_USDT)).toEqual({ priceUsd: "1.00", liquidityUsd: 5, pairCount: 2 });
    expect(secondary.lookup).not.toHaveBeenCalled();
  });

  it("keeps a confirmed no-market final: no secondary, no peg, so the dust gate is unchanged", async () => {
    const secondary = oracle({ priceUsd: "9", liquidityUsd: 0, pairCount: 1 });
    expect(await new FallbackPriceOracle(oracle(NO_MARKET), secondary).lookup(42161, ARB_USDT)).toEqual(NO_MARKET);
    expect(secondary.lookup).not.toHaveBeenCalled();
  });

  it("falls back to the secondary when the primary lookup failed", async () => {
    const secondary = oracle({ priceUsd: "0.9998", liquidityUsd: 0, pairCount: 1 });
    expect(await new FallbackPriceOracle(oracle(null), secondary).lookup(42161, ARB_USDT)).toEqual({ priceUsd: "0.9998", liquidityUsd: 0, pairCount: 1 });
  });

  it("pegs a canonical stablecoin at 1.00 only when both sources failed", async () => {
    expect(await new FallbackPriceOracle(oracle(null), oracle(null)).lookup(42161, ARB_USDT)).toEqual({ priceUsd: "1.00", liquidityUsd: 0, pairCount: 1 });
  });

  it("leaves a non-stable UNKNOWN when both sources failed", async () => {
    expect(await new FallbackPriceOracle(oracle(null), oracle(null)).lookup(42161, "0xc87b37a581ec3257b734886d9d3a581f5a9d056c")).toBeNull();
  });
});

describe("isUsdStable", () => {
  it("matches by (chain, contract) case-insensitively and never across chains", () => {
    expect(isUsdStable(42161, ARB_USDT)).toBe(true);
    expect(isUsdStable(1, ARB_USDT)).toBe(false);
  });
});
