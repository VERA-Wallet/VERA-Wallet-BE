import { afterEach, describe, expect, it, vi } from "vitest";
import { DexScreenerPriceOracle, summarizeMarket } from "./price-oracle";

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
