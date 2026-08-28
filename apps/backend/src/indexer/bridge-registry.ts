// Known bridge contract addresses per chainId (LOWERCASED).
//
// A transfer whose counterparty is one of these is a SUSPECTED cross-chain bridge move.
// Policy is deliberately CONSERVATIVE: we only FLAG such a leg for user review (by lowering
// its classification confidence below the FE review floor) and NEVER auto-reclassify it.
// A tax app must not silently drop a taxable disposal on a registry false positive, so the
// default classification (SEND/RECEIVE) is preserved and the user decides whether it was a
// bridge (self-move) via a manual INTERNAL_TRANSFER reclassification.
//
// This is curated DATA, not logic: expand/verify against an authoritative source. A missing
// address is safe (the leg simply keeps its default classification). Only high-confidence
// canonical bridge contracts are seeded here.
// Cross-chain bridge/swap AGGREGATORS deployed at the SAME address on every EVM chain (CREATE2).
// These are the contracts real users actually route through (vs the raw official L1 bridges).
const CROSS_CHAIN_AGGREGATORS: readonly string[] = [
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LI.FI Diamond (bridge + swap aggregator)
];

const OP_STACK_L2_BRIDGE = "0x4200000000000000000000000000000000000010"; // L2StandardBridge predeploy (Optimism, Base)

// Across Protocol SpokePool: the single per-chain entrypoint a user's bridge transfer touches.
// Source: https://docs.across.to/chains-and-contracts (official contracts repo). One clean address
// per chain, so a bridge OUT/IN whose counterparty is the SpokePool is flagged for review.
const ACROSS_SPOKE_POOL: Record<number, string> = {
  1: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5",
  10: "0x6f26bf09b1c792e3228e5467807a900a503c0281",
  8453: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
  42161: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
  137: "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096",
};

// Stargate V2 pool contracts: the per-token entrypoints a user's bridge transfer touches.
// Source: https://stargateprotocol.gitbook.io/stargate/v2-developer-docs/technical-reference/mainnet-contracts
const STARGATE_POOLS: Record<number, readonly string[]> = {
  1: [
    "0x77b2043768d28e9c9ab44e1abfc95944bce57931", // StargatePoolNative
    "0xc026395860db2d07ee33e05fe50ed7bd583189c7", // StargatePoolUSDC
    "0x933597a323eb81cae705c5bc29985172fd5a3973", // StargatePoolUSDT
  ],
  10: [
    "0xe8cdf27acd73a434d661c84887215f7598e7d0d3", // StargatePoolNative
    "0xce8cca271ebc0533920c83d39f417ed6a0abb7d0", // StargatePoolUSDC
    "0x19cfce47ed54a88614648dc3f19a5980097007dd", // StargatePoolUSDT
  ],
  8453: [
    "0xdc181bd607330aeebef6ea62e03e5e1fb4b6f7c7", // StargatePoolNative
    "0x27a16dc786820b16e5c9028b75b99f6f604b5d26", // StargatePoolUSDC
  ],
  42161: [
    "0xa45b5130f36cdca45667738e2a258ab09f4a5f7f", // StargatePoolNative
    "0xe8cdf27acd73a434d661c84887215f7598e7d0d3", // StargatePoolUSDC
    "0xce8cca271ebc0533920c83d39f417ed6a0abb7d0", // StargatePoolUSDT
  ],
  137: [
    "0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4", // StargatePoolUSDC
    "0xd47b03ee6d86cf251ee7860fb2acf9f91b9fd4d7", // StargatePoolUSDT
  ],
};

// Canonical official rollup bridge entrypoints reachable from Ethereum L1.
const OFFICIAL_L1_BRIDGES: readonly string[] = [
  "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", // Optimism L1StandardBridge
  "0x3154cf16ccdb4c6d922629664174b904d80f2c35", // Base L1StandardBridge
  "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f", // Arbitrum One Delayed Inbox
  "0xa0c68c638235ee32657e8f720a23cec1bfc77c77", // Polygon PoS RootChainManager
  "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", // Polygon PoS ERC20 predicate
];

// Compose a chain's bridge set from its canonical entrypoints plus the same-address aggregators
// and the curated Across/Stargate entrypoints for that chain. All addresses are stored lowercased.
function chainBridges(chainId: number, canonical: readonly string[]): ReadonlySet<string> {
  const across = ACROSS_SPOKE_POOL[chainId];
  return new Set<string>([
    ...canonical.map((address) => address.toLowerCase()),
    ...CROSS_CHAIN_AGGREGATORS,
    ...(across ? [across] : []),
    ...(STARGATE_POOLS[chainId] ?? []),
  ]);
}

export const BRIDGE_CONTRACTS: Record<number, ReadonlySet<string>> = {
  1: chainBridges(1, OFFICIAL_L1_BRIDGES),
  10: chainBridges(10, [OP_STACK_L2_BRIDGE]),
  8453: chainBridges(8453, [OP_STACK_L2_BRIDGE]),
  42161: chainBridges(42161, []), // TODO(curate): Arbitrum-native L2 gateway addresses
  137: chainBridges(137, []), // TODO(curate): Polygon-native child-chain bridge addresses
};

/** True when `address` is a seeded bridge contract on `chainId` (case-insensitive). */
export function isBridgeContract(chainId: number, address: string): boolean {
  const contracts = BRIDGE_CONTRACTS[chainId];
  return contracts !== undefined && contracts.has(address.toLowerCase());
}

// Bridge-suspected legs get this confidence so the FE review gate (confidence < 0.5) surfaces
// them as "confirm needed" without changing classification or tax treatment.
export const BRIDGE_REVIEW_CONFIDENCE = 0.4;
