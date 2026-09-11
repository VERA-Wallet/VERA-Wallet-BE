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
//
// Each address also carries a short, brand-style display LABEL (identity only — never invented)
// so the FE can render "Relay: Depository (0x4cd0…bc31)" instead of a bare hash. `chainBridges`
// composes both `BRIDGE_CONTRACTS` (the address-only set `isBridgeContract` matches against) and
// `BRIDGE_LABELS` (the address->label map behind `bridgeContractLabel`) from the SAME curated
// entries below, so the two can never drift apart.

/** One curated bridge/aggregator address with its human-readable identity. */
interface LabeledAddress {
  readonly address: string;
  readonly label: string;
}

// Cross-chain bridge/swap AGGREGATORS deployed at the SAME address on every EVM chain (CREATE2).
// These are the contracts real users actually route through (vs the raw official L1 bridges).
// Each entry below was directly confirmed (Etherscan/explorer public name tag or official docs)
// on at least two of our supported chains at the identical address; see per-entry source notes.
const CROSS_CHAIN_AGGREGATORS: readonly LabeledAddress[] = [
  { address: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", label: "LI.FI Diamond" }, // bridge + swap aggregator
  // LI.FI: Permit2 Proxy v1.0.4 — gasless-approval proxy in front of the Diamond. Confirmed at the
  // same address on Ethereum, Base and OP Mainnet: https://etherscan.io/address/0x89c6340b1a1f4b25d36cd8b063d49045caf3f818
  // (also https://basescan.org, https://optimistic.etherscan.io for the same address).
  { address: "0x89c6340b1a1f4b25d36cd8b063d49045caf3f818", label: "LI.FI Permit2 Proxy" },
  // Owlto Finance: EVM Maker — the maker/fulfillment contract used across Owlto's supported EVM
  // chains (same address per https://docs.owlto.finance/basics/smart-contracts-and-maker,
  // "EVM Maker Contract"). Matches real wallet data: OUT counterparty on Ethereum, IN sender on
  // Arbitrum One for the same bridge round-trip.
  { address: "0x74f665be90ffcd9ce9dca68cb5875570b711ceca", label: "Owlto Finance: EVM Maker" },
  // Relay (relay.link): RelayDepository — confirmed at the same address on Ethereum and Base:
  // https://etherscan.io/address/0x4cd00e387622c35bddb9b4c962c136462338bc31
  // https://basescan.org/address/0x4cd00e387622c35bddb9b4c962c136462338bc31 (both "Relay: Depository").
  { address: "0x4cd00e387622c35bddb9b4c962c136462338bc31", label: "Relay: Depository" },
  // Mayan Finance: MayanForwarderWithReferrer — forwards ETH/ERC20 (incl. forwardERC20) into
  // Mayan's canonical Forwarder (0x337685fdaB40D39bd02028545a4FfA7D287cC3E2). Confirmed at the
  // same address on Ethereum and Polygon:
  // https://etherscan.io/address/0x87a26566dbb3bf206634c1792a96ff4989e3f56e
  // https://polygonscan.com/address/0x87a26566dbb3bf206634c1792a96ff4989e3f56e
  { address: "0x87a26566dbb3bf206634c1792a96ff4989e3f56e", label: "Mayan: Forwarder" },
];

// Owlto Finance Bridge-Core deposit entrypoint. Unlike the CREATE2 aggregators above this is NOT
// the same address on every chain (Owlto docs list a different address for BSC/Polygon/XLayer/etc),
// so only the chains we directly confirmed are curated here to avoid guessing unverified addresses.
// Source: https://etherscan.io/address/0x0e83ded9f80e1c92549615d96842f5cb64a08762 ("Owlto Finance:
// Depositor", matches a real Ethereum OUT in wallet data) cross-referenced with
// https://docs.owlto.finance/basics/smart-contracts-and-maker ("Bridge-Core Smart Contract" table,
// same address listed for Optimism and ArbitrumOne) and the deposit()/target/maker/destination/
// channel ABI shape confirmed live on https://optimistic.etherscan.io for the same address.
const OWLTO_BRIDGE_CORE_ADDRESS: Record<number, string> = {
  1: "0x0e83ded9f80e1c92549615d96842f5cb64a08762",
  10: "0x0e83ded9f80e1c92549615d96842f5cb64a08762",
  42161: "0x0e83ded9f80e1c92549615d96842f5cb64a08762",
};
const OWLTO_BRIDGE_CORE: Record<number, LabeledAddress> = Object.fromEntries(
  Object.entries(OWLTO_BRIDGE_CORE_ADDRESS).map(([chainId, address]) => [
    chainId,
    { address, label: "Owlto Finance: Bridge-Core" },
  ]),
);

// Ethereum-mainnet-only bridge/aggregator contracts: identity was confirmed on chain 1 but NOT
// independently verified on any other supported chain, so (unlike CROSS_CHAIN_AGGREGATORS) these
// are only registered for chainId 1.
const ETHEREUM_ONLY_AGGREGATORS: readonly LabeledAddress[] = [
  // Mayan Finance: Mayan Swift — order fulfillment/escrow contract for Mayan's fast cross-chain
  // swap product (method seen in wallet data: directFulfill). Source:
  // https://etherscan.io/address/0xc38e4e6a15593f908255214653d3d947ca1c2338 ("Mayan: Swift").
  { address: "0xc38e4e6a15593f908255214653d3d947ca1c2338", label: "Mayan: Swift" },
];

const OP_STACK_L2_BRIDGE = "0x4200000000000000000000000000000000000010"; // L2StandardBridge predeploy (Optimism, Base)
// The predeploy sits at the identical address on every OP Stack chain, so the label is assigned
// per chain at the BRIDGE_CONTRACTS/BRIDGE_LABELS call site below rather than baked in here.
const OP_L2_STANDARD_BRIDGE: LabeledAddress = { address: OP_STACK_L2_BRIDGE, label: "Optimism: L2StandardBridge" };
const BASE_L2_STANDARD_BRIDGE: LabeledAddress = { address: OP_STACK_L2_BRIDGE, label: "Base: L2StandardBridge" };

// Across Protocol SpokePool: the single per-chain entrypoint a user's bridge transfer touches.
// Source: https://docs.across.to/chains-and-contracts (official contracts repo). One clean address
// per chain, so a bridge OUT/IN whose counterparty is the SpokePool is flagged for review.
const ACROSS_SPOKE_POOL_ADDRESS: Record<number, string> = {
  1: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5",
  10: "0x6f26bf09b1c792e3228e5467807a900a503c0281",
  8453: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
  42161: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
  137: "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096",
};
const ACROSS_SPOKE_POOL: Record<number, LabeledAddress> = Object.fromEntries(
  Object.entries(ACROSS_SPOKE_POOL_ADDRESS).map(([chainId, address]) => [chainId, { address, label: "Across: SpokePool" }]),
);

// Stargate V2 pool contracts: the per-token entrypoints a user's bridge transfer touches.
// Source: https://stargateprotocol.gitbook.io/stargate/v2-developer-docs/technical-reference/mainnet-contracts
const STARGATE_POOLS: Record<number, readonly LabeledAddress[]> = {
  1: [
    { address: "0x77b2043768d28e9c9ab44e1abfc95944bce57931", label: "Stargate: Pool (Native)" },
    { address: "0xc026395860db2d07ee33e05fe50ed7bd583189c7", label: "Stargate: Pool (USDC)" },
    { address: "0x933597a323eb81cae705c5bc29985172fd5a3973", label: "Stargate: Pool (USDT)" },
  ],
  10: [
    { address: "0xe8cdf27acd73a434d661c84887215f7598e7d0d3", label: "Stargate: Pool (Native)" },
    { address: "0xce8cca271ebc0533920c83d39f417ed6a0abb7d0", label: "Stargate: Pool (USDC)" },
    { address: "0x19cfce47ed54a88614648dc3f19a5980097007dd", label: "Stargate: Pool (USDT)" },
  ],
  8453: [
    { address: "0xdc181bd607330aeebef6ea62e03e5e1fb4b6f7c7", label: "Stargate: Pool (Native)" },
    { address: "0x27a16dc786820b16e5c9028b75b99f6f604b5d26", label: "Stargate: Pool (USDC)" },
  ],
  42161: [
    { address: "0xa45b5130f36cdca45667738e2a258ab09f4a5f7f", label: "Stargate: Pool (Native)" },
    { address: "0xe8cdf27acd73a434d661c84887215f7598e7d0d3", label: "Stargate: Pool (USDC)" },
    { address: "0xce8cca271ebc0533920c83d39f417ed6a0abb7d0", label: "Stargate: Pool (USDT)" },
  ],
  137: [
    { address: "0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4", label: "Stargate: Pool (USDC)" },
    { address: "0xd47b03ee6d86cf251ee7860fb2acf9f91b9fd4d7", label: "Stargate: Pool (USDT)" },
  ],
};

// Canonical official rollup bridge entrypoints reachable from Ethereum L1.
const OFFICIAL_L1_BRIDGES: readonly LabeledAddress[] = [
  // Optimism L1StandardBridge (current, post-Bedrock; superchain-registry op.toml L1StandardBridgeProxy)
  { address: "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", label: "Optimism: L1StandardBridge" },
  // Optimism L1StandardBridge — LEGACY (pre-Bedrock) proxy, still a verified, real bridge contract.
  // Source: https://etherscan.io/address/0xeb9bf100225c214efc3e7c651ebbadcf85177607 ("Optimism:
  // L1StandardBridge (OP Mainnet)"; verified L1ChugSplashProxy pointing at a StandardBridge
  // implementation). Matches real wallet data: two Ethereum OUT legs with method bridgeETHTo.
  { address: "0xeb9bf100225c214efc3e7c651ebbadcf85177607", label: "Optimism: L1StandardBridge (legacy)" },
  { address: "0x3154cf16ccdb4c6d922629664174b904d80f2c35", label: "Base: L1StandardBridge" },
  { address: "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f", label: "Arbitrum: Delayed Inbox" },
  { address: "0xa0c68c638235ee32657e8f720a23cec1bfc77c77", label: "Polygon PoS: RootChainManager" },
  { address: "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", label: "Polygon PoS: ERC20 Predicate" },
];

// Arbitrum One (chainId 42161) NATIVE-side gateway/bridge entrypoints — the contracts a user's
// withdrawal or gateway interaction touches directly on Arbitrum One itself (vs the L1 Delayed
// Inbox above). Source: https://docs.arbitrum.io/build-decentralized-apps/reference/contract-addresses
// cross-referenced against Arbiscan public name tags for each address (e.g.
// https://arbiscan.io/address/0x5288c571Fd7aD117beA99bF60FE0846C4E84F933 "Arbitrum One: L2 Gateway Router").
const ARBITRUM_NATIVE_GATEWAYS: readonly LabeledAddress[] = [
  { address: "0x0000000000000000000000000000000000000064", label: "Arbitrum: ArbSys" }, // L2->L1 withdrawal entrypoint (precompile)
  { address: "0x5288c571fd7ad117bea99bf60fe0846c4e84f933", label: "Arbitrum: L2 Gateway Router" },
  { address: "0x09e9222e96e7b4ae2a407b98d48e330053351eee", label: "Arbitrum: L2 ERC20 Gateway" }, // StandardArbERC20
  { address: "0x096760f208390250649e3e8763348e783aef5562", label: "Arbitrum: L2 Custom Gateway" },
  { address: "0x6c411ad3e74de3e7bd422b94a27770f5b86c623b", label: "Arbitrum: L2 WETH Gateway" },
];

// Polygon PoS (chainId 137) NATIVE-side child-chain bridge manager. Source:
// https://polygonscan.com/address/0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa
// ("Polygon: POS Child Chain Manager Proxy"; maticnetwork/pos-portal ChildChainManagerProxy).
const POLYGON_NATIVE_BRIDGE: readonly LabeledAddress[] = [
  { address: "0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa", label: "Polygon PoS: ChildChainManager" },
];

// Every entry that applies to a chain: its own canonical entrypoints plus the same-address
// aggregators and the curated Across/Stargate/Owlto entrypoints for that chain. Shared by
// `chainBridges` (address set) and `chainLabels` (address->label map) so the two can never drift.
function chainEntries(chainId: number, canonical: readonly LabeledAddress[]): readonly LabeledAddress[] {
  const across = ACROSS_SPOKE_POOL[chainId];
  const owlto = OWLTO_BRIDGE_CORE[chainId];
  return [
    ...canonical,
    ...CROSS_CHAIN_AGGREGATORS,
    ...(chainId === 1 ? ETHEREUM_ONLY_AGGREGATORS : []),
    ...(across ? [across] : []),
    ...(owlto ? [owlto] : []),
    ...(STARGATE_POOLS[chainId] ?? []),
  ];
}

// All addresses are stored lowercased.
function chainBridges(chainId: number, canonical: readonly LabeledAddress[]): ReadonlySet<string> {
  return new Set<string>(chainEntries(chainId, canonical).map((entry) => entry.address.toLowerCase()));
}

// Lowercased address -> display label, for the same entries `chainBridges` matches against.
function chainLabels(chainId: number, canonical: readonly LabeledAddress[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const entry of chainEntries(chainId, canonical)) {
    labels.set(entry.address.toLowerCase(), entry.label);
  }
  return labels;
}

export const BRIDGE_CONTRACTS: Record<number, ReadonlySet<string>> = {
  1: chainBridges(1, OFFICIAL_L1_BRIDGES),
  10: chainBridges(10, [OP_L2_STANDARD_BRIDGE]),
  8453: chainBridges(8453, [BASE_L2_STANDARD_BRIDGE]),
  42161: chainBridges(42161, ARBITRUM_NATIVE_GATEWAYS),
  137: chainBridges(137, POLYGON_NATIVE_BRIDGE),
};

const BRIDGE_LABELS: Record<number, ReadonlyMap<string, string>> = {
  1: chainLabels(1, OFFICIAL_L1_BRIDGES),
  10: chainLabels(10, [OP_L2_STANDARD_BRIDGE]),
  8453: chainLabels(8453, [BASE_L2_STANDARD_BRIDGE]),
  42161: chainLabels(42161, ARBITRUM_NATIVE_GATEWAYS),
  137: chainLabels(137, POLYGON_NATIVE_BRIDGE),
};

/** True when `address` is a seeded bridge contract on `chainId` (case-insensitive). */
export function isBridgeContract(chainId: number, address: string): boolean {
  const contracts = BRIDGE_CONTRACTS[chainId];
  return contracts !== undefined && contracts.has(address.toLowerCase());
}

/**
 * The curated display label for `address` on `chainId` (e.g. "Relay: Depository"), or null when
 * the address is not a seeded bridge contract on that chain. Case-insensitive. Every address with
 * a label here is also a bridge contract per `isBridgeContract` — the two are derived from the
 * same curated entries.
 */
export function bridgeContractLabel(chainId: number, address: string): string | null {
  const labels = BRIDGE_LABELS[chainId];
  return labels?.get(address.toLowerCase()) ?? null;
}

// Bridge-suspected legs get this confidence so the FE review gate (confidence < 0.5) surfaces
// them as "confirm needed" without changing classification or tax treatment.
export const BRIDGE_REVIEW_CONFIDENCE = 0.4;
