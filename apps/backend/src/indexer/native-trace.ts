/**
 * Native-value recovery from a `debug_traceTransaction` callTracer frame tree.
 *
 * WHY THIS EXISTS
 * Alchemy's Transfers API only returns the `internal` (trace) category on Ethereum, Polygon and
 * Base — "internal transfer data is only available on Ethereum Mainnet, Polygon Mainnet, and Base
 * Mainnet" (https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers).
 * On Arbitrum (42161) and Optimism (10) that means a router paying the wallet in NATIVE ETH is
 * invisible: a USDC -> ETH swap collects only the USDC disposal, the ETH acquisition never lands,
 * and a later ETH send computes a cost basis of 0.
 *
 * The recovery path is the Alchemy Debug API's `debug_traceTransaction` with `{"tracer":"callTracer"}`,
 * documented as supported on both networks:
 *   - Arbitrum "Related APIs ... also supported on Arbitrum: Debug API"
 *     https://www.alchemy.com/docs/arbitrum/arbitrum-api-overview
 *   - OP Mainnet "Related APIs ... also supported on OP Mainnet: Debug API"
 *     https://www.alchemy.com/docs/op-mainnet/op-mainnet-api-overview
 *   - method + tracerConfig shape: https://www.alchemy.com/docs/node/debug-api/debug-api-endpoints/debug-trace-transaction
 * (The Parity-style Trace API is NOT an option here: `arbtrace_filter` is documented as pre-Nitro
 * only — "works for pre-Nitro blocks (before block 22,207,815). For post-Nitro blocks, use Geth
 * debug_* methods" — and the Trace API's `trace` type is listed as Ethereum Mainnet & Sepolia only.)
 *
 * This module is deliberately pure: the RPC lives in the adapter, the value semantics live here.
 */

/** One callTracer frame. Unknown/extra fields are ignored; every field is validated on read. */
export interface CallFrame {
  type?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
  error?: unknown;
  revertReason?: unknown;
  calls?: unknown;
}

/** A native-value movement in which the wallet is a party, recovered from one trace. */
export interface NativeTraceTransfer {
  /** Deterministic frame path from the root, e.g. "0_2_1". Stable across re-syncs. */
  path: string;
  from: string;
  to: string;
  /** Base-unit (wei) value as a 0x-hex quantity, normalized from the tracer's own quantity. */
  hexValue: string;
}

// Frame types that actually MOVE value. DELEGATECALL and STATICCALL are excluded on purpose:
// a delegatecall frame inherits its parent's `value` but transfers nothing, so counting it would
// double the amount. Alchemy applies the same rule to its own `internal` category ("we do not
// include any internal transfers with call type `delegatecall` because although they have a value
// associated with them they do not actually transfer that value").
const VALUE_MOVING_TYPES = new Set(["CALL", "CALLCODE", "CREATE", "CREATE2", "SELFDESTRUCT"]);

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Parse a 0x-hex quantity. Returns null for anything that is not strict 0x-hex. */
function parseHexQuantity(value: unknown): bigint | null {
  const raw = asString(value);
  if (raw === null || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/**
 * True when a JSON-RPC error from `debug_traceTransaction` means the METHOD ITSELF is unavailable
 * to us, rather than this particular trace having failed.
 *
 * The distinction is load-bearing. A transient failure must hold the chain's cursor so the sync is
 * retried; a capability failure must NOT, because it will never succeed and holding the cursor
 * would withhold the whole chain's ordinary token and external legs on every sync — strictly worse
 * than having no trace data at all. Observed live: HTTP 400 with code -32600 and "debug_traceTransaction
 * is not available on the Free tier - upgrade to Pay As You Go, or Enterprise for access."
 *
 * Both signals are checked because providers are inconsistent: some return -32601 (method not found)
 * for a gated method, some return -32600 (invalid request) with the reason only in the message.
 */
export function isTraceCapabilityError(code: unknown, message: unknown): boolean {
  if (code === -32600 || code === -32601) return true;
  const text = asString(message);
  if (text === null) return false;
  return /not available on the .* tier|method not (found|supported)/i.test(text);
}

/** True when `value` looks like a callTracer frame (it carries a string `type`). */
export function isCallFrame(value: unknown): value is CallFrame {
  return typeof value === "object" && value !== null && typeof (value as CallFrame).type === "string";
}

/**
 * Walk a callTracer tree and return every native-value movement in which `wallet` is the sender or
 * the recipient.
 *
 * Rules, in order:
 *  - The ROOT frame is never emitted. It is the top-level external transaction, which
 *    `alchemy_getAssetTransfers` already returns under the `external` category; emitting it here
 *    would duplicate that leg.
 *  - A frame carrying `error` reverted: it and its ENTIRE subtree are skipped, because the EVM
 *    rolls back every state change made inside a reverted frame.
 *  - Only value-moving frame types are emitted (see VALUE_MOVING_TYPES). DELEGATECALL/STATICCALL
 *    frames are not emitted but ARE descended into — a real CALL can sit underneath one.
 *  - Zero-value frames are dropped (no economic effect, and they are the bulk of a trace).
 *  - `path` is the child-index path from the root ("0_2_1"), a pure function of the tree shape, so
 *    a re-sync of the same transaction reproduces byte-identical ids.
 *
 * A frame with an unreadable `value`, `from` or `to` is skipped rather than guessed at; the caller
 * decides what a wholly unparseable trace means (the adapter treats it as chain-incomplete).
 */
export function extractNativeTransfers(root: unknown, wallet: string): NativeTraceTransfer[] {
  if (!isCallFrame(root)) return [];
  const target = wallet.toLowerCase();
  const found: NativeTraceTransfer[] = [];

  const visit = (frame: CallFrame, path: readonly number[]): void => {
    // Reverted frame: nothing inside it happened.
    if (frame.error !== undefined && frame.error !== null && frame.error !== "") return;

    if (path.length > 0) {
      const type = (asString(frame.type) ?? "").toUpperCase();
      const value = parseHexQuantity(frame.value);
      const from = asString(frame.from)?.toLowerCase() ?? null;
      const to = asString(frame.to)?.toLowerCase() ?? null;
      if (
        VALUE_MOVING_TYPES.has(type) &&
        value !== null &&
        value > 0n &&
        from !== null &&
        to !== null &&
        (from === target || to === target)
      ) {
        found.push({ path: path.join("_"), from, to, hexValue: `0x${value.toString(16)}` });
      }
    }

    const children = Array.isArray(frame.calls) ? frame.calls : [];
    children.forEach((child, index) => {
      if (isCallFrame(child)) visit(child, [...path, index]);
    });
  };

  visit(root, []);
  return found;
}

/**
 * Unwrap a `debug_traceTransaction` JSON-RPC `result` into the callTracer ROOT frame.
 *
 * The node returns the root frame object directly. Alchemy's reference page additionally documents
 * a wrapped rendering (`[{ "name": "transaction trace", "value": { ...frame } }]`), so both shapes
 * are accepted. Anything else returns null and the caller treats the trace as unusable.
 */
export function unwrapTraceResult(result: unknown): CallFrame | null {
  if (isCallFrame(result)) return result;
  if (Array.isArray(result)) {
    for (const item of result) {
      if (isCallFrame(item)) return item;
      const wrapped = (item as { value?: unknown } | null)?.value;
      if (isCallFrame(wrapped)) return wrapped;
    }
  }
  return null;
}
