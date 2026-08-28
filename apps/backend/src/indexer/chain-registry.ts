export type AssetTransferCategory = "external" | "internal" | "erc20" | "erc721" | "erc1155";

export interface ChainRegistryEntry {
  chainId: number;
  network: string;
  nativeSymbol: string;
  nativeDecimals: number;
  supportedCategories: readonly AssetTransferCategory[];
}

// Alchemy `internal` (trace) transfers are supported only on Ethereum, Polygon, and Base.
const FULL: readonly AssetTransferCategory[] = ["external", "internal", "erc20", "erc721", "erc1155"];
const NO_INTERNAL: readonly AssetTransferCategory[] = ["external", "erc20", "erc721", "erc1155"];

// Single source of truth for the fixed supported-chain topology. This is the
// isolation seam for the future per-binding chain-discovery + schema move; it
// does NOT itself provide dynamic discovery. Order is load-bearing: the mock
// adapter maps fixtures by `index % length`, so it must stay [1,8453,42161,10,137].
export const CHAIN_REGISTRY: readonly ChainRegistryEntry[] = [
  { chainId: 1, network: "eth-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: FULL },
  { chainId: 8453, network: "base-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: FULL },
  { chainId: 42161, network: "arb-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: NO_INTERNAL },
  { chainId: 10, network: "opt-mainnet", nativeSymbol: "ETH", nativeDecimals: 18, supportedCategories: NO_INTERNAL },
  { chainId: 137, network: "polygon-mainnet", nativeSymbol: "POL", nativeDecimals: 18, supportedCategories: FULL },
];

export const SUPPORTED_CHAIN_IDS: readonly number[] = CHAIN_REGISTRY.map((entry) => entry.chainId);
