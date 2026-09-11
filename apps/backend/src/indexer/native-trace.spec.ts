import { describe, expect, it } from "vitest";
import { extractNativeTransfers, isTraceCapabilityError, unwrapTraceResult } from "./native-trace";

const WALLET = "0xf8d09e078d3552ba1a5ae9876d3b24aa10b1efad";
const ROUTER = "0x1111111111111111111111111111111111111111";
const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
const OTHER = "0x2222222222222222222222222222222222222222";

// Deliberately zero-padded, as Alchemy's own fixtures are: the extractor canonicalizes the
// quantity, so expectations use the unpadded form.
const ONE_ETH = "0x0de0b6b3a7640000";
const ONE_ETH_CANONICAL = "0xde0b6b3a7640000";

// A minimal callTracer frame. `calls` are the sub-frames, in execution order.
const frame = (fields: Record<string, unknown>, ...calls: unknown[]) => ({
  type: "CALL",
  from: ROUTER,
  to: OTHER,
  value: "0x0",
  gas: "0x1",
  gasUsed: "0x1",
  input: "0x",
  ...fields,
  ...(calls.length > 0 ? { calls } : {}),
});

describe("extractNativeTransfers", () => {
  it("recovers a nested native payout to the wallet (the missing swap leg)", () => {
    // wallet -> router (0 value, the top-level swap call); router -> WETH (unwrap); WETH -> wallet (ETH out).
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame({ from: ROUTER, to: WETH }, frame({ from: WETH, to: WALLET, value: "0x1683b9ce8000" })),
    );
    expect(extractNativeTransfers(root, WALLET)).toEqual([
      { path: "0_0", from: WETH, to: WALLET, hexValue: "0x1683b9ce8000" },
    ]);
  });

  it("recovers value sent FROM the wallet by a sub-frame", () => {
    const root = frame({ from: WALLET, to: ROUTER }, frame({ from: WALLET, to: OTHER, value: ONE_ETH }));
    expect(extractNativeTransfers(root, WALLET)).toEqual([
      { path: "0", from: WALLET, to: OTHER, hexValue: ONE_ETH_CANONICAL },
    ]);
  });

  it("never emits the root frame (the external transfer is already collected)", () => {
    const root = frame({ from: WALLET, to: ROUTER, value: ONE_ETH });
    expect(extractNativeTransfers(root, WALLET)).toEqual([]);
  });

  it("drops zero-value frames", () => {
    const root = frame({ from: WALLET, to: ROUTER }, frame({ from: ROUTER, to: WALLET, value: "0x0" }));
    expect(extractNativeTransfers(root, WALLET)).toEqual([]);
  });

  it("skips a reverted frame AND its entire subtree", () => {
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame(
        { from: ROUTER, to: OTHER, value: ONE_ETH, error: "execution reverted" },
        frame({ from: OTHER, to: WALLET, value: ONE_ETH }),
      ),
      frame({ from: ROUTER, to: WALLET, value: "0x2386f26fc10000" }),
    );
    expect(extractNativeTransfers(root, WALLET)).toEqual([
      { path: "1", from: ROUTER, to: WALLET, hexValue: "0x2386f26fc10000" },
    ]);
  });

  it("ignores a DELEGATECALL's inherited value but still descends into it", () => {
    // A delegatecall carries the parent's value without moving it; counting it would double the amount.
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame(
        { type: "DELEGATECALL", from: ROUTER, to: OTHER, value: ONE_ETH },
        frame({ from: ROUTER, to: WALLET, value: "0x5af3107a4000" }),
      ),
    );
    expect(extractNativeTransfers(root, WALLET)).toEqual([
      { path: "0_0", from: ROUTER, to: WALLET, hexValue: "0x5af3107a4000" },
    ]);
  });

  it("ignores a STATICCALL frame", () => {
    const root = frame({ from: WALLET, to: ROUTER }, frame({ type: "STATICCALL", from: ROUTER, to: WALLET, value: ONE_ETH }));
    expect(extractNativeTransfers(root, WALLET)).toEqual([]);
  });

  it("emits CREATE and SELFDESTRUCT endowments involving the wallet", () => {
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame({ type: "CREATE", from: WALLET, to: OTHER, value: ONE_ETH }),
      frame({ type: "SELFDESTRUCT", from: OTHER, to: WALLET, value: "0x1" }),
    );
    expect(extractNativeTransfers(root, WALLET).map((t) => t.path)).toEqual(["0", "1"]);
  });

  it("skips frames in which the wallet is neither side", () => {
    const root = frame({ from: WALLET, to: ROUTER }, frame({ from: ROUTER, to: OTHER, value: ONE_ETH }));
    expect(extractNativeTransfers(root, WALLET)).toEqual([]);
  });

  it("matches the wallet case-insensitively and lowercases both sides", () => {
    const root = frame({ from: WALLET, to: ROUTER }, frame({ from: ROUTER.toUpperCase(), to: WALLET.toUpperCase(), value: ONE_ETH }));
    expect(extractNativeTransfers(root, WALLET.toUpperCase())).toEqual([
      { path: "0", from: ROUTER, to: WALLET, hexValue: ONE_ETH_CANONICAL },
    ]);
  });

  it("gives every frame a deterministic path, stable across repeated extraction", () => {
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame({ from: ROUTER, to: OTHER }),
      frame({ from: ROUTER, to: OTHER }, frame({ from: ROUTER, to: OTHER }), frame({ from: OTHER, to: WALLET, value: "0x64" })),
    );
    const first = extractNativeTransfers(root, WALLET);
    expect(first).toEqual([{ path: "1_1", from: OTHER, to: WALLET, hexValue: "0x64" }]);
    expect(extractNativeTransfers(root, WALLET)).toEqual(first);
  });

  it("skips frames with an unparseable value instead of guessing", () => {
    const root = frame(
      { from: WALLET, to: ROUTER },
      frame({ from: ROUTER, to: WALLET, value: "1000000000000000000" }),
      frame({ from: ROUTER, to: WALLET, value: null }),
      frame({ from: ROUTER, to: WALLET, value: "0x2c68af0bb140000" }),
    );
    expect(extractNativeTransfers(root, WALLET)).toEqual([
      { path: "2", from: ROUTER, to: WALLET, hexValue: "0x2c68af0bb140000" },
    ]);
  });

  it("returns nothing for a non-frame result", () => {
    expect(extractNativeTransfers(null, WALLET)).toEqual([]);
    expect(extractNativeTransfers({ calls: [] }, WALLET)).toEqual([]);
  });
});

describe("unwrapTraceResult", () => {
  it("accepts the bare root frame a node returns", () => {
    const root = frame({ from: WALLET, to: ROUTER });
    expect(unwrapTraceResult(root)).toBe(root);
  });

  it("accepts the wrapped [{ name, value }] shape from the Alchemy reference page", () => {
    const root = frame({ from: WALLET, to: ROUTER });
    expect(unwrapTraceResult([{ name: "transaction trace", value: root }])).toBe(root);
  });

  it("rejects anything else", () => {
    expect(unwrapTraceResult(undefined)).toBeNull();
    expect(unwrapTraceResult("0x")).toBeNull();
    expect(unwrapTraceResult({ structLogs: [] })).toBeNull();
    expect(unwrapTraceResult([{ name: "x" }])).toBeNull();
  });
});

describe("isTraceCapabilityError", () => {
  // The live Free-tier rejection, verbatim.
  const TIER_MESSAGE =
    "debug_traceTransaction is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access.";

  it("recognizes the gated-method codes", () => {
    expect(isTraceCapabilityError(-32600, "invalid request")).toBe(true);
    expect(isTraceCapabilityError(-32601, "method not found")).toBe(true);
  });

  it("recognizes a tier rejection carried only in the message", () => {
    expect(isTraceCapabilityError(undefined, TIER_MESSAGE)).toBe(true);
    expect(isTraceCapabilityError(null, "trace is not available on the Growth tier")).toBe(true);
    expect(isTraceCapabilityError(-32000, "Method not supported")).toBe(true);
  });

  it("leaves transient failures alone so they still withhold the chain", () => {
    expect(isTraceCapabilityError(-32000, "execution timeout")).toBe(false);
    expect(isTraceCapabilityError(-32603, "internal error")).toBe(false);
    expect(isTraceCapabilityError(undefined, undefined)).toBe(false);
    expect(isTraceCapabilityError(429, { nested: "object" })).toBe(false);
  });
});
