import { afterEach, describe, expect, it, vi } from "vitest";
import { CoinGeckoHistoricalPriceOracle, MockHistoricalPriceOracle, dayWindow, endpointKind, summarizeDailyClose } from "./historical-price-oracle";

const DAY = "2025-01-03";
const w = dayWindow(DAY)!;

afterEach(() => vi.restoreAllMocks());

describe("dayWindow", () => {
  it("returns a [from, to) UTC-day second window", () => {
    expect(w).toEqual({ from: Date.parse("2025-01-03T00:00:00Z") / 1000, to: Date.parse("2025-01-04T00:00:00Z") / 1000 });
  });
  it("rejects malformed dates", () => {
    expect(dayWindow("2025-1-3")).toBeNull();
    expect(dayWindow("not-a-date")).toBeNull();
  });
  it("rejects impossible calendar dates instead of normalizing them (no wrong-day pricing)", () => {
    expect(dayWindow("2025-02-30")).toBeNull();
    expect(dayWindow("2025-13-01")).toBeNull();
    expect(dayWindow("2025-00-10")).toBeNull();
  });
});

describe("endpointKind", () => {
  it("whitelists only native (null contract) and ERC20 (non-empty contract)", () => {
    expect(endpointKind("NATIVE", null)).toBe("native");
    expect(endpointKind("ERC20", "0xabc")).toBe("contract");
    expect(endpointKind("NATIVE", "0xabc")).toBeNull(); // native must not carry a contract
    expect(endpointKind("ERC20", null)).toBeNull(); // erc20 needs a contract
    expect(endpointKind("ERC20", "   ")).toBeNull(); // blank contract rejected
    expect(endpointKind("ERC721", "0xabc")).toBeNull();
    expect(endpointKind("weird", null)).toBeNull();
  });
});

describe("summarizeDailyClose", () => {
  it("picks the LAST in-window price point (the close)", () => {
    const prices = [
      [w.from * 1000 + 1000, 100],
      [w.from * 1000 + 5000, 250], // latest inside the day -> close
      [w.to * 1000 + 1000, 999], // next day, excluded
    ];
    expect(summarizeDailyClose(prices, w.from, w.to)).toBe("250");
  });
  it("returns null for a 200-response with no in-window data (confirmed no-data, not failure)", () => {
    expect(summarizeDailyClose([], w.from, w.to)).toBeNull();
    expect(summarizeDailyClose([[w.to * 1000 + 1, 500]], w.from, w.to)).toBeNull();
  });
  it("ignores non-numeric points and non-array input", () => {
    expect(summarizeDailyClose([[w.from * 1000, "abc"]], w.from, w.to)).toBeNull();
    expect(summarizeDailyClose(null, w.from, w.to)).toBeNull();
  });
  it("rejects non-positive and blank close values (a KRW price is always > 0)", () => {
    expect(summarizeDailyClose([[w.from * 1000, 0]], w.from, w.to)).toBeNull();
    expect(summarizeDailyClose([[w.from * 1000, -5]], w.from, w.to)).toBeNull();
    expect(summarizeDailyClose([[w.from * 1000, "  "]], w.from, w.to)).toBeNull();
  });
});

describe("CoinGeckoHistoricalPriceOracle.priceAt", () => {
  const oracle = new CoinGeckoHistoricalPriceOracle("demo-key");

  it("resolves an ERC20 KRW close via the contract endpoint and sends the Demo key header", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ prices: [[w.from * 1000 + 100, 1234.5]] }), { status: 200 }),
    );
    const result = await oracle.priceAt(1, "0xAbC", "ERC20", DAY);
    expect(result).toEqual({ krw: "1234.5", status: "RESOLVED" });
    // lowercased contract + ethereum platform + krw quote
    expect(String(fetchMock.mock.calls[0][0])).toContain("/coins/ethereum/contract/0xabc/market_chart/range?vs_currency=krw");
    // Demo key travels in the x-cg-demo-api-key header
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-cg-demo-api-key": "demo-key" });
  });

  it("returns null WITHOUT fetching when no Demo API key is configured", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const keyless = new CoinGeckoHistoricalPriceOracle(null);
    expect(await keyless.priceAt(1, "0xabc", "ERC20", DAY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the native coin endpoint for NATIVE assets", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ prices: [[w.from * 1000 + 100, 5000000]] }), { status: 200 }),
    );
    const result = await new CoinGeckoHistoricalPriceOracle("demo-key").priceAt(137, null, "NATIVE", DAY);
    expect(result).toEqual({ krw: "5000000", status: "RESOLVED" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/coins/matic-network/market_chart/range");
  });

  it("returns null for NFTs, unsupported chains, and malformed dates without fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await oracle.priceAt(1, "0xabc", "ERC721", DAY)).toBeNull();
    expect(await oracle.priceAt(1, "0xabc", "ERC1155", DAY)).toBeNull();
    expect(await oracle.priceAt(99999, "0xabc", "ERC20", DAY)).toBeNull();
    expect(await oracle.priceAt(1, "0xabc", "ERC20", "bad-date")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null (UNKNOWN, never 0) on a non-ok HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
    expect(await oracle.priceAt(1, "0xabc", "ERC20", DAY)).toBeNull();
  });

  it("returns null on a network throw", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    expect(await oracle.priceAt(1, "0xabc", "ERC20", DAY)).toBeNull();
  });
});

describe("MockHistoricalPriceOracle", () => {
  it("always returns null and never touches the network", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await new MockHistoricalPriceOracle().priceAt()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("CoinGeckoHistoricalPriceOracle plan history window", () => {
  it("does not spend a request on a day older than the plan window, and asks inside it", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ prices: [[Date.UTC(2026, 8, 1, 12), 1000]] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const now = () => new Date("2026-09-08T00:00:00.000Z");
    const oracle = new CoinGeckoHistoricalPriceOracle("key", 365, now);
    await expect(oracle.priceAt(1, null, "NATIVE", "2025-06-01")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(oracle.priceAt(1, null, "NATIVE", "2026-09-01")).resolves.toEqual({ krw: "1000", status: "RESOLVED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("treats 0 as unlimited (paid plan)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ prices: [[Date.UTC(2021, 0, 1, 12), 5]] }) }));
    vi.stubGlobal("fetch", fetchMock);
    const oracle = new CoinGeckoHistoricalPriceOracle("key", 0, () => new Date("2026-09-08T00:00:00.000Z"));
    await expect(oracle.priceAt(1, null, "NATIVE", "2021-01-01")).resolves.toEqual({ krw: "5", status: "RESOLVED" });
    vi.unstubAllGlobals();
  });
});
