import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AlchemyBalanceReader, MockBalanceReader, parseHexBalance } from "./balance-reader.adapters";
import { CHAIN_REGISTRY } from "../indexer/chain-registry";

const makeConfig = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type Reply = { result?: unknown; error?: { code?: number; message: string } } | { httpStatus: number };
type Handler = (network: string, method: string, params: unknown[]) => Reply;

// Stub global fetch with a per-network JSON-RPC handler; records every call for assertions.
function stubRpc(handler: Handler) {
  const calls: Array<{ network: string; method: string; params: unknown[] }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    const network = new URL(url).hostname.split(".")[0];
    const body = JSON.parse(init.body) as { method: string; params: unknown[] };
    calls.push({ network, method: body.method, params: body.params });
    const reply = handler(network, body.method, body.params);
    if ("httpStatus" in reply) return { ok: false, status: reply.httpStatus, headers: { get: () => null }, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ jsonrpc: "2.0", id: 1, ...reply }) };
  }));
  return calls;
}

const quiet = () => { vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined); };

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("parseHexBalance", () => {
  it("accepts strict 0x-hex quantities only", () => {
    expect(parseHexBalance("0x0")).toBe(0n);
    expect(parseHexBalance("0xde0b6b3a7640000")).toBe(1_000_000_000_000_000_000n);
    expect(parseHexBalance("123")).toBeNull();
    expect(parseHexBalance("0x12zz")).toBeNull();
    expect(parseHexBalance(null)).toBeNull();
  });
});

describe("MockBalanceReader", () => {
  it("serves the demo wallet (0.75 ETH, 500 USDC on Base, 850 USDT on Polygon) with metadata", async () => {
    const reader = new MockBalanceReader();
    const snapshot = await reader.readBalances(WALLET);
    expect(snapshot.skippedChainIds).toEqual([]);
    expect(snapshot.chains.map((chain) => chain.chainId)).toEqual([1, 8453, 42161, 10, 137]);
    expect(snapshot.chains[0].nativeRaw).toBe(750_000_000_000_000_000n);
    const usdc = snapshot.chains[1].tokens[0];
    expect(await reader.readTokenMetadata(8453, usdc.contract)).toEqual({ symbol: "USDC", name: "USD Coin", decimals: 6 });
    expect(await reader.readTokenMetadata(1, TOKEN_A)).toBeNull();
    expect(snapshot.truncatedChainIds).toEqual([]);
  });
});

describe("AlchemyBalanceReader.readBalances", () => {
  it("requires ALCHEMY_API_KEY", async () => {
    const reader = new AlchemyBalanceReader(makeConfig({}));
    await expect(reader.readBalances(WALLET)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("reads native + non-zero ERC20 balances per chain, following pageKey and skipping errored tokens", async () => {
    const calls = stubRpc((network, method, params) => {
      if (method === "eth_getBalance") return { result: network === "eth-mainnet" ? "0xde0b6b3a7640000" : "0x0" };
      if (network !== "eth-mainnet") return { result: { tokenBalances: [] } };
      const page = (params[2] as { pageKey?: string } | undefined)?.pageKey;
      if (!page) return { result: { tokenBalances: [{ contractAddress: TOKEN_A.toUpperCase(), tokenBalance: "0x64" }, { contractAddress: TOKEN_B, tokenBalance: "0x0" }], pageKey: "p2" } };
      return { result: { tokenBalances: [{ contractAddress: TOKEN_B, tokenBalance: null, error: "execution reverted" }, { contractAddress: "0xcccccccccccccccccccccccccccccccccccccccc", tokenBalance: "0x1" }] } };
    });
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
    const snapshot = await reader.readBalances(WALLET.toUpperCase());

    expect(snapshot.skippedChainIds).toEqual([]);
    expect(snapshot.chains).toHaveLength(CHAIN_REGISTRY.length);
    const mainnet = snapshot.chains.find((chain) => chain.chainId === 1)!;
    expect(mainnet.nativeRaw).toBe(1_000_000_000_000_000_000n);
    expect(mainnet.tokens).toEqual([
      { contract: TOKEN_A, rawBalance: 100n },
      { contract: "0xcccccccccccccccccccccccccccccccccccccccc", rawBalance: 1n },
    ]);
    // Wallet is lowercased before it reaches the node; the pageKey is passed back verbatim.
    const tokenCalls = calls.filter((call) => call.network === "eth-mainnet" && call.method === "alchemy_getTokenBalances");
    expect(tokenCalls.map((call) => call.params)).toEqual([[WALLET, "erc20"], [WALLET, "erc20", { pageKey: "p2" }]]);
  });

  it("withholds a chain whose reply is malformed or errored, and reports it as skipped rather than empty", async () => {
    quiet();
    stubRpc((network, method) => {
      if (network === "base-mainnet") return { httpStatus: 500 };
      if (network === "polygon-mainnet" && method === "eth_getBalance") return { result: "12345" }; // decimal, not 0x-hex
      if (network === "arb-mainnet" && method === "alchemy_getTokenBalances") return { error: { message: "boom" } };
      return method === "eth_getBalance" ? { result: "0x1" } : { result: { tokenBalances: [] } };
    });
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
    const snapshot = await reader.readBalances(WALLET);
    expect(snapshot.skippedChainIds).toEqual([8453, 42161, 137]); // registry order
    expect(snapshot.chains.map((chain) => chain.chainId).sort((a, b) => a - b)).toEqual([1, 10]);
  });

  it("throws when no chain could be observed (an outage is never an empty wallet)", async () => {
    quiet();
    stubRpc(() => ({ httpStatus: 502 }));
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
    await expect(reader.readBalances(WALLET)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("retries a 429 with backoff before giving up on the chain", async () => {
    quiet();
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { method: string };
      if (body.method === "eth_getBalance") {
        attempts += 1;
        if (attempts === 1) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: body.method === "eth_getBalance" ? "0x2" : { tokenBalances: [] } }) };
    }));
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k", ALCHEMY_RETRY_BASE_MS: "0" }));
    const snapshot = await reader.readBalances(WALLET);
    expect(snapshot.skippedChainIds).toEqual([]);
    expect(snapshot.chains.every((chain) => chain.nativeRaw === 2n)).toBe(true);
  });
});

describe("AlchemyBalanceReader.readTokenMetadata", () => {
  it("returns symbol/name/decimals, null when the provider knows no symbol or decimals, and THROWS on a failed lookup", async () => {
    stubRpc((_network, _method, params) => {
      const contract = params[0] as string;
      if (contract === TOKEN_A) return { result: { symbol: " USDC ", name: "USD Coin", decimals: 6, logo: null } };
      if (contract === TOKEN_B) return { result: { symbol: "X", name: null, decimals: null } };
      return { error: { message: "nope" } };
    });
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
    expect(await reader.readTokenMetadata(1, TOKEN_A)).toEqual({ symbol: "USDC", name: "USD Coin", decimals: 6 });
    expect(await reader.readTokenMetadata(1, TOKEN_B)).toBeNull();
    // A failure is not "no such token": the caller must be able to tell the two apart.
    await expect(reader.readTokenMetadata(1, "0xdead")).rejects.toThrow("RPC error");
    expect(await reader.readTokenMetadata(999, TOKEN_A)).toBeNull();
  });

  it("reports a chain whose ERC20 list hit the page cap as truncated, keeping what it read", async () => {
    quiet();
    stubRpc((network, method) => {
      if (method === "eth_getBalance") return { result: "0x0" };
      if (network === "eth-mainnet") return { result: { tokenBalances: [{ contractAddress: TOKEN_A, tokenBalance: "0x1" }], pageKey: "again" } };
      return { result: { tokenBalances: [] } };
    });
    const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
    const snapshot = await reader.readBalances(WALLET);
    expect(snapshot.truncatedChainIds).toEqual([1]);
    expect(snapshot.chains.find((chain) => chain.chainId === 1)!.tokens).toHaveLength(20);
  });

  it("caps a provider-sent Retry-After so a user-facing read never parks for minutes", async () => {
    quiet();
    vi.useFakeTimers();
    try {
      let first = true;
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { method: string };
        if (first) { first = false; return { ok: false, status: 429, headers: { get: () => "3600" }, json: async () => ({}) }; }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ result: body.method === "eth_getBalance" ? "0x1" : { tokenBalances: [] } }) };
      }));
      const reader = new AlchemyBalanceReader(makeConfig({ ALCHEMY_API_KEY: "k" }));
      const pending = reader.readBalances(WALLET);
      await vi.advanceTimersByTimeAsync(3_000);
      const snapshot = await pending;
      expect(snapshot.skippedChainIds).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
