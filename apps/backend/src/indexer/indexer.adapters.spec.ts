import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger, ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { AlchemyAdapter, MockAlchemyAdapter } from "./indexer.adapters";
import { CHAIN_REGISTRY, SUPPORTED_CHAIN_IDS } from "./chain-registry";
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
  direction: "in" | "out" | "trace" | "receipt" | "tx" | "balance";
  method: string;
  params: Record<string, any>;
}

// One stubbed JSON-RPC failure: an HTTP status carrying the error, or a 200 carrying it in the body.
interface RpcFailure {
  httpStatus?: number;
  code?: number;
  message: string;
}

// Stubbed `eth_*` chain state for the balance-diff native source, keyed by transaction hash.
// Everything defaults to "the wallet is not involved and nothing moved", so a test that only cares
// about tracing sees no recovered leg instead of a crash when balance-diff runs behind it.
interface ChainState {
  block?: number;
  status?: string;
  gasUsed?: string;
  /** null omits the field from the receipt, as a node that reports no effective gas price would. */
  effectiveGasPrice?: string | null;
  l1Fee?: string;
  from?: string;
  to?: string | null;
  value?: string;
  gasPrice?: string;
  /** Wallet native balance at `block - 1` and at `block`. */
  before?: string;
  after?: string;
  missingReceipt?: true;
  receiptFailure?: RpcFailure;
  txFailure?: RpcFailure;
  balanceFailure?: RpcFailure;
}

// One stubbed `debug_traceTransaction` response, keyed by transaction hash.
type TraceSpec =
  | { root: unknown }
  | { httpStatus: number; error?: { code?: number; message: string } }
  | { rpcError: string; code?: number };

// A trace with no sub-frames: the default for any hash the test did not stub, so an unexpected
// trace call is visible as "no recovered legs" rather than as a crash.
const emptyTrace = () => ({ type: "CALL", from: WALLET, to: CP, value: "0x0", gas: "0x1", gasUsed: "0x1", input: "0x" });

function makeFetch(
  map: Record<string, Spec[]>,
  calls: CallRecord[],
  traces: Record<string, TraceSpec> = {},
  states: Record<string, ChainState> = {},
) {
  const counters: Record<string, number> = {};
  const DEFAULTS = { status: "0x1", gasUsed: "0x0", effectiveGasPrice: "0x0" as string | null, from: CP, to: CP as string | null, value: "0x0", before: "0x0", after: "0x0" };
  // Distinct per hash so two unrelated candidates never land in one block and trip the ambiguity guard.
  const blockOf = (hash: string) => states[hash]?.block ?? 1_000_000 + Number.parseInt(hash.slice(2, 6), 16);
  const stateOf = (hash: string) => ({ ...DEFAULTS, ...states[hash], block: states[hash]?.block ?? blockOf(hash) });
  const hexOf = (block: number) => `0x${block.toString(16)}`;
  const balanceAt = (tag: string) => {
    for (const hash of Object.keys(states)) {
      const state = stateOf(hash);
      if (tag === hexOf(state.block)) return state.after;
      if (tag === hexOf(state.block - 1)) return state.before;
    }
    return "0x0";
  };
  const failed = (failure: RpcFailure) =>
    failure.httpStatus === undefined
      ? { ok: true, status: 200, json: async () => ({ error: { code: failure.code, message: failure.message } }) }
      : { ok: false, status: failure.httpStatus, headers: { get: () => null }, json: async () => ({ error: { code: failure.code, message: failure.message } }) };
  const balanceFailure = Object.values(states).find((state) => state.balanceFailure)?.balanceFailure;

  return vi.fn(async (url: string, init: any) => {
    const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
    const body = JSON.parse(init.body);
    if (body.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
    if (body.method === "eth_getTransactionReceipt") {
      const hash = body.params[0];
      calls.push({ network, direction: "receipt", method: body.method, params: { hash } });
      const state = stateOf(hash);
      if (state.receiptFailure) return failed(state.receiptFailure);
      const receipt = state.missingReceipt
        ? null
        : {
            blockNumber: hexOf(state.block),
            status: state.status,
            gasUsed: state.gasUsed,
            ...(state.effectiveGasPrice === null ? {} : { effectiveGasPrice: state.effectiveGasPrice }),
            ...(state.l1Fee === undefined ? {} : { l1Fee: state.l1Fee }),
          };
      return { ok: true, status: 200, json: async () => ({ result: receipt }) };
    }
    if (body.method === "eth_getTransactionByHash") {
      const hash = body.params[0];
      calls.push({ network, direction: "tx", method: body.method, params: { hash } });
      const state = stateOf(hash);
      if (state.txFailure) return failed(state.txFailure);
      const transaction = { from: state.from, to: state.to, value: state.value, ...(state.gasPrice === undefined ? {} : { gasPrice: state.gasPrice }) };
      return { ok: true, status: 200, json: async () => ({ result: transaction }) };
    }
    if (body.method === "eth_getBalance") {
      const [account, tag] = body.params;
      calls.push({ network, direction: "balance", method: body.method, params: { account, tag } });
      // A declared balance failure applies to the reads of ITS transaction (block - 1 and block), so one
      // archive-gated candidate can sit next to a healthy one. A state without a block keeps the old
      // "every balance read fails" behaviour.
      const gated = Object.values(states).find(
        (state) => state.balanceFailure && (typeof state.block !== "number" || tag === `0x${state.block.toString(16)}` || tag === `0x${(state.block - 1).toString(16)}`),
      );
      if (gated?.balanceFailure) return failed(gated.balanceFailure);
      if (balanceFailure && Object.values(states).every((state) => typeof state.block !== "number")) return failed(balanceFailure);
      return { ok: true, status: 200, json: async () => ({ result: balanceAt(tag) }) };
    }
    if (body.method === "debug_traceTransaction") {
      const hash = body.params[0];
      calls.push({ network, direction: "trace", method: body.method, params: { hash, options: body.params[1] } });
      const spec = traces[hash];
      if (spec && "httpStatus" in spec) {
        return { ok: false, status: spec.httpStatus, headers: { get: () => null }, json: async () => (spec.error ? { error: spec.error } : {}) };
      }
      if (spec && "rpcError" in spec) {
        return { ok: true, status: 200, json: async () => ({ error: { message: spec.rpcError, ...(spec.code === undefined ? {} : { code: spec.code }) } }) };
      }
      return { ok: true, status: 200, json: async () => ({ result: spec ? spec.root : emptyTrace() }) };
    }
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

// Full ChainScanResult with stubbed callTracer traces (native-value recovery on NO_INTERNAL chains).
const runTraced = async (
  map: Record<string, Spec[]>,
  traces: Record<string, TraceSpec>,
  calls: CallRecord[] = [],
  states: Record<string, ChainState> = {},
) => {
  vi.stubGlobal("fetch", makeFetch(map, calls, traces, states));
  return new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key", ALCHEMY_RETRY_BASE_MS: "1" })).fetchTransactions(WALLET, undefined);
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

  it("labels a leg routed through the Across SpokePool on Arbitrum with the curated display name", async () => {
    const ACROSS_ARB = "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a"; // Across: SpokePool, chain 42161
    const hash = "0x" + "79".repeat(32);
    const out = await run({ "arb-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: ACROSS_ARB }] }] });
    const event = find(out, hash);
    expect(event.payload.bridge_suspected).toBe(true);
    expect(event.payload.counterparty_label).toBe("Across: SpokePool");
  });

  it("omits counterparty_label entirely (never writes null) for a leg with an unknown counterparty", async () => {
    const hash = "0x" + "7a".repeat(32);
    const out = await run({ "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash), from: WALLET, to: CP }] }] });
    const event = find(out, hash);
    expect(event.payload).not.toHaveProperty("counterparty_label");
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

  it("retries a bare 503 (gateway hiccup) but not a 503 that carries a JSON-RPC error (the provider answered)", async () => {
    for (const [name, withBody, expectedAttempts, chainPresent] of [
      ["bare", false, 2, true],
      ["json-rpc error", true, 1, false],
    ] as const) {
      const attempts: Record<string, number> = {};
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
        const body = JSON.parse(init.body);
        if (body.method === "eth_blockNumber") return { ok: true, status: 200, json: async () => ({ result: "0xf4240" }) };
        const network = /https:\/\/([^.]+)\.g\.alchemy\.com/.exec(url)?.[1] ?? "";
        const key = `${network}:${body.params[0].toAddress ? "in" : "out"}`;
        attempts[key] = (attempts[key] ?? 0) + 1;
        if (key === "eth-mainnet:in" && attempts[key] === 1) {
          const envelope = withBody ? { error: { code: -32001, message: "Unable to complete request at this time." } } : {};
          return { ok: false, status: 503, headers: { get: () => null }, clone: () => ({ json: async () => envelope }), json: async () => envelope };
        }
        const transfers = key === "eth-mainnet:in" ? [nativeIn("0x" + "a".repeat(64))] : [];
        return { ok: true, status: 200, json: async () => ({ result: { transfers } }) };
      }));
      const out = await new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key", ALCHEMY_RETRY_BASE_MS: "1" })).fetchTransactions(WALLET);
      expect(attempts["eth-mainnet:in"], name).toBe(expectedAttempts);
      expect(out.chainHeads[1] !== undefined, name).toBe(chainPresent);
      vi.unstubAllGlobals();
    }
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

// ---------------------------------------------------------------------------
// Native-value recovery on chains where Alchemy has no `internal` category.
//
// Arbitrum (42161) and Optimism (10) do not return trace transfers from
// alchemy_getAssetTransfers, so a router paying the wallet in NATIVE ETH was
// invisible: only the token disposal landed, and a later ETH send computed a
// cost basis of 0. These cover the debug_traceTransaction recovery path.
// ---------------------------------------------------------------------------
describe("AlchemyAdapter native-value recovery (Arbitrum / Optimism)", () => {
  const ROUTER = "0x3333333333333333333333333333333333333333";
  const WETH_ARB = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
  const ACROSS_ARB = "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a"; // Across SpokePool, chain 42161

  const frame = (fields: Record<string, unknown>, ...calls: unknown[]) => ({
    type: "CALL",
    from: ROUTER,
    to: CP,
    value: "0x0",
    gas: "0x1",
    gasUsed: "0x1",
    input: "0x",
    ...fields,
    ...(calls.length > 0 ? { calls } : {}),
  });

  // The reported shape: wallet sends USDC to a router, the router unwraps WETH and pays ETH back.
  const swapTrace = (payout: string) =>
    frame({ from: WALLET, to: ROUTER }, frame({ from: ROUTER, to: WETH_ARB }, frame({ from: WETH_ARB, to: WALLET, value: payout })));

  it("gives only the chains that need it a native-recovery source list, trace before balance diff", () => {
    const byId = new Map(CHAIN_REGISTRY.map((entry) => [entry.chainId, entry]));
    // Order is the fallback order: the trace is an exact list of movements, the diff only their net.
    expect(byId.get(42161)?.nativeSources).toEqual(["alchemy-debug", "balance-diff"]);
    expect(byId.get(10)?.nativeSources).toEqual(["alchemy-debug", "balance-diff"]);
    for (const chainId of [1, 8453, 137]) expect(byId.get(chainId)?.nativeSources).toEqual([]);
    expect(byId.get(42161)?.supportedCategories).toEqual(["external", "erc20", "erc721", "erc1155"]);
    // getAssetTransfers categories stay independent of how native value is recovered.
    for (const chainId of [1, 8453, 137]) expect(byId.get(chainId)?.supportedCategories).toContain("internal");
  });

  it("turns a USDC -> ETH swap on Arbitrum into one EXCHANGE/RECEIVE pair with a shared group_id", async () => {
    const hash = "0x" + "c8".repeat(32);
    const { transactions } = await runTraced(
      { "arb-mainnet:out": [{ transfers: [erc20(hash, 4, WALLET, ROUTER, TOKEN_A, "USDC", "0x1312d00")] }] },
      { [hash]: { root: swapTrace("0x1683b9ce8000") } },
    );

    const arb = transactions.filter((t) => t.payload.chain_id === 42161);
    expect(arb).toHaveLength(2);
    const disposal = arb.find((t) => t.payload.classification === "EXCHANGE")!;
    const acquisition = arb.find((t) => t.payload.classification === "RECEIVE")!;

    expect(disposal.eventType).toBe("swap");
    expect(disposal.payload.asset_type).toBe("ERC20");
    expect(disposal.payload.raw_amount).toBe(String(BigInt("0x1312d00")));

    // The leg that used to go missing entirely: the ETH acquisition that anchors cost basis.
    expect(acquisition.eventType).toBe("transfer_in");
    expect(acquisition.payload.asset_type).toBe("NATIVE");
    expect(acquisition.payload.asset_contract).toBeNull();
    expect(acquisition.payload.symbol).toBe("ETH");
    expect(acquisition.payload.decimals).toBe(18);
    expect(acquisition.payload.raw_amount).toBe(String(BigInt("0x1683b9ce8000")));
    expect(acquisition.payload.counterparty).toBe(WETH_ARB);
    expect(acquisition.payload.income_kind).toBeNull();

    expect(disposal.payload.group_id).toBe(`42161:${hash}`);
    expect(acquisition.payload.group_id).toBe(disposal.payload.group_id);
    // Deterministic storage id: chain, tx, "internal", frame path.
    expect(acquisition.txHash).toBe(`42161:${hash}:internal:0_0`);
    expect(acquisition.payload.id).toBe(`42161:${hash}:internal:0_0`);
    expect(acquisition.payload.tx_hash).toBe(hash);
  });

  it("requests callTracer exactly once per candidate transaction, on that chain's host only", async () => {
    const hash = "0x" + "c9".repeat(32);
    const calls: CallRecord[] = [];
    await runTraced(
      { "arb-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, ROUTER, TOKEN_A, "USDC")] }] },
      { [hash]: { root: swapTrace("0x2386f26fc10000") } },
      calls,
    );
    const traceCalls = calls.filter((c) => c.direction === "trace");
    expect(traceCalls).toHaveLength(1);
    expect(traceCalls[0].network).toBe("arb-mainnet");
    expect(traceCalls[0].params.hash).toBe(hash);
    expect(traceCalls[0].params.options).toEqual({ tracer: "callTracer", tracerConfig: { onlyTopCall: false } });
  });

  it("never traces a chain that already returns the `internal` category", async () => {
    const hash = "0x" + "ca".repeat(32);
    const calls: CallRecord[] = [];
    await runTraced({ "eth-mainnet:out": [{ transfers: [erc20(hash, 1, WALLET, ROUTER, TOKEN_A, "USDC")] }] }, {}, calls);
    expect(calls.filter((c) => c.direction === "trace")).toHaveLength(0);
  });

  it("never traces a plain inbound native transfer (its only frame is already collected)", async () => {
    const calls: CallRecord[] = [];
    await runTraced({ "arb-mainnet:in": [{ transfers: [nativeIn("0x" + "cb".repeat(32))] }] }, {}, calls);
    expect(calls.filter((c) => c.direction === "trace")).toHaveLength(0);
  });

  it("traces a wallet-initiated native transaction, recovering an ETH refund", async () => {
    // ETH -> token swap that partially refunds: the external OUT is the disposal, the refund is a
    // second native leg that would otherwise be lost.
    const hash = "0x" + "cc".repeat(32);
    const outbound = { ...nativeIn(hash), from: WALLET, to: ROUTER };
    const { transactions } = await runTraced(
      { "arb-mainnet:out": [{ transfers: [outbound] }] },
      { [hash]: { root: frame({ from: WALLET, to: ROUTER }, frame({ from: ROUTER, to: WALLET, value: "0x5af3107a4000" })) } },
    );
    const refund = transactions.find((t) => t.txHash === `42161:${hash}:internal:0`);
    expect(refund?.payload.direction).toBe("IN");
    expect(refund?.payload.raw_amount).toBe(String(BigInt("0x5af3107a4000")));
  });

  it("flags a trace-recovered bridge payout as a review-gated IN leg", async () => {
    // A bridge fill that delivers native ETH alongside a token, discoverable through the token leg.
    const hash = "0x" + "cd".repeat(32);
    const { transactions } = await runTraced(
      { "arb-mainnet:in": [{ transfers: [erc20(hash, 7, ACROSS_ARB, WALLET, TOKEN_B, "BBB")] }] },
      { [hash]: { root: frame({ from: CP, to: ACROSS_ARB }, frame({ from: ACROSS_ARB, to: WALLET, value: "0x3856a5bd2800" })) } },
    );
    const native = transactions.find((t) => t.txHash === `42161:${hash}:internal:0`)!;
    expect(native.payload.classification).toBe("RECEIVE");
    expect(native.payload.counterparty).toBe(ACROSS_ARB);
    expect(native.payload.bridge_suspected).toBe(true);
    expect(native.payload.confidence as number).toBeLessThan(0.5);
  });

  it("keeps several native legs of one transaction distinct under the (txHash, eventType) key", async () => {
    const hash = "0x" + "ce".repeat(32);
    const { transactions } = await runTraced(
      { "arb-mainnet:in": [{ transfers: [erc20(hash, 2, CP, WALLET, TOKEN_B, "BBB")] }] },
      {
        [hash]: {
          root: frame(
            { from: CP, to: ROUTER },
            frame({ from: ROUTER, to: WALLET, value: "0x64" }),
            frame({ from: ROUTER, to: WALLET, value: "0xc8" }),
          ),
        },
      },
    );
    const arb = transactions.filter((t) => t.payload.chain_id === 42161);
    const natives = arb.filter((t) => t.payload.asset_type === "NATIVE");
    expect(natives.map((t) => t.txHash)).toEqual([`42161:${hash}:internal:0`, `42161:${hash}:internal:1`]);
    expect(natives.map((t) => t.payload.raw_amount)).toEqual(["100", "200"]);
    // The frozen upsert key is (bindingId, txHash, eventType): no two rows of this tx may collide.
    expect(new Set(arb.map((t) => `${t.txHash}|${t.eventType}`)).size).toBe(arb.length);
  });

  it("reproduces identical ids on a re-sync, so recovery is idempotent", async () => {
    const hash = "0x" + "cf".repeat(32);
    const map = { "arb-mainnet:out": [{ transfers: [erc20(hash, 4, WALLET, ROUTER, TOKEN_A, "USDC", "0x1312d00")] }] };
    const traces = { [hash]: { root: swapTrace("0x1683b9ce8000") } };
    const first = await runTraced(map, traces);
    const second = await runTraced(map, traces);
    const key = (r: Awaited<ReturnType<typeof runTraced>>) =>
      r.transactions.map((t) => `${t.txHash}|${t.eventType}|${t.payload.raw_amount}|${t.payload.group_id}`);
    expect(key(second)).toEqual(key(first));
  });

  it("withholds the WHOLE chain when a trace fails, keeping other chains complete", async () => {
    for (const failure of [{ rpcError: "trace unavailable" }, { httpStatus: 500 }] as const) {
      const hash = "0x" + "d0".repeat(32);
      const result = await runTraced(
        {
          "arb-mainnet:out": [{ transfers: [erc20(hash, 4, WALLET, ROUTER, TOKEN_A, "USDC")] }],
          "base-mainnet:in": [{ transfers: [nativeIn("0x" + "d2".repeat(32))] }],
        },
        { [hash]: failure },
      );
      // Cursor held: a half-observed chain must never persist the USDC leg as a bare SEND.
      expect(result.chainHeads[42161]).toBeUndefined();
      expect(result.transactions.some((t) => t.payload.chain_id === 42161)).toBe(false);
      expect(result.chainHeads[8453]).toBeDefined();
      expect(result.transactions.some((t) => t.payload.chain_id === 8453)).toBe(true);
    }
  });

  it("recovers native legs on Optimism through the same path", async () => {
    const hash = "0x" + "d3".repeat(32);
    const { transactions } = await runTraced(
      { "opt-mainnet:out": [{ transfers: [erc20(hash, 4, WALLET, ROUTER, TOKEN_A, "USDC", "0x1312d00")] }] },
      { [hash]: { root: swapTrace("0x1683b9ce8000") } },
    );
    const opt = transactions.filter((t) => t.payload.chain_id === 10);
    expect(opt).toHaveLength(2);
    expect(opt.find((t) => t.payload.asset_type === "NATIVE")?.txHash).toBe(`10:${hash}:internal:0_0`);
  });
});

describe("AlchemyAdapter same-asset residual netting (AC9)", () => {
  // The reported Aave withdraw (Ethereum, 2025-12-03, 0xbde5610f…): the wallet burns aEthWETH at the
  // WrappedTokenGateway and gets ETH back, and the pool mints the interest accrued in that same block
  // — a third leg in the SAME asset it just sent. Koinly reads the transaction as one trade.
  const GATEWAY = "0xd01607c3c5ecaba394d8be377a08590149325722";
  const MINT = "0x0000000000000000000000000000000000000000";
  const A_WETH = "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8";
  const BURNED = "0xb5e6219339ec"; // 200000010402284 aEthWETH base units
  const ACCRUED = "0x6de32f"; // 7201583 base units of interest minted in the same block

  const aaveWithdraw = (hash: string) =>
    ({
      "eth-mainnet:out": [{ transfers: [erc20(hash, 0, WALLET, GATEWAY, A_WETH, "aEthWETH", BURNED)] }],
      "eth-mainnet:in": [
        {
          transfers: [
            { ...nativeIn(hash, 1, BURNED), from: GATEWAY, category: "internal" },
            erc20(hash, 2, MINT, WALLET, A_WETH, "aEthWETH", ACCRUED),
          ],
        },
      ],
    }) as Record<string, Spec[]>;

  it("nets an Aave-style interest residual into the disposal and pairs the rest as one swap", async () => {
    const hash = "0x" + "a1".repeat(32);
    const out = await run(aaveWithdraw(hash));

    expect(out).toHaveLength(2);
    expect(out.some((t) => t.payload.classification === "UNKNOWN")).toBe(false);

    const disposal = out.find((t) => t.payload.direction === "OUT")!;
    const acquisition = out.find((t) => t.payload.direction === "IN")!;

    expect(disposal.eventType).toBe("swap");
    expect(disposal.payload.classification).toBe("EXCHANGE");
    expect(disposal.payload.symbol).toBe("aEthWETH");
    // 200000010402284 sent - 7201583 minted back = the amount actually disposed of. Exact base units.
    expect(disposal.payload.raw_amount).toBe("200000003200701");
    // The absorbed leg is named, not silently lost: provenance still points at the row it folded into.
    expect(disposal.payload.netted_leg_ids).toEqual([`1:${hash}:log:2`]);

    expect(acquisition.eventType).toBe("transfer_in");
    expect(acquisition.payload.classification).toBe("RECEIVE");
    expect(acquisition.payload.asset_type).toBe("NATIVE");
    expect(acquisition.payload.raw_amount).toBe("200000010402284");
    expect(acquisition.payload.income_kind).toBeNull();
    // The acquisition side absorbed nothing, so it carries no netting annotation.
    expect(acquisition.payload).not.toHaveProperty("netted_leg_ids");

    // Same pairing contract as any other swap: ONE shared opaque group_id, both sides above the floor.
    expect(disposal.payload.group_id).toBe(`1:${hash}`);
    expect(acquisition.payload.group_id).toBe(disposal.payload.group_id);
    expect(out.every((t) => t.payload.confidence === 0.6)).toBe(true);
  });

  it("nets the mirror shape: a fee taken back in the asset the wallet just received", async () => {
    // One asset in (TOKEN_B), two out: the real disposal (TOKEN_A) plus a fee charged in TOKEN_B.
    const hash = "0x" + "a2".repeat(32);
    const out = await run({
      "eth-mainnet:in": [{ transfers: [erc20(hash, 0, CP, WALLET, TOKEN_B, "BBB", "0xde0b6b3a7640000")] }],
      "eth-mainnet:out": [
        {
          transfers: [
            erc20(hash, 1, WALLET, CP, TOKEN_A, "AAA", "0x2faf080"),
            erc20(hash, 2, WALLET, CP, TOKEN_B, "BBB", "0xaa87bee538000"),
          ],
        },
      ],
    });

    expect(out).toHaveLength(2);
    const disposal = out.find((t) => t.payload.direction === "OUT")!;
    const acquisition = out.find((t) => t.payload.direction === "IN")!;

    expect(disposal.payload.classification).toBe("EXCHANGE");
    expect(disposal.payload.asset_contract).toBe(TOKEN_A);
    expect(disposal.payload.raw_amount).toBe("50000000");
    expect(disposal.payload).not.toHaveProperty("netted_leg_ids");

    expect(acquisition.payload.classification).toBe("RECEIVE");
    // 1e18 received - 3e15 fee = what the wallet kept.
    expect(acquisition.payload.raw_amount).toBe("997000000000000000");
    expect(acquisition.payload.netted_leg_ids).toEqual([`1:${hash}:log:2`]);
    expect(acquisition.payload.group_id).toBe(`1:${hash}`);
    expect(disposal.payload.group_id).toBe(acquisition.payload.group_id);
  });

  it("leaves a 2-IN / 1-OUT mix ambiguous when neither inbound asset is the one that left", async () => {
    const hash = "0x" + "a3".repeat(32);
    const nativeLeg = { ...nativeIn(hash, 2), category: "internal" };
    const out = await run({
      "eth-mainnet:out": [{ transfers: [erc20(hash, 0, WALLET, CP, TOKEN_A, "AAA")] }],
      "eth-mainnet:in": [{ transfers: [erc20(hash, 1, CP, WALLET, TOKEN_B, "BBB"), nativeLeg] }],
    });
    expect(out).toHaveLength(3);
    expect(out.every((t) => t.payload.classification === "UNKNOWN")).toBe(true);
    expect(out.every((t) => !("group_id" in t.payload))).toBe(true);
  });

  it("refuses to net when the residual is not smaller than the side it would reduce", async () => {
    // A refund equal to (or larger than) the disposal is not a residual — netting would invent a
    // zero/negative disposal, so the shape stays ambiguous instead of being guessed at.
    const hash = "0x" + "a4".repeat(32);
    const out = await run({
      "eth-mainnet:out": [{ transfers: [erc20(hash, 0, WALLET, CP, TOKEN_A, "AAA", "0x2faf080")] }],
      "eth-mainnet:in": [
        {
          transfers: [
            erc20(hash, 1, CP, WALLET, TOKEN_B, "BBB"),
            erc20(hash, 2, CP, WALLET, TOKEN_A, "AAA", "0x2faf080"),
          ],
        },
      ],
    });
    expect(out).toHaveLength(3);
    expect(out.every((t) => t.payload.classification === "UNKNOWN")).toBe(true);
  });

  it("leaves the Aave deposit direction (ETH -> aEthWETH) as the plain swap it already was", async () => {
    const hash = "0x" + "a5".repeat(32);
    const out = await run({
      "eth-mainnet:out": [{ transfers: [{ ...nativeIn(hash, 0, BURNED), from: WALLET, to: GATEWAY }] }],
      "eth-mainnet:in": [{ transfers: [erc20(hash, 1, MINT, WALLET, A_WETH, "aEthWETH", BURNED)] }],
    });
    expect(out).toHaveLength(2);
    expect(out.find((t) => t.payload.direction === "OUT")!.payload.classification).toBe("EXCHANGE");
    expect(out.find((t) => t.payload.direction === "IN")!.payload.classification).toBe("RECEIVE");
    expect(out.every((t) => !("netted_leg_ids" in t.payload))).toBe(true);
  });
});

describe("AlchemyAdapter forged outbound spam", () => {
  // A scam ERC20 emits a Transfer whose `from` is the victim. Nothing left the wallet, but the row
  // reads as a taxable SEND — and, worse, a forged leg sitting in a real transaction used to drag the
  // genuine legs into an ambiguous mix.
  const DENYLISTED = "0x09ff1d86683687f944dfda018c7870a869499481"; // "EꓔH", Ethereum
  const POLYGON_FAKE_USDT = "0x248e1aaffcf66930d22f6bcc3e3b560d64c92678"; // "UЅDТ0", Polygon

  it("tags a denylisted-contract OUT leg as SPAM instead of SEND", async () => {
    const hash = "0x" + "b1".repeat(32);
    const out = await run({
      "eth-mainnet:out": [{ transfers: [erc20(hash, 0, WALLET, CP, DENYLISTED, "EꓔH")] }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].payload.classification).toBe("SPAM");
    expect(out[0].payload.confidence).toBe(0);
    // Direction and event type stay truthful — only the classification says what this is.
    expect(out[0].payload.direction).toBe("OUT");
    expect(out[0].eventType).toBe("transfer_out");
  });

  it("tags an OUT leg with a weaponized symbol as SPAM (the Polygon fake USDT)", async () => {
    const hash = "0x" + "b2".repeat(32);
    const out = await run({
      "polygon-mainnet:out": [{ transfers: [erc20(hash, 0, WALLET, CP, POLYGON_FAKE_USDT, "UЅDТ0")] }],
    });
    expect(out.map((t) => t.payload.classification)).toEqual(["SPAM"]);
  });

  it("keeps a forged leg from poisoning the genuine swap in the same transaction", async () => {
    const hash = "0x" + "b3".repeat(32);
    const out = await run({
      "eth-mainnet:out": [
        {
          transfers: [
            erc20(hash, 0, WALLET, CP, TOKEN_A, "AAA"),
            erc20(hash, 1, WALLET, CP, DENYLISTED, "EꓔH"),
          ],
        },
      ],
      "eth-mainnet:in": [{ transfers: [erc20(hash, 2, CP, WALLET, TOKEN_B, "BBB")] }],
    });
    // Without the pre-filter this is outAssets={A, scam} -> 3 UNKNOWN rows. The forged leg is set
    // aside, so the genuine pair is still recognised, and the forged row is emitted rather than lost.
    expect(out).toHaveLength(3);
    expect(out.find((t) => t.payload.asset_contract === TOKEN_A)!.payload.classification).toBe("EXCHANGE");
    expect(out.find((t) => t.payload.asset_contract === TOKEN_B)!.payload.classification).toBe("RECEIVE");
    expect(out.find((t) => t.payload.asset_contract === DENYLISTED)!.payload.classification).toBe("SPAM");
    const pair = out.filter((t) => t.payload.classification !== "SPAM");
    expect(new Set(pair.map((t) => t.payload.group_id))).toEqual(new Set([`1:${hash}`]));
    expect(out.find((t) => t.payload.classification === "SPAM")!.payload).not.toHaveProperty("group_id");
  });

  it("never tags a NATIVE leg as spam, however strange its symbol looks", async () => {
    const outHash = "0x" + "b4".repeat(32);
    const inHash = "0x" + "b5".repeat(32);
    const out = await run({
      "eth-mainnet:out": [{ transfers: [{ ...nativeIn(outHash, 0), from: WALLET, to: CP, asset: "⭐ETH claim .live" }] }],
      "eth-mainnet:in": [{ transfers: [{ ...nativeIn(inHash, 0), asset: "⭐ETH claim .live" }] }],
    });
    expect(out.find((t) => t.payload.tx_hash === outHash)!.payload.classification).toBe("SEND");
    expect(out.find((t) => t.payload.tx_hash === inHash)!.payload.classification).toBe("RECEIVE");
  });
});

// ---------------------------------------------------------------------------
// Graceful degradation when the trace method is not available to our API key.
//
// Observed live on a Free-tier key: HTTP 400 + JSON-RPC code -32600 with
// "debug_traceTransaction is not available on the Free tier - upgrade to Pay As
// You Go, or Enterprise for access." Treating that as a chain failure withheld
// ALL of Arbitrum and Optimism, which is strictly worse than having no native
// legs — the token and external legs were fine.
// ---------------------------------------------------------------------------
describe("AlchemyAdapter native tracing degradation (capability vs transient)", () => {
  const ROUTER = "0x3333333333333333333333333333333333333333";
  const TIER_MESSAGE =
    "debug_traceTransaction is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access.";

  const swapOut = (hash: string, log: number) => erc20(hash, log, WALLET, ROUTER, TOKEN_A, "USDC", "0x1312d00");

  const warnings = () => {
    const spy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    return {
      degradations: () => spy.mock.calls.filter((call) => String(call[0]).includes("native tracing unavailable")),
      restore: () => spy.mockRestore(),
    };
  };

  it("keeps the chain complete and its token legs when tracing is tier-blocked", async () => {
    const hash = "0x" + "e1".repeat(32);
    const log = warnings();
    try {
      const result = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(hash, 4)] }] },
        { [hash]: { httpStatus: 400, error: { code: -32600, message: TIER_MESSAGE } } },
      );

      // The regression this guards: the chain must NOT be withheld.
      expect(result.chainHeads[42161]).toBeDefined();
      const arb = result.transactions.filter((t) => t.payload.chain_id === 42161);
      expect(arb).toHaveLength(1);
      expect(arb[0].payload.asset_type).toBe("ERC20");
      expect(arb[0].payload.classification).toBe("SEND");
      expect(arb.some((t) => t.payload.asset_type === "NATIVE")).toBe(false);

      const degradations = log.degradations();
      expect(degradations).toHaveLength(1);
      expect(String(degradations[0][0])).toContain("arb-mainnet");
      expect(String(degradations[0][0])).toContain(TIER_MESSAGE);
    } finally {
      log.restore();
    }
  });

  it("stops tracing the remaining candidates once the chain is known to be blocked", async () => {
    // Six candidates, TRACE_CONCURRENCY of 4: the first four start together and all learn the
    // method is gated, so the last two are skipped instead of spending a request each to relearn it.
    const hashes = ["f1", "f2", "f3", "f4", "f5", "f6"].map((byte) => "0x" + byte.repeat(32));
    const traces = Object.fromEntries(
      hashes.map((hash) => [hash, { httpStatus: 400, error: { code: -32600, message: TIER_MESSAGE } }]),
    );
    const calls: CallRecord[] = [];
    const log = warnings();
    try {
      const result = await runTraced(
        { "arb-mainnet:out": [{ transfers: hashes.map((hash, index) => swapOut(hash, index)) }] },
        traces as Record<string, TraceSpec>,
        calls,
      );
      expect(calls.filter((c) => c.direction === "trace")).toHaveLength(4);
      expect(log.degradations()).toHaveLength(1);
      // All six token legs still land; only the native recovery is missing.
      expect(result.transactions.filter((t) => t.payload.chain_id === 42161)).toHaveLength(6);
      expect(result.chainHeads[42161]).toBeDefined();
    } finally {
      log.restore();
    }
  });

  it("remembers the block for the process, so a later sync on the same adapter traces nothing", async () => {
    const hash = "0x" + "e4".repeat(32);
    const other = "0x" + "e5".repeat(32);
    const calls: CallRecord[] = [];
    const log = warnings();
    try {
      vi.stubGlobal(
        "fetch",
        makeFetch(
          { "arb-mainnet:out": [{ transfers: [swapOut(hash, 4)] }, { transfers: [swapOut(other, 6)] }] },
          calls,
          {
            [hash]: { httpStatus: 400, error: { code: -32600, message: TIER_MESSAGE } },
            [other]: { httpStatus: 400, error: { code: -32600, message: TIER_MESSAGE } },
          },
        ),
      );
      const adapter = new AlchemyAdapter(makeConfig({ ALCHEMY_API_KEY: "key", ALCHEMY_RETRY_BASE_MS: "1" }));
      await adapter.fetchTransactions(WALLET);
      const afterFirst = calls.filter((c) => c.direction === "trace").length;
      expect(afterFirst).toBe(1);

      const second = await adapter.fetchTransactions(WALLET);
      expect(calls.filter((c) => c.direction === "trace")).toHaveLength(afterFirst); // no re-probe
      expect(second.chainHeads[42161]).toBeDefined();
      expect(log.degradations()).toHaveLength(1); // warned exactly once for this chain
    } finally {
      log.restore();
    }
  });

  it("degrades the same way on a bare -32601 method-not-found", async () => {
    const hash = "0x" + "e6".repeat(32);
    const log = warnings();
    try {
      const result = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(hash, 4)] }] },
        { [hash]: { rpcError: "the method debug_traceTransaction does not exist/is not available", code: -32601 } },
      );
      expect(result.chainHeads[42161]).toBeDefined();
      expect(result.transactions.filter((t) => t.payload.chain_id === 42161)).toHaveLength(1);
      expect(log.degradations()).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  it("degrades on a tier message even when the provider sends no error code", async () => {
    const hash = "0x" + "e7".repeat(32);
    const log = warnings();
    try {
      const result = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(hash, 4)] }] },
        { [hash]: { rpcError: "trace is not available on the Growth tier" } },
      );
      expect(result.chainHeads[42161]).toBeDefined();
      expect(log.degradations()).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  it("still WITHHOLDS the chain on a transient trace failure", async () => {
    const transient: Record<string, TraceSpec> = {
      rpc: { rpcError: "execution timeout", code: -32000 },
      http500: { httpStatus: 500 },
      http503: { httpStatus: 503 },
    };
    for (const [name, failure] of Object.entries(transient)) {
      const hash = "0x" + "e8".repeat(32);
      const log = warnings();
      try {
        const result = await runTraced(
          {
            "arb-mainnet:out": [{ transfers: [swapOut(hash, 4)] }],
            "base-mainnet:in": [{ transfers: [nativeIn("0x" + "e9".repeat(32))] }],
          },
          { [hash]: failure },
        );
        expect(result.chainHeads[42161], name).toBeUndefined();
        expect(result.transactions.some((t) => t.payload.chain_id === 42161), name).toBe(false);
        expect(result.chainHeads[8453], name).toBeDefined();
        expect(log.degradations(), name).toHaveLength(0); // not a capability problem
      } finally {
        log.restore();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The free-tier fallback behind the trace path (native-balance-diff.ts).
//
// On the live key `debug_traceTransaction` is rejected with -32600 "not available on the Free tier",
// so the trace source recovers nothing and an Arbitrum USDC -> ETH swap still showed only the USDC
// disposal. `eth_getBalance` either side of the transaction's block IS served on that tier, and the
// wallet's balance change minus the parts already visible (its fee, the top-level value) is the
// internal movement. These cover that second source and the hand-off between the two.
// ---------------------------------------------------------------------------
describe("AlchemyAdapter native-value recovery by balance diff (free-tier fallback)", () => {
  const ROUTER = "0x3333333333333333333333333333333333333333";
  const TIER_MESSAGE =
    "debug_traceTransaction is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access.";
  const tierBlocked = (...hashes: string[]): Record<string, TraceSpec> =>
    Object.fromEntries(hashes.map((hash) => [hash, { httpStatus: 400, error: { code: -32600, message: TIER_MESSAGE } }]));

  const swapOut = (hash: string, log = 4) => erc20(hash, log, WALLET, ROUTER, TOKEN_A, "USDC", "0x1312d00");

  const logs = () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
    return {
      degradations: (kind: string) => warn.mock.calls.filter((call) => String(call[0]).includes(kind)),
      debugs: (fragment: string) => debug.mock.calls.filter((call) => String(call[0]).includes(fragment)),
      restore: () => {
        warn.mockRestore();
        debug.mockRestore();
      },
    };
  };

  // The reported regression, end to end: the trace is gated, the balance diff recovers the ETH the
  // router paid, and classifyGroup pairs it with the USDC disposal exactly as the trace path does.
  it("turns the tier-blocked Arbitrum swap into an EXCHANGE/RECEIVE pair sharing one group_id", async () => {
    const hash = "0x" + "b1".repeat(32);
    const log = logs();
    try {
      const { transactions, chainHeads } = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] },
        tierBlocked(hash),
        [],
        // Wallet sent the tx: balance rose 900 wei on top of the 6 wei of gas it paid.
        { [hash]: { block: 300_000, from: WALLET, to: ROUTER, value: "0x0", gasUsed: "0x2", effectiveGasPrice: "0x3", before: "0x64", after: "0x3e8" } },
      );

      expect(chainHeads[42161]).toBeDefined();
      const arb = transactions.filter((t) => t.payload.chain_id === 42161);
      expect(arb).toHaveLength(2);
      const disposal = arb.find((t) => t.payload.classification === "EXCHANGE")!;
      const acquisition = arb.find((t) => t.payload.classification === "RECEIVE")!;

      expect(disposal.payload.asset_type).toBe("ERC20");
      expect(disposal.payload.direction).toBe("OUT");
      expect(disposal.payload.raw_amount).toBe(String(BigInt("0x1312d00")));

      expect(acquisition.eventType).toBe("transfer_in");
      expect(acquisition.payload.asset_type).toBe("NATIVE");
      expect(acquisition.payload.asset_contract).toBeNull();
      expect(acquisition.payload.symbol).toBe("ETH");
      expect(acquisition.payload.decimals).toBe(18);
      expect(acquisition.payload.raw_amount).toBe("906"); // 1000 - 100 + gas 6
      expect(acquisition.payload.counterparty).toBe(ROUTER);
      expect(acquisition.payload.income_kind).toBeNull();

      // The id says which source produced the leg and stays distinct from a `:internal:` trace id.
      expect(acquisition.txHash).toBe(`42161:${hash}:balance:0`);
      expect(acquisition.payload.id).toBe(`42161:${hash}:balance:0`);
      expect(acquisition.payload.tx_hash).toBe(hash);
      // Inferred, not observed: the marker is what tells the two apart after the fact.
      expect(acquisition.payload.native_source).toBe("balance-diff");

      expect(disposal.payload.group_id).toBe(`42161:${hash}`);
      expect(acquisition.payload.group_id).toBe(disposal.payload.group_id);
    } finally {
      log.restore();
    }
  });

  it("never touches the balance RPCs while the trace source answers, and leaves traced legs unmarked", async () => {
    const hash = "0x" + "b2".repeat(32);
    const calls: CallRecord[] = [];
    const { transactions } = await runTraced(
      { "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] },
      {
        [hash]: {
          root: {
            type: "CALL",
            from: WALLET,
            to: ROUTER,
            value: "0x0",
            calls: [{ type: "CALL", from: ROUTER, to: WALLET, value: "0x1683b9ce8000" }],
          },
        },
      },
      calls,
      { [hash]: { block: 300_001, from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" } },
    );
    expect(calls.filter((c) => c.direction === "trace")).toHaveLength(1);
    expect(calls.filter((c) => ["receipt", "tx", "balance"].includes(c.direction))).toHaveLength(0);
    const native = transactions.find((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")!;
    expect(native.txHash).toBe(`42161:${hash}:internal:0`);
    expect(native.payload.native_source).toBeUndefined();
  });

  it("does not fall through when the trace source answers with NO movements", async () => {
    // An available trace saying "nothing internal happened" is the truth, not a reason to go and
    // re-derive a net from balances that would disagree with it.
    const hash = "0x" + "b3".repeat(32);
    const calls: CallRecord[] = [];
    const { transactions } = await runTraced(
      { "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] },
      {},
      calls,
      { [hash]: { block: 300_002, from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" } },
    );
    expect(calls.filter((c) => c.direction === "trace")).toHaveLength(1);
    expect(calls.filter((c) => c.direction === "receipt")).toHaveLength(0);
    expect(transactions.filter((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")).toHaveLength(0);
  });

  it("withholds the chain on a TRANSIENT trace failure instead of falling through to the weaker source", async () => {
    for (const failure of [{ httpStatus: 500 }, { rpcError: "execution timeout", code: -32000 }] as const) {
      const hash = "0x" + "b4".repeat(32);
      const calls: CallRecord[] = [];
      const result = await runTraced(
        {
          "arb-mainnet:out": [{ transfers: [swapOut(hash)] }],
          "base-mainnet:in": [{ transfers: [nativeIn("0x" + "b5".repeat(32))] }],
        },
        { [hash]: failure },
        calls,
        { [hash]: { block: 300_003, from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" } },
      );
      expect(result.chainHeads[42161]).toBeUndefined();
      expect(calls.filter((c) => c.direction === "receipt")).toHaveLength(0);
      expect(result.chainHeads[8453]).toBeDefined();
    }
  });

  it("spends exactly four RPCs per candidate, reading the balance at block-1 and at block", async () => {
    const hash = "0x" + "b6".repeat(32);
    const calls: CallRecord[] = [];
    const log = logs();
    try {
      await runTraced({ "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] }, tierBlocked(hash), calls, {
        [hash]: { block: 0x4d2, from: WALLET, to: ROUTER, gasUsed: "0x2", effectiveGasPrice: "0x3", before: "0x64", after: "0x3e8" },
      });
      const diffCalls = calls.filter((c) => ["receipt", "tx", "balance"].includes(c.direction));
      expect(diffCalls).toHaveLength(4);
      expect(diffCalls.filter((c) => c.direction === "balance").map((c) => c.params.tag)).toEqual(["0x4d1", "0x4d2"]);
      expect(diffCalls.every((c) => c.network === "arb-mainnet")).toBe(true);
    } finally {
      log.restore();
    }
  });

  it("emits no leg when the balance moved by exactly the amounts already visible", async () => {
    // An approve: the only balance change is the fee the wallet paid, which is not a transfer.
    const hash = "0x" + "b7".repeat(32);
    const log = logs();
    try {
      const { transactions } = await runTraced({ "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] }, tierBlocked(hash), [], {
        [hash]: { block: 300_004, from: WALLET, to: ROUTER, gasUsed: "0x3", effectiveGasPrice: "0x4", before: "0x64", after: "0x58" },
      });
      const arb = transactions.filter((t) => t.payload.chain_id === 42161);
      expect(arb).toHaveLength(1);
      expect(arb[0].payload.asset_type).toBe("ERC20");
      expect(arb[0].payload.classification).toBe("SEND");
    } finally {
      log.restore();
    }
  });

  it("emits an OUT leg when an internal call took native OUT of the wallet", async () => {
    const hash = "0x" + "b8".repeat(32);
    const log = logs();
    try {
      const { transactions } = await runTraced({ "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] }, tierBlocked(hash), [], {
        // Balance fell by the 6 wei fee plus 750 wei the contract pulled out.
        [hash]: { block: 300_005, from: WALLET, to: ROUTER, gasUsed: "0x2", effectiveGasPrice: "0x3", before: "0x3e8", after: "0xf4" },
      });
      const native = transactions.find((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")!;
      expect(native.payload.direction).toBe("OUT");
      expect(native.eventType).toBe("transfer_out");
      expect(native.payload.raw_amount).toBe("750");
      expect(native.payload.counterparty).toBe(ROUTER);
      expect(native.payload.classification).toBe("SEND");
    } finally {
      log.restore();
    }
  });

  it("skips a reverted transaction, whose state changes were all rolled back", async () => {
    const hash = "0x" + "b9".repeat(32);
    const calls: CallRecord[] = [];
    const log = logs();
    try {
      const { transactions } = await runTraced({ "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] }, tierBlocked(hash), calls, {
        [hash]: { block: 300_006, status: "0x0", from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" },
      });
      expect(transactions.filter((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")).toHaveLength(0);
      // Disqualified on the receipt alone: no transaction or balance reads are spent on it.
      expect(calls.filter((c) => c.direction === "receipt")).toHaveLength(1);
      expect(calls.filter((c) => ["tx", "balance"].includes(c.direction))).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  it("skips a block holding two candidate transactions, because the diff cannot say which moved what", async () => {
    const first = "0x" + "ba".repeat(32);
    const second = "0x" + "bb".repeat(32);
    const calls: CallRecord[] = [];
    const log = logs();
    try {
      const { transactions, chainHeads } = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(first, 1), swapOut(second, 2)] }] },
        tierBlocked(first, second),
        calls,
        {
          [first]: { block: 300_007, from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" },
          [second]: { block: 300_007, from: WALLET, to: ROUTER, before: "0x64", after: "0x3e8" },
        },
      );
      expect(transactions.filter((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")).toHaveLength(0);
      // Both token legs still land; only the inference is withheld, and it is said once.
      expect(transactions.filter((t) => t.payload.chain_id === 42161)).toHaveLength(2);
      expect(chainHeads[42161]).toBeDefined();
      expect(calls.filter((c) => ["tx", "balance"].includes(c.direction))).toHaveLength(0);
      expect(log.debugs("attribution ambiguous")).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  it("reproduces identical ids on a re-sync, so the balance-diff path is idempotent", async () => {
    const hash = "0x" + "bc".repeat(32);
    const map = { "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] };
    const states = {
      [hash]: { block: 300_008, from: WALLET, to: ROUTER, gasUsed: "0x2", effectiveGasPrice: "0x3", before: "0x64", after: "0x3e8" },
    };
    const log = logs();
    try {
      const key = (result: Awaited<ReturnType<typeof runTraced>>) =>
        result.transactions.map((t) => `${t.txHash}|${t.eventType}|${t.payload.raw_amount}|${t.payload.group_id}`);
      const first = await runTraced(map, tierBlocked(hash), [], states);
      const second = await runTraced(map, tierBlocked(hash), [], states);
      expect(key(second)).toEqual(key(first));
      expect(key(first).some((entry) => entry.includes(`42161:${hash}:balance:0`))).toBe(true);
    } finally {
      log.restore();
    }
  });

  it("withholds the WHOLE chain when a balance-diff read fails transiently", async () => {
    const hash = "0x" + "bd".repeat(32);
    const log = logs();
    try {
      const result = await runTraced(
        {
          "arb-mainnet:out": [{ transfers: [swapOut(hash)] }],
          "base-mainnet:in": [{ transfers: [nativeIn("0x" + "be".repeat(32))] }],
        },
        tierBlocked(hash),
        [],
        { [hash]: { block: 300_009, from: WALLET, to: ROUTER, receiptFailure: { message: "execution timeout", code: -32000 } } },
      );
      expect(result.chainHeads[42161]).toBeUndefined();
      expect(result.transactions.some((t) => t.payload.chain_id === 42161)).toBe(false);
      expect(result.chainHeads[8453]).toBeDefined();
      expect(log.degradations("native balance-diff unavailable")).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  it("keeps the chain when the balance reads themselves are gated, warning once", async () => {
    // Both sources gone: the token legs are still complete and correct on their own, and withholding
    // the chain over a permanent capability gap would be strictly worse.
    const hash = "0x" + "bf".repeat(32);
    const log = logs();
    try {
      const result = await runTraced({ "arb-mainnet:out": [{ transfers: [swapOut(hash)] }] }, tierBlocked(hash), [], {
        [hash]: {
          block: 300_010,
          from: WALLET,
          to: ROUTER,
          balanceFailure: { httpStatus: 400, code: -32600, message: "archive state is not available on the Free tier" },
        },
      });
      expect(result.chainHeads[42161]).toBeDefined();
      const arb = result.transactions.filter((t) => t.payload.chain_id === 42161);
      expect(arb).toHaveLength(1);
      expect(arb[0].payload.asset_type).toBe("ERC20");
      expect(log.degradations("native balance-diff unavailable")).toHaveLength(1);
    } finally {
      log.restore();
    }
  });

  it("skips only the candidate whose block is beyond the archive depth (HTTP 503, -32001) and keeps the chain and the other legs", async () => {
    // Alchemy's Arbitrum endpoint refuses `eth_getBalance` at blocks older than the key's archive depth with a
    // deterministic 503/-32001 while recent blocks answer fine. Withholding the chain re-walked it from genesis on
    // every sync only to hit the same wall; gating the whole source would drop the recent legs too.
    const old = "0x" + "c1".repeat(32);
    const recent = "0x" + "c2".repeat(32);
    const log = logs();
    try {
      const { transactions, chainHeads } = await runTraced(
        { "arb-mainnet:out": [{ transfers: [swapOut(old, 4), swapOut(recent, 5)] }] },
        tierBlocked(old, recent),
        [],
        {
          [old]: { block: 100_000, from: WALLET, to: ROUTER, value: "0x0", gasUsed: "0x2", effectiveGasPrice: "0x3", balanceFailure: { httpStatus: 503, code: -32001, message: "Unable to complete request at this time." } },
          [recent]: { block: 300_000, from: WALLET, to: ROUTER, value: "0x0", gasUsed: "0x2", effectiveGasPrice: "0x3", before: "0x64", after: "0x3e8" },
        },
      );
      expect(chainHeads[42161]).toBeDefined(); // the chain is complete, not withheld
      const arb = transactions.filter((t) => t.payload.chain_id === 42161);
      expect(arb.filter((t) => t.payload.asset_type === "ERC20")).toHaveLength(2); // both USDC disposals kept
      expect(arb.filter((t) => t.payload.asset_type === "NATIVE").map((t) => t.payload.tx_hash)).toEqual([recent]); // only the recent leg is recovered
      // The source itself is alive: it is not mistaken for a plan gate and switched off for hours.
      expect(log.degradations("native balance-diff unavailable")).toHaveLength(0);
    } finally {
      log.restore();
    }
  });

  it("counts the OP-stack L1 fee the sender also paid, so Optimism does not under-report", async () => {
    // On Arbitrum Nitro the L1 cost is folded into gasUsed, but an OP-stack receipt bills it
    // separately; missing it would shrink every recovered payout by that amount.
    const hash = "0x" + "c1".repeat(32);
    const log = logs();
    try {
      const { transactions } = await runTraced(
        { "opt-mainnet:out": [{ transfers: [swapOut(hash)] }] },
        tierBlocked(hash),
        [],
        {
          [hash]: { block: 300_011, from: WALLET, to: ROUTER, gasUsed: "0x2", effectiveGasPrice: "0x3", l1Fee: "0x14", before: "0x64", after: "0x3e8" },
        },
      );
      const native = transactions.find((t) => t.payload.chain_id === 10 && t.payload.asset_type === "NATIVE")!;
      expect(native.txHash).toBe(`10:${hash}:balance:0`);
      expect(native.payload.raw_amount).toBe("926"); // 900 + gas 6 + l1Fee 20
    } finally {
      log.restore();
    }
  });

  it("subtracts a top-level value the wallet RECEIVED, leaving only the internal part", async () => {
    // Someone sent the wallet ETH top-level (already an `external` leg) and a contract paid it more.
    const hash = "0x" + "c2".repeat(32);
    const log = logs();
    try {
      const { transactions } = await runTraced(
        { "arb-mainnet:in": [{ transfers: [erc20(hash, 3, CP, WALLET, TOKEN_B, "BBB")] }] },
        tierBlocked(hash),
        [],
        { [hash]: { block: 300_012, from: CP, to: WALLET, value: "0x1f4", before: "0x3e8", after: "0x6a4" } },
      );
      const native = transactions.find((t) => t.payload.chain_id === 42161 && t.payload.asset_type === "NATIVE")!;
      expect(native.payload.direction).toBe("IN");
      // 1700 - 1000 = 700 moved, of which 500 is the top-level value already collected elsewhere.
      expect(native.payload.raw_amount).toBe("200");
      // `to` is the wallet itself, so there is no counterparty address to name.
      expect(native.payload.counterparty).toBe("0x0000000000000000000000000000000000000000");
    } finally {
      log.restore();
    }
  });
});
