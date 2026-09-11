export type AssetTransferCategory = "external" | "internal" | "erc20" | "erc721" | "erc1155";

/**
 * Where a chain's native-value movements come from when `supportedCategories` lacks `internal`.
 *
 *  - `"alchemy-debug"` replays the transaction through the Alchemy Debug API
 *    (`debug_traceTransaction` + callTracer) and reads every internal transfer out of the frame
 *    tree — exact, per-movement, and gated behind a paid plan (see native-trace.ts).
 *  - `"balance-diff"` reads the wallet's native balance either side of the transaction's block and
 *    subtracts the parts already visible (the fee, the top-level value). It yields ONE net number
 *    per transaction instead of a list, but every RPC it needs is served on the free tier
 *    (see native-balance-diff.ts).
 *
 * Per-chain by design: a global flag could not express "Ethereum already has them, Arbitrum needs a
 * trace, some future chain has neither".
 */
export type NativeValueSource = "alchemy-debug" | "balance-diff";

export interface ChainRegistryEntry {
  chainId: number;
  network: string;
  nativeSymbol: string;
  nativeDecimals: number;
  /** Categories passed to `alchemy_getAssetTransfers`. Unrelated to `nativeSources`. */
  supportedCategories: readonly AssetTransferCategory[];
  /**
   * Secondary native-value sources used ONLY when `supportedCategories` omits `internal`, tried in
   * THIS order. The adapter moves to the next source only when the current one is unavailable to
   * our API key (a capability rejection); a transient failure still withholds the whole chain, and
   * a source that answers is authoritative even when it recovers nothing.
   */
  nativeSources: readonly NativeValueSource[];
  /**
   * Canonical wrapped-native ERC20 (WETH / WPOL) on this chain. The native coin has no contract
   * address, so its USD market is read through the wrapped token, which trades 1:1 and is the
   * deepest pool on every chain. Lowercased; `null` would mean "no wrapped market known".
   */
  wrappedNativeContract: string | null;
}

// Alchemy `internal` (trace) transfers are supported only on Ethereum, Polygon, and Base
// (https://www.alchemy.com/docs/data/transfers-api/transfers-endpoints/alchemy-get-asset-transfers).
// The NO_INTERNAL chains recover the same movements through `nativeSources` instead — see
// native-trace.ts for why the Debug API, and not the Parity Trace API, is the first path on those
// chains, and native-balance-diff.ts for the free-tier fallback behind it.
const FULL: readonly AssetTransferCategory[] = ["external", "internal", "erc20", "erc721", "erc1155"];
const NO_INTERNAL: readonly AssetTransferCategory[] = ["external", "erc20", "erc721", "erc1155"];

// Priority order matters: the trace is an exact list of movements and the balance diff is only
// their net, so the diff is a fallback for keys that cannot call the trace at all — never a
// substitute for a trace that works.
const NO_RECOVERY: readonly NativeValueSource[] = [];
const TRACE_THEN_BALANCE: readonly NativeValueSource[] = ["alchemy-debug", "balance-diff"];

// Single source of truth for the fixed supported-chain topology. This is the
// isolation seam for the future per-binding chain-discovery + schema move; it
// does NOT itself provide dynamic discovery. Order is load-bearing: the mock
// adapter maps fixtures by `index % length`, so it must stay [1,8453,42161,10,137].
export const CHAIN_REGISTRY: readonly ChainRegistryEntry[] = [
  { chainId: 1, network: "eth-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: FULL, nativeSources: NO_RECOVERY, wrappedNativeContract: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
  { chainId: 8453, network: "base-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: FULL, nativeSources: NO_RECOVERY, wrappedNativeContract: "0x4200000000000000000000000000000000000006" },
  { chainId: 42161, network: "arb-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: NO_INTERNAL, nativeSources: TRACE_THEN_BALANCE, wrappedNativeContract: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
  { chainId: 10, network: "opt-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: NO_INTERNAL, nativeSources: TRACE_THEN_BALANCE, wrappedNativeContract: "0x4200000000000000000000000000000000000006" },
  { chainId: 137, network: "polygon-mainnet", nativeSymbol: "POL", nativeDecimals: 18, supportedCategories: FULL, nativeSources: NO_RECOVERY, wrappedNativeContract: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" },
];

export const SUPPORTED_CHAIN_IDS: readonly number[] = CHAIN_REGISTRY.map((entry) => entry.chainId);

const BY_CHAIN_ID: ReadonlyMap<number, ChainRegistryEntry> = new Map(CHAIN_REGISTRY.map((entry) => [entry.chainId, entry]));

// Native coin symbol for a supported chain, or null for a chain we do not index.
// Chains that share a symbol (ETH on 1 / 8453 / 42161 / 10) also share one historical
// close, so a caller can resolve the price once and cache it under every such chain.
export function nativeSymbolOf(chainId: number): string | null {
  return BY_CHAIN_ID.get(chainId)?.nativeSymbol ?? null;
}
