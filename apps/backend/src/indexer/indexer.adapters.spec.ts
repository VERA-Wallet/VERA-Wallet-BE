import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AlchemyAdapter, MockAlchemyAdapter } from "./indexer.adapters";
import { SUPPORTED_CHAIN_IDS } from "./chain-registry";
import { MockTransactionRepository } from "./transaction.repository.adapters";

const makeConfig = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const WALLET = "0x1111111111111111111111111111111111111111";
const CP = "0x2222222222222222222222222222222222222222";
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TS = "2025-01-01T00:00:00.000Z";

type Spec =
  | { transfers?: unknown[]; pageKey?: string }
  | { httpStatus: number }
  | { rpcError: string }
  | { reject: true }
  | { raw: unknown };

interface CallRecord {
  network: string;
  direction: "in" | "out";
  method: string;
  params: Record<string, any>;
}

function makeFetch(map: Record<string, Spec[]>, calls: CallRecord[]) {
  const counters: Record<string, number> = {};
  return vi.fn(async (url: string, init: any) => {
    const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
    const body = JSON.parse(init.body);
    if (body.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
    const params = body.params[0];
    const direction: "in" | "out" = params.toAddress ? "in" : "out";
    const key = `${network}:${direction}`;
    calls.push({ network, direction, method: body.method, params });
    const seq = map[key] ?? [{ transfers: [] }];
    const index = counters[key] ?? 0;
    counters[key] = index + 1;
    const spec = seq[Math.min(index, seq.length - 1)] as any;
    if (spec.reject) throw new Error("network down");
    if ("raw" in spec) return { ok: true, status: 200, json: async () => spec.raw };
    if (spec.httpStatus) return { ok: false, status: spec.httpStatus, json: async () => ({}) };
    if (spec.rpcError) return { ok: true, status: 200, json: async () => ({ error: { message: spec.rpcError } }) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { transfers: spec.transfers ?? [], ...(spec.pageKey ? { pageKey: spec.pageKey } : {}) } }),
    };
  });
}

const erc20 = (hash: string, log: number, from: string, to: string, contract: string, asset: string, value = "0x0de0b6b3a7640000") => ({
  uniqueId: `${hash}:log:${log}`,
  category: "erc20",
  from,
  to,
  asset,
  hash,
  rawContract: { value, address: contract, decimal: "0x12" },
  metadata: { blockTimestamp: TS },
});

const nativeIn = (hash: string, log = 0, value = "0x0de0b6b3a7640000") => ({
  uniqueId: `${hash}:log:${log}`,
  category: "external",
  from: CP,
  to: WALLET,
  asset: "ETH",
  hash,
  rawContract: { value, address: null, decimal: null },
  metadata: { blockTimestamp: TS },
});

const run = async (map: Record<string, Spec[]>, calls: CallRecord[] = [], apiKey: string | undefined = "key") => {
  vi.stubGlobal("fetch", makeFetch(map, calls));
  // 429 retry backoff is real time; keep it negligible so rate-limit tests stay fast.
  const adapter = new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: apiKey, ALCHEMY_RETRY_BASE_MS: "1" }));
  return (await adapter.fetchTransactions(WALLET)).transactions;
};

// Full ChainScanResult (for chainHeads / partial-outage assertions).
const runFull = async (map: Record<string, Spec[]>, calls: CallRecord[] = [], apiKey: string | undefined = "key") => {
  vi.stubGlobal("fetch", makeFetch(map, calls));
  return new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: apiKey, ALCHEMY_RETRY_BASE_MS: "1" })).fetchTransactions(WALLET, undefined);
};

afterEach(() => vi.unstubAllGlobals());

describe("MockAlchemyAdapter (parity)", () => {
  it("still returns the 25 fixtures with registry chain ids", async () => {
    const out = (await new MockAlchemyAdapter().fetchTransactions("0xabc")).transactions;
    expect(out).toHaveLength(25);
    expect(out[0].payload.chain_id).toBe(1);
    const chainIds = [...new Set(out.map((t) => t.payload.chain_id))].sort((a, b) => Number(a) - Number(b));
    expect(chainIds).toEqual([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b));
    expect(out[0].txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("AlchemyAdapter guard + request shape", () => {
  it("throws 503 and never calls fetch without ALCHEMY_API_KEY (AC8)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new AlchemyAdapter(makeConfig({}));
    await expect(adapter.fetchTransactions(WALLET)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends one IN and one OUT per host with the registry category set (AC4)", async () => {
    const calls: CallRecord[] = [];
    await run({}, calls);
    expect(calls).toHaveLength(10);
    for (const network of ["eth-mainnet", "base-mainnet", "arb-mainnet", "opt-mainnet", "polygon-mainnet"]) {
      const inbound = calls.find((c) => c.network === network && c.direction === "in");
      const outbound = calls.find((c) => c.network === network && c.direction === "out");
      expect(inbound?.params.toAddress).toBe(WALLET);
      expect(outbound?.params.fromAddress).toBe(WALLET);
      expect(inbound?.method).toBe("alchemy_getAssetTransfers");
      expect(inbound?.params).toMatchObject({ withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", order: "asc" });
    }
    expect(calls.find((c) => c.network === "eth-mainnet")?.params.category).toEqual([
      "external",
      "internal",
      "erc20",
      "erc721",
      "erc1155",
    ]);
    expect(calls.find((c) => c.network === "arb-mainnet")?.params.category).toEqual(["external", "erc20", "erc721", "erc1155"]);
    expect(calls.find((c) => c.network === "opt-mainnet")?.params.category).toEqual(["external", "erc20", "erc721", "erc1155"]);
  });
});

describe("AlchemyAdapter fan-out, pagination, failures", () => {
  it("merges IN+OUT across multiple chains (AC1)", async () => {
    const out = await run({
      "eth-mainnet:in": [{ transfers: [nativeIn("0x" + "a".repeat(64))] }],
      "base-mainnet:out": [{ transfers: [erc20("0x" + "b".repeat(64), 0, WALLET, CP, TOKEN_A, "AAA")] }],
    });
    const chainIds = out.map((t) => t.payload.chain_id).sort((a, b) => Number(a) - Number(b));
    expect(chainIds).toEqual([1, 8453]);
  });

  it("drains all pages via pageKey and stops on a terminal empty key (AC2)", async () => {
    const calls: CallRecord[] = [];
    const hash1 = "0x" + "c".repeat(64);
    const hash2 = "0x" + "d".repeat(64);
    const out = await run(
      {
        "eth-mainnet:in": [
          { transfers: [nativeIn(hash1)], pageKey: "pk1" },
          { transfers: [nativeIn(hash2)], pageKey: "" },
        ],
      },
      calls,
    );
    const ethInCalls = calls.filter((c) => c.network === "eth-mainnet" && c.direction === "in");
    expect(ethInCalls).toHaveLength(2);
    expect(ethInCalls[1].params.pageKey).toBe("pk1");
    const ethHashes = out.filter((t) => t.payload.chain_id === 1).map((t) => t.payload.tx_hash);
    expect(ethHashes).toContain(hash1);
    expect(ethHashes).toContain(hash2);
  });

  it("withholds the whole chain when one direction call fails, keeps other chains (AC5)", async () => {
    const out = await run({
      "eth-mainnet:in": [{ transfers: [nativeIn("0x" + "e".repeat(64))] }],
      "eth-mainnet:out": [{ reject: true }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "f".repeat(64))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("treats non-2xx and JSON-RPC errors as chain failures (AC6)", async () => {
    const out = await run({
      "eth-mainnet:in": [{ httpStatus: 429 }],
      "base-mainnet:in": [{ rpcError: "boom" }],
      "arb-mainnet:in": [{ transfers: [nativeIn("0x" + "1".repeat(64))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 42161)).toBe(true);
  });
});

describe("AlchemyAdapter truthful empty/outage boundary (AC7, AC21)", () => {
  it("returns [] when every chain is complete and empty (AC7a)", async () => {
    await expect(run({})).resolves.toEqual([]);
  });

  it("throws when every chain fails (AC7b)", async () => {
    const failAll: Record<string, Spec[]> = {};
    for (const net of ["eth-mainnet", "base-mainnet", "arb-mainnet", "opt-mainnet", "polygon-mainnet"]) {
      failAll[`${net}:in`] = [{ reject: true }];
    }
    await expect(run(failAll)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("holds a failed chain while others complete-empty (partial, not total outage) (AC7c)", async () => {
    const r = await runFull({ "eth-mainnet:in": [{ reject: true }] });
    expect(r.chainHeads[1]).toBeUndefined(); // eth held
    expect(r.chainHeads[8453]).toBeDefined(); // other chains observed
    expect(r.transactions).toHaveLength(0);
  });

  it("returns partial rows when a chain is skipped but others have data (AC7d)", async () => {
    const out = await run({
      "eth-mainnet:in": [{ reject: true }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "2".repeat(64))] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].payload.chain_id).toBe(8453);
  });

  it("holds a normalization-skipped chain, absent from chainHeads (AC21)", async () => {
    const badNative = { ...nativeIn("0x" + "3".repeat(64)), rawContract: { value: null, address: null, decimal: null } };
    const r = await runFull({ "eth-mainnet:in": [{ transfers: [badNative] }] });
    expect(r.chainHeads[1]).toBeUndefined();
    expect(r.transactions.some((t) => t.payload.chain_id === 1)).toBe(false);
  });

  it("throws only on TOTAL outage when every chain is skipped (AC21/AC7)", async () => {
    const badNative = { ...nativeIn("0x" + "3a".repeat(32)), rawContract: { value: null, address: null, decimal: null } };
    const map: Record<string, Spec[]> = {};
    for (const net of ["eth-mainnet", "base-mainnet", "arb-mainnet", "opt-mainnet", "polygon-mainnet"]) map[`${net}:in`] = [{ transfers: [badNative] }];
    await expect(runFull(map)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("AlchemyAdapter normalization (section 6.1)", () => {
  it("maps asset_type per category and every non-null field (AC3, AC10)", async () => {
    const hNative = "0x" + "10".repeat(32);
    const hErc20 = "0x" + "11".repeat(32);
    const h721 = "0x" + "12".repeat(32);
    const h1155 = "0x" + "13".repeat(32);
    const out = await run({
      "eth-mainnet:in": [
        {
          transfers: [
            nativeIn(hNative),
            { uniqueId: `${h721}:log:0`, category: "erc721", from: CP, to: WALLET, asset: "KITTY", hash: h721, tokenId: "0x64", rawContract: { value: null, address: TOKEN_A, decimal: null }, metadata: { blockTimestamp: TS } },
            {
              uniqueId: `${h1155}:log:0`,
              category: "erc1155",
              from: CP,
              to: WALLET,
              asset: null,
              hash: h1155,
              rawContract: { value: null, address: TOKEN_B, decimal: null },
              erc1155Metadata: [
                { tokenId: "0x1", value: "0x2" },
                { tokenId: "0x5", value: "0x1" },
              ],
              metadata: { blockTimestamp: TS },
            },
          ],
        },
      ],
      "eth-mainnet:out": [{ transfers: [erc20(hErc20, 0, WALLET, CP, TOKEN_A, "AAA")] }],
    });

    const native = out.find((t) => t.payload.tx_hash === hNative)!;
    expect(native.payload).toMatchObject({
      asset_type: "NATIVE",
      asset_contract: null,
      token_id: null,
      decimals: 18,
      direction: "IN",
      gas_fee_native: "0",
      price_status: "UNKNOWN",
      fiat_value: null,
      fiat_currency: "KRW",
      user_override: null,
      symbol: "ETH",
      chain_id: 1,
    });
    expect(native.payload.id).toBe(`1:${hNative}:log:0`);
    expect(typeof native.payload.confidence).toBe("number");

    const token = out.find((t) => t.payload.tx_hash === hErc20)!;
    expect(token.payload).toMatchObject({ asset_type: "ERC20", asset_contract: TOKEN_A, decimals: 18, direction: "OUT", symbol: "AAA" });

    const nft = out.find((t) => t.payload.tx_hash === h721)!;
    expect(nft.payload).toMatchObject({ asset_type: "ERC721", token_id: "100", decimals: 0, raw_amount: "1" });

    const batch = out.filter((t) => t.payload.tx_hash === h1155);
    expect(batch).toHaveLength(2);
    expect(batch.map((t) => t.payload.token_id).sort()).toEqual(["1", "5"]);
    // symbol-less token falls back to UNKNOWN, never the native symbol
    expect(batch[0].payload.symbol).toBe("UNKNOWN");
    // every field non-undefined
    for (const field of ["id", "tx_hash", "chain_id", "log_index", "block_timestamp", "wallet_address", "direction", "asset_type", "decimals", "raw_amount", "counterparty", "gas_fee_native", "classification", "confidence", "price_status", "fiat_currency"]) {
      expect((native.payload as any)[field]).not.toBeUndefined();
    }
  });
});

describe("AlchemyAdapter classification + canonical asset equality (AC9)", () => {
  const swapConfig = (inContract: string, outContract: string, inAsset: string, outAsset: string) => {
    const hash = "0x" + "20".repeat(32);
    return {
      "eth-mainnet:in": [{ transfers: [erc20(hash, 0, CP, WALLET, inContract, inAsset)] }],
      "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, CP, outContract, outAsset)] }],
    } as Record<string, Spec[]>;
  };

  it("splits a swap into an OUT EXCHANGE (disposal) + IN RECEIVE (acquisition), both above the FE floor (AC9)", async () => {
    const out = await run(swapConfig(TOKEN_A, TOKEN_B, "AAA", "BBB"));
    expect(out).toHaveLength(2);
    const sent = out.find((t) => t.payload.direction === "OUT")!;
    const received = out.find((t) => t.payload.direction === "IN")!;
    expect(sent.eventType).toBe("swap");
    expect(sent.payload.classification).toBe("EXCHANGE");
    expect(sent.payload).not.toHaveProperty("income_kind");
    expect(received.eventType).toBe("transfer_in");
    expect(received.payload.classification).toBe("RECEIVE");
    expect(received.payload.income_kind).toBeNull();
    // Both legs sit above the FE review floor (0.5) so the FE pairs them into one ledger line.
    expect(out.every((t) => t.payload.confidence === 0.6)).toBe(true);
    // Pairing key: both sides carry ONE deterministic opaque group_id (chain:txHash).
    expect(sent.payload.group_id).toBe("1:0x" + "20".repeat(32));
    expect(received.payload.group_id).toBe(sent.payload.group_id);
  });

  it("uses contract identity, not symbol: equal symbol + different contract is still a swap", async () => {
    const out = await run(swapConfig(TOKEN_A, TOKEN_B, "USDC", "USDC"));
    expect(out.find((t) => t.payload.direction === "OUT")!.payload.classification).toBe("EXCHANGE");
    expect(out.find((t) => t.payload.direction === "IN")!.payload.classification).toBe("RECEIVE");
  });

  it("collapses a split-route swap side into ONE amount-summed event per asset (exactly 2 total)", async () => {
    const hash = "0x" + "24".repeat(32);
    // Router sends OUT the same TOKEN_A across 3 transfers (1 ETH each) and returns 1 TOKEN_B.
    const out = await run({
      "eth-mainnet:out": [{ transfers: [
        erc20(hash, 0, WALLET, CP, TOKEN_A, "AAA"),
        erc20(hash, 1, WALLET, CP, TOKEN_A, "AAA"),
        erc20(hash, 2, WALLET, CP, TOKEN_A, "AAA"),
      ] }],
      "eth-mainnet:in": [{ transfers: [erc20(hash, 3, CP, WALLET, TOKEN_B, "BBB")] }],
    });
    expect(out).toHaveLength(2);
    const sent = out.find((t) => t.payload.direction === "OUT")!;
    const received = out.find((t) => t.payload.direction === "IN")!;
    // 3 x 1e18 summed into one disposal amount.
    expect(sent.payload.raw_amount).toBe("3000000000000000000");
    expect(sent.payload.classification).toBe("EXCHANGE");
    expect(received.payload.raw_amount).toBe("1000000000000000000");
    expect(received.payload.classification).toBe("RECEIVE");
    // Split-route legs still collapse under ONE shared group_id.
    expect(sent.payload.group_id).toBe(`1:${hash}`);
    expect(received.payload.group_id).toBe(sent.payload.group_id);
  });

  it("drops an intra-swap self-transfer leg so the tx still yields exactly the 2 swap sides", async () => {
    const hash = "0x" + "25".repeat(32);
    const self = { uniqueId: `${hash}:log:9`, category: "external", from: WALLET, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x1", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [erc20(hash, 0, CP, WALLET, TOKEN_A, "AAA"), self] }],
      "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, CP, TOKEN_B, "BBB")] }],
    });
    expect(out).toHaveLength(2);
    expect(out.some((t) => t.payload.classification === "INTERNAL_TRANSFER")).toBe(false);
    expect(out.map((t) => t.payload.classification).sort()).toEqual(["EXCHANGE", "RECEIVE"].sort());
  });

  it("treats a 3+ distinct-asset multi-hop as UNKNOWN with no group_id (never a swap pair)", async () => {
    const hash = "0x" + "26".repeat(32);
    const nativeOut = { ...nativeIn(hash, 2), from: WALLET, to: CP };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [erc20(hash, 0, CP, WALLET, TOKEN_A, "AAA")] }],
      "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, CP, TOKEN_B, "BBB"), nativeOut] }],
    });
    // inAssets={A}, outAssets={B, native} -> size 2 -> not swapLike -> ambiguous mix.
    expect(out).toHaveLength(3);
    expect(out.every((t) => t.payload.classification === "UNKNOWN")).toBe(true);
    expect(out.every((t) => t.payload.confidence === 0.3)).toBe(true);
    // A non-swap group never carries the pairing key.
    expect(out.every((t) => !("group_id" in t.payload))).toBe(true);
  });

  it("treats same-asset IN+OUT as UNKNOWN, not a swap", async () => {
    const out = await run(swapConfig(TOKEN_A, TOKEN_A, "AAA", "AAA"));
    expect(out.every((t) => t.payload.classification === "UNKNOWN")).toBe(true);
    expect(out.every((t) => t.payload.confidence === 0.3)).toBe(true);
  });

  it("classifies pure IN as RECEIVE and pure OUT as SEND", async () => {
    const out = await run({
      "eth-mainnet:in": [{ transfers: [nativeIn("0x" + "21".repeat(32))] }],
      "eth-mainnet:out": [{ transfers: [erc20("0x" + "22".repeat(32), 0, WALLET, CP, TOKEN_A, "AAA")] }],
    });
    const recv = out.find((t) => t.payload.direction === "IN")!;
    const send = out.find((t) => t.payload.direction === "OUT")!;
    expect(recv.payload.classification).toBe("RECEIVE");
    expect(recv.eventType).toBe("transfer_in");
    expect(send.payload.classification).toBe("SEND");
    expect(send.eventType).toBe("transfer_out");
    // Non-swap legs carry NO group_id (nothing to pair).
    expect(recv.payload).not.toHaveProperty("group_id");
    expect(send.payload).not.toHaveProperty("group_id");
  });

  it("tags an inbound-only NFT (ERC721/ERC1155) as SPAM, not RECEIVE, keeping direction/eventType inbound", async () => {
    const h721 = "0x" + "91".repeat(32);
    const h1155 = "0x" + "92".repeat(32);
    const out = await run({
      "eth-mainnet:in": [{ transfers: [
        { uniqueId: `${h721}:log:0`, category: "erc721", from: CP, to: WALLET, asset: "KITTY", hash: h721, tokenId: "0x1", rawContract: { value: null, address: TOKEN_A, decimal: null }, metadata: { blockTimestamp: TS } },
        { uniqueId: `${h1155}:log:0`, category: "erc1155", from: CP, to: WALLET, asset: null, hash: h1155, rawContract: { value: null, address: TOKEN_B, decimal: null }, erc1155Metadata: [{ tokenId: "0x1", value: "0x1" }], metadata: { blockTimestamp: TS } },
      ] }],
    });
    expect(out.every((t) => t.payload.classification === "SPAM")).toBe(true);
    expect(out.every((t) => t.payload.confidence === 0)).toBe(true);
    expect(out.every((t) => t.payload.direction === "IN" && t.eventType === "transfer_in")).toBe(true);
  });

  it("tags an inbound ERC20 with a weaponized symbol as SPAM but keeps a clean ticker as RECEIVE", async () => {
    const scam = "0x" + "93".repeat(32);
    const good = "0x" + "94".repeat(32);
    const out = await run({
      "eth-mainnet:in": [{ transfers: [
        erc20(scam, 0, CP, WALLET, TOKEN_A, "claim-at-uni.fi"),
        erc20(good, 0, CP, WALLET, TOKEN_B, "DAI"),
      ] }],
    });
    expect(out.find((t) => t.payload.tx_hash === scam)!.payload.classification).toBe("SPAM");
    expect(out.find((t) => t.payload.tx_hash === good)!.payload.classification).toBe("RECEIVE");
  });

  it("never tags a swap leg as SPAM even when an inbound NFT is one side", async () => {
    const hash = "0x" + "95".repeat(32);
    const out = await run({
      "eth-mainnet:in": [{ transfers: [{ uniqueId: `${hash}:log:0`, category: "erc721", from: CP, to: WALLET, asset: "KITTY", hash, tokenId: "0x1", rawContract: { value: null, address: TOKEN_A, decimal: null }, metadata: { blockTimestamp: TS } }] }],
      "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, CP, TOKEN_B, "AAA")] }],
    });
    expect(out.some((t) => t.payload.classification === "SPAM")).toBe(false);
    // The NFT is the received (IN) side -> RECEIVE acquisition; the ERC20 is the sent (OUT) disposal.
    expect(out.find((t) => t.payload.direction === "IN")!.payload.classification).toBe("RECEIVE");
    expect(out.find((t) => t.payload.direction === "OUT")!.payload.classification).toBe("EXCHANGE");
  });

  it("dedupes a self-transfer seen in both directions into one INTERNAL_TRANSFER (AC14)", async () => {
    const hash = "0x" + "23".repeat(32);
    const self = { uniqueId: `${hash}:log:0`, category: "external", from: WALLET, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x1", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const out = await run({ "eth-mainnet:in": [{ transfers: [self] }], "eth-mainnet:out": [{ transfers: [self] }] });
    expect(out).toHaveLength(1);
    expect(out[0].payload.classification).toBe("INTERNAL_TRANSFER");
    expect(out[0].payload.direction).toBe("OUT");
  });
});

describe("AlchemyAdapter identity (AC11-13)", () => {
  it("uses ${chainId}:${uniqueId} storage key and pure payload.id, distinct per chain (AC11)", async () => {
    const hash = "0x" + "30".repeat(32);
    const out = await run({
      "eth-mainnet:in": [{ transfers: [nativeIn(hash, 5)] }],
      "base-mainnet:in": [{ transfers: [nativeIn(hash, 5)] }],
    });
    const eth = out.find((t) => t.payload.chain_id === 1)!;
    const base = out.find((t) => t.payload.chain_id === 8453)!;
    expect(eth.txHash).toBe(`1:${hash}:log:5`);
    expect(base.txHash).toBe(`8453:${hash}:log:5`);
    expect(eth.txHash).not.toBe(base.txHash);
    expect(eth.payload.tx_hash).toBe(hash);
    expect(eth.payload.log_index).toBe(5);
    // payload.id is the unique storage key (guarantees returned-set uniqueness).
    expect(eth.payload.id).toBe(`1:${hash}:log:5`);
    expect(eth.payload.id).toBe(eth.txHash);
  });

  it("derives a non-negative stable log_index for non-log transfers, pure per transfer (AC11-12; FE contract)", async () => {
    const hash = "0x" + "31".repeat(32);
    const internal = { uniqueId: `${hash}:internal:0`, category: "internal", from: CP, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x1", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const peer = nativeIn("0x" + "32".repeat(32), 0);

    const alone = await run({ "eth-mainnet:in": [{ transfers: [internal] }] });
    const withPeer = await run({ "eth-mainnet:in": [{ transfers: [internal, peer] }] });

    const a = alone.find((t) => t.payload.tx_hash === hash)!;
    const b = withPeer.find((t) => t.payload.tx_hash === hash)!;
    expect(a.payload.log_index).toBe(b.payload.log_index);
    // FE contract requires a non-negative integer log_index.
    expect(Number.isInteger(a.payload.log_index as number)).toBe(true);
    expect(a.payload.log_index as number).toBeGreaterThanOrEqual(0);
  });

  it("marks the whole chain incomplete on a missing uniqueId (AC13)", async () => {
    const bad = { ...nativeIn("0x" + "33".repeat(32)), uniqueId: "" };
    const r = await runFull({ "eth-mainnet:in": [{ transfers: [bad] }] });
    expect(r.chainHeads[1]).toBeUndefined();
  });
});

describe("AlchemyAdapter chain-atomic persistence (AC15, AC20)", () => {
  const swapLegs = () => ({
    "eth-mainnet:in": [{ transfers: [erc20("0x" + "40".repeat(32), 0, CP, WALLET, TOKEN_A, "AAA")] }],
    "eth-mainnet:out": [{ transfers: [erc20("0x" + "40".repeat(32), 1, WALLET, CP, TOKEN_B, "BBB")] }],
    "base-mainnet:in": [{ transfers: [nativeIn("0x" + "41".repeat(32))] }],
  }) as Record<string, Spec[]>;

  const ethRows = (repo: MockTransactionRepository) =>
    repo.listForUser("u1").then((rows) => rows.filter((r) => String(r.payload.chain_id) === "1"));

  it("stores zero eth rows when a direction call fails, then two swap rows on recovery (AC15)", async () => {
    const repo = new MockTransactionRepository();
    const failed = swapLegs();
    failed["eth-mainnet:out"] = [{ reject: true }];

    const sync1 = await run(failed);
    await repo.save("b1", "u1", sync1);
    expect(await ethRows(repo)).toHaveLength(0);

    const sync2 = await run(swapLegs());
    await repo.save("b1", "u1", sync2);
    const rows = await ethRows(repo);
    expect(rows).toHaveLength(2);
    // A swap persists as its two sides: an OUT EXCHANGE (swap) + an IN RECEIVE (transfer_in).
    expect(rows.map((r) => r.eventType).sort()).toEqual(["swap", "transfer_in"].sort());
    expect(rows.find((r) => r.eventType === "swap")!.payload.classification).toBe("EXCHANGE");
    expect(rows.find((r) => r.eventType === "transfer_in")!.payload.classification).toBe("RECEIVE");
    expect(rows.every((r) => String(r.payload.tx_hash) === "0x" + "40".repeat(32))).toBe(true);
    expect(new Set(rows.map((r) => r.payload.id)).size).toBe(2);

    await repo.save("b1", "u1", await run(swapLegs()));
    expect(await ethRows(repo)).toHaveLength(2);
  });

  it("stores no provisional row when one leg is malformed, no stale row after recovery (AC20)", async () => {
    const repo = new MockTransactionRepository();
    const malformed = swapLegs();
    // OUT leg amount unparseable -> chain-fatal skip on sync 1.
    malformed["eth-mainnet:out"] = [{ transfers: [{ ...erc20("0x" + "40".repeat(32), 1, WALLET, CP, TOKEN_B, "BBB"), rawContract: { value: null, address: TOKEN_B, decimal: "0x12" } }] }];

    const sync1 = await run(malformed);
    await repo.save("b1", "u1", sync1);
    expect(await ethRows(repo)).toHaveLength(0);

    const sync2 = await run(swapLegs());
    await repo.save("b1", "u1", sync2);
    const rows = await ethRows(repo);
    expect(rows).toHaveLength(2);
    // Recovery yields the clean swap pair (OUT EXCHANGE + IN RECEIVE), no stale provisional rows.
    expect(rows.map((r) => r.eventType).sort()).toEqual(["swap", "transfer_in"].sort());
    expect(rows.map((r) => r.payload.classification).sort()).toEqual(["EXCHANGE", "RECEIVE"].sort());
  });
});

describe("AlchemyAdapter malformed rows are chain-fatal (AC17)", () => {
  it("skips the chain for a token transfer missing rawContract.address", async () => {
    const bad = { uniqueId: "0x" + "50".repeat(32) + ":log:0", category: "erc20", from: CP, to: WALLET, asset: "AAA", hash: "0x" + "50".repeat(32), rawContract: { value: "0x1", address: null, decimal: "0x12" }, metadata: { blockTimestamp: TS } };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [bad] }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "51".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("skips the chain for a transfer matching neither wallet side", async () => {
    const bad = { ...nativeIn("0x" + "52".repeat(32)), from: CP, to: CP };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [bad] }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "53".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("skips the chain for an unknown transfer category", async () => {
    const bad = { ...nativeIn("0x" + "54".repeat(32)), category: "weird" };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [bad] }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "55".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("skips the chain for an oversized (non-safe-integer) :log:N index", async () => {
    const hash = "0x" + "56".repeat(32);
    const bad = { ...nativeIn(hash), uniqueId: `${hash}:log:99999999999999999999999` };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [bad] }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "57".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("skips the chain for empty ERC1155 metadata and for an invalid timestamp", async () => {
    const emptyBatch = { uniqueId: "0x" + "58".repeat(32) + ":log:0", category: "erc1155", from: CP, to: WALLET, asset: "X", hash: "0x" + "58".repeat(32), rawContract: { value: null, address: TOKEN_A, decimal: null }, erc1155Metadata: [], metadata: { blockTimestamp: TS } };
    expect((await runFull({ "eth-mainnet:in": [{ transfers: [emptyBatch] }] })).chainHeads[1]).toBeUndefined();
    const badTs = { ...nativeIn("0x" + "59".repeat(32)), metadata: { blockTimestamp: "not-a-date" } };
    expect((await runFull({ "eth-mainnet:in": [{ transfers: [badTs] }] })).chainHeads[1]).toBeUndefined();
  });
});

describe("AlchemyAdapter hardened response validation (generation 2)", () => {
  it("treats a malformed 2xx body (missing result) as a chain failure, not empty-complete", async () => {
    const out = await run({
      "eth-mainnet:in": [{ raw: { jsonrpc: "2.0", id: 1 } }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "60".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
  });

  it("treats non-array transfers and a non-string pageKey as chain failures (held)", async () => {
    expect((await runFull({ "eth-mainnet:in": [{ raw: { result: { transfers: "nope" } } }] })).chainHeads[1]).toBeUndefined();
    expect(
      (await runFull({ "eth-mainnet:in": [{ raw: { result: { transfers: [nativeIn("0x" + "61".repeat(32))], pageKey: 42 } } }] })).chainHeads[1],
    ).toBeUndefined();
  });

  it("marks the chain incomplete on a repeated pageKey (holds, no rows)", async () => {
    const hash1 = "0x" + "62".repeat(32);
    const hash2 = "0x" + "63".repeat(32);
    const out = await run({
      "eth-mainnet:in": [
        { transfers: [nativeIn(hash1)], pageKey: "loop" },
        { transfers: [nativeIn(hash2)], pageKey: "loop" },
      ],
    });
    // A repeated pageKey is not proof of completion -> the whole eth chain is withheld.
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
  });

  it("skips a direction that never terminates its pageKey (MAX_PAGES truncation)", async () => {
    let counter = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: any) => {
        const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
        const parsed = JSON.parse(init.body);
        if (parsed.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
        const params = parsed.params[0];
        if (network === "eth-mainnet" && params.toAddress) {
          counter += 1;
          return { ok: true, status: 200, json: async () => ({ result: { transfers: [], pageKey: `pk-${counter}` } }) };
        }
        if (network === "base-mainnet" && params.toAddress) {
          return { ok: true, status: 200, json: async () => ({ result: { transfers: [nativeIn("0x" + "64".repeat(32))] } }) };
        }
        return { ok: true, status: 200, json: async () => ({ result: { transfers: [] } }) };
      }),
    );
    const adapter = new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key" }));
    const out = (await adapter.fetchTransactions(WALLET)).transactions;
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.some((t) => t.payload.chain_id === 8453)).toBe(true);
    expect(counter).toBeLessThanOrEqual(101);
  });
});

describe("AlchemyAdapter generation-2 identity + classification + parity", () => {
  it("gives distinct payload.id to two non-log transfers sharing a pureHash (AC11 uniqueness)", async () => {
    const hash = "0x" + "70".repeat(32);
    const legA = { uniqueId: `${hash}:internal:0`, category: "internal", from: CP, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x1", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const legB = { uniqueId: `${hash}:internal:1_2`, category: "internal", from: CP, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x2", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const out = await run({ "eth-mainnet:in": [{ transfers: [legA, legB] }] });
    const eth = out.filter((t) => t.payload.chain_id === 1);
    expect(eth).toHaveLength(2);
    expect(new Set(eth.map((t) => t.payload.id)).size).toBe(2);
    expect(new Set(eth.map((t) => t.txHash)).size).toBe(2);
  });

  it("treats checksum-case variants of one contract as the same asset (UNKNOWN, not swap)", async () => {
    const hash = "0x" + "71".repeat(32);
    const upper = TOKEN_A.toUpperCase().replace("0X", "0x");
    const out = await run({
      "eth-mainnet:in": [{ transfers: [erc20(hash, 0, CP, WALLET, TOKEN_A, "AAA")] }],
      "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, CP, upper, "AAA")] }],
    });
    expect(out.every((t) => t.payload.classification === "UNKNOWN")).toBe(true);
  });

  it("classifies a mixed self + non-self group per leg", async () => {
    const hash = "0x" + "72".repeat(32);
    const self = { uniqueId: `${hash}:log:0`, category: "external", from: WALLET, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x1", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const recv = { uniqueId: `${hash}:log:1`, category: "external", from: CP, to: WALLET, asset: "ETH", hash, rawContract: { value: "0x2", address: null, decimal: null }, metadata: { blockTimestamp: TS } };
    const out = await run({ "eth-mainnet:in": [{ transfers: [self, recv] }] });
    const selfLeg = out.find((t) => t.payload.log_index === 0)!;
    const recvLeg = out.find((t) => t.payload.log_index === 1)!;
    expect(selfLeg.payload.classification).toBe("INTERNAL_TRANSFER");
    expect(recvLeg.payload.classification).toBe("RECEIVE");
  });

  it("emits distinct ERC1155 batch legs (AC16)", async () => {
    const hash = "0x" + "73".repeat(32);
    const batch = { uniqueId: `${hash}:log:0`, category: "erc1155", from: CP, to: WALLET, asset: "G", hash, rawContract: { value: null, address: TOKEN_A, decimal: null }, erc1155Metadata: [{ tokenId: "0x1", value: "0x2" }, { tokenId: "0x5", value: "0x9" }], metadata: { blockTimestamp: TS } };
    const out = await run({ "eth-mainnet:in": [{ transfers: [batch] }] });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((t) => t.payload.id)).size).toBe(2);
    expect(new Set(out.map((t) => t.txHash)).size).toBe(2);
    expect(out.map((t) => t.payload.raw_amount).sort()).toEqual(["2", "9"]);
    expect(out.map((t) => t.payload.token_id).sort()).toEqual(["1", "5"]);
  });

  it("asserts base/polygon request categories include internal (AC4)", async () => {
    const calls: CallRecord[] = [];
    await run({}, calls);
    expect(calls.find((c) => c.network === "base-mainnet")?.params.category).toEqual(["external", "internal", "erc20", "erc721", "erc1155"]);
    expect(calls.find((c) => c.network === "polygon-mainnet")?.params.category).toEqual(["external", "internal", "erc20", "erc721", "erc1155"]);
  });

  it("returns partial rows when a normalization-skipped chain coexists with a valid chain (AC21 partial)", async () => {
    const badNative = { ...nativeIn("0x" + "74".repeat(32)), rawContract: { value: null, address: null, decimal: null } };
    const out = await run({
      "eth-mainnet:in": [{ transfers: [badNative] }],
      "base-mainnet:in": [{ transfers: [nativeIn("0x" + "75".repeat(32))] }],
    });
    expect(out.some((t) => t.payload.chain_id === 1)).toBe(false);
    expect(out.filter((t) => t.payload.chain_id === 8453)).toHaveLength(1);
  });

  it("keeps mock fixtures byte-identical after the registry refactor (AC19)", async () => {
    const out = (await new MockAlchemyAdapter().fetchTransactions("0xabc")).transactions;
    expect(out.map((t) => t.payload.chain_id)).toEqual(
      Array.from({ length: 25 }, (_, i) => [1, 8453, 42161, 10, 137][i % 5]),
    );
    expect(out[0]).toEqual({
      source: "mock",
      txHash: "0x" + "0".repeat(63) + "1",
      chain: "1",
      eventType: "transfer_in",
      occurredAt: new Date(Date.UTC(2025, 0, 1, 12)),
      payload: {
        id: "event-01",
        tx_hash: "0x" + "0".repeat(63) + "1",
        chain_id: 1,
        log_index: 0,
        block_timestamp: "2025-01-01T12:00:00.000Z",
        wallet_address: "0xabc",
        direction: "IN",
        asset_type: "NATIVE",
        asset_contract: null,
        token_id: null,
        decimals: 18,
        raw_amount: "10000000000000000",
        counterparty: "0x" + (2000).toString(16).padStart(40, "0"),
        gas_fee_native: "0.001",
        classification: "RECEIVE",
        confidence: 0.9,
        user_override: null,
        price_status: "ESTIMATED",
        fiat_value: "1000.00",
        fiat_currency: "KRW",
        symbol: "ETH",
        _version: 1,
        _overrideHistory: [],
      },
    });
  });
});

describe("AlchemyAdapter incremental fetch (fromBlock/toBlock/chainHeads)", () => {
  it("sends fromBlock=cursor and a common toBlock to IN+OUT; omits fromBlock without a cursor (AC5)", async () => {
    const calls: CallRecord[] = [];
    vi.stubGlobal("fetch", makeFetch({}, calls));
    await new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key" })).fetchTransactions(WALLET, { 1: 100n });
    const ethIn = calls.find((c) => c.network === "eth-mainnet" && c.direction === "in");
    const ethOut = calls.find((c) => c.network === "eth-mainnet" && c.direction === "out");
    expect(ethIn?.params.fromBlock).toBe("0x64"); // 100
    expect(ethIn?.params.toBlock).toBe("0xf4240"); // stubbed head
    expect(ethOut?.params.toBlock).toBe(ethIn?.params.toBlock); // common toBlock across directions
    const baseIn = calls.find((c) => c.network === "base-mainnet" && c.direction === "in");
    expect(baseIn?.params.fromBlock).toBeUndefined(); // no cursor -> genesis
    expect(baseIn?.params.toBlock).toBe("0xf4240");
  });

  it("records chainHeads for a completely-observed (even empty) chain (AC2)", async () => {
    const r = await runFull({});
    for (const chainId of SUPPORTED_CHAIN_IDS) expect(r.chainHeads[chainId]).toBe(1000000); // 0xf4240
    expect(r.transactions).toHaveLength(0);
  });

  it("treats a non-0x-hex chain head as incomplete (held, no cursor advance)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
      const parsed = JSON.parse(init.body);
      if (parsed.method === "eth_blockNumber") {
        // eth returns a DECIMAL (not 0x-hex) head -> must be rejected; others valid.
        return { ok: true, status: 200, json: async () => ({ result: network === "eth-mainnet" ? "1000" : "0xf4240" }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: { transfers: [] } }) };
    }));
    const r = await new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key" })).fetchTransactions(WALLET);
    expect(r.chainHeads[1]).toBeUndefined(); // eth held: malformed head
    expect(r.chainHeads[8453]).toBeDefined();
  });
});

describe("AlchemyAdapter bridge suspicion (conservative flag-only)", () => {
  const BRIDGE = "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1"; // Optimism L1StandardBridge on chain 1
  const find = (out: Awaited<ReturnType<typeof run>>, hash: string) => out.find((t) => t.payload.tx_hash === hash)!;

  it("flags a SEND to a bridge contract for review but keeps it SEND (no tax drop)", async () => {
    const hash = "0x" + "71".repeat(32);
    const out = await run({ "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: BRIDGE }] }] });
    const event = find(out, hash);
    expect(event.payload.classification).toBe("SEND"); // classification unchanged -> still a taxable disposal
    expect(event.payload.confidence as number).toBeLessThan(0.5); // FE review floor -> confirm needed
    expect(event.payload.bridge_suspected).toBe(true);
    // A pure bridge SEND (no matching IN) is not a swap pair -> never carries group_id.
    expect(event.payload).not.toHaveProperty("group_id");
  });

  it("flags a RECEIVE from a bridge contract but keeps it RECEIVE", async () => {
    const hash = "0x" + "72".repeat(32);
    const out = await run({ "eth-mainnet:in": [{ transfers: [{ ...nativeIn(hash), from: BRIDGE }] }] });
    const event = find(out, hash);
    expect(event.payload.classification).toBe("RECEIVE");
    expect(event.payload.confidence as number).toBeLessThan(0.5);
    expect(event.payload.bridge_suspected).toBe(true);
  });

  it("leaves a normal SEND to a non-bridge address unchanged (0.9, no flag)", async () => {
    const hash = "0x" + "73".repeat(32);
    const out = await run({ "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: CP }] }] });
    const event = find(out, hash);
    expect(event.payload.classification).toBe("SEND");
    expect(event.payload.confidence).toBe(0.9);
    expect(event.payload).not.toHaveProperty("bridge_suspected");
  });

  it("does not flag a bridge address on a chain where it is not registered", async () => {
    // The OP-stack predeploy is a bridge on chain 10/8453 but NOT on eth-mainnet (chain 1).
    const hash = "0x" + "74".repeat(32);
    const predeploy = "0x4200000000000000000000000000000000000010";
    const out = await run({ "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: predeploy }] }] });
    const event = find(out, hash);
    expect(event.payload.confidence).toBe(0.9);
    expect(event.payload).not.toHaveProperty("bridge_suspected");
  });

  it("flags OUT legs routed through each provider (LI.FI / Across / Stargate) as bridge_suspected (provider path)", async () => {
    // A SEND whose counterparty is a registered provider entrypoint on eth-mainnet becomes the
    // linkable bridge signal the BridgeLinkingService consumes downstream.
    const providers: Record<string, string> = {
      lifi: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI Diamond
      across: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5", // Across SpokePool (eth)
      stargate: "0x77b2043768d28e9c9ab44e1abfc95944bce57931", // Stargate native pool (eth)
    };
    let i = 0;
    for (const [name, address] of Object.entries(providers)) {
      const hash = "0x" + (0x75 + i).toString(16).padStart(2, "0").repeat(32);
      i += 1;
      const out = await run({ "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: address }] }] });
      const event = find(out, hash);
      expect(event.payload.classification, name).toBe("SEND");
      expect(event.payload.bridge_suspected, name).toBe(true);
      expect(event.payload.confidence as number).toBeLessThan(0.5);
    }
  });
});

describe("AlchemyAdapter bounded parallel fan-out", () => {
  it("scans chains concurrently (bounded) but returns transactions in registry order", async () => {
    const calls: CallRecord[] = [];
    const tx = (hexDigit: string) => nativeIn("0x" + hexDigit.repeat(64));
    const out = await run({
      "eth-mainnet:in": [{ transfers: [tx("1")] }],
      "base-mainnet:in": [{ transfers: [tx("2")] }],
      "arb-mainnet:in": [{ transfers: [tx("3")] }],
      "opt-mainnet:in": [{ transfers: [tx("4")] }],
      "polygon-mainnet:in": [{ transfers: [tx("5")] }],
    }, calls);
    expect(out.map((t) => t.payload.chain_id)).toEqual([1, 8453, 42161, 10, 137]);
    // Every chain still scanned both directions exactly once.
    expect(calls).toHaveLength(10);
  });

  it("keeps in-flight chains bounded so a shared CU budget is not burst by five hosts at once", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (body.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
      return { ok: true, status: 200, json: async () => ({ result: { transfers: [] } }) };
    }));
    await new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key" })).fetchTransactions(WALLET);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("retries a 429 with backoff and succeeds when the limiter clears", async () => {
    const attempts: Record<string, number> = {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      if (body.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
      const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
      const key = `${network}:${body.params[0].toAddress ? "in" : "out"}`;
      attempts[key] = (attempts[key] ?? 0) + 1;
      if (key === "eth-mainnet:in" && attempts[key] === 1) {
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) };
      }
      const transfers = key === "eth-mainnet:in" ? [nativeIn("0x" + "a".repeat(64))] : [];
      return { ok: true, status: 200, json: async () => ({ result: { transfers } }) };
    }));
    const out = await new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key", ALCHEMY_RETRY_BASE_MS: "1" })).fetchTransactions(WALLET);
    expect(attempts["eth-mainnet:in"]).toBe(2);
    expect(out.transactions.some((t) => t.payload.chain_id === 1)).toBe(true);
    expect(out.chainHeads[1]).toBe(0xf4240);
  });
});
