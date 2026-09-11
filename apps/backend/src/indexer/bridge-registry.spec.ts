import { describe, expect, it } from "vitest";
import { bridgeContractLabel, isBridgeContract, BRIDGE_CONTRACTS } from "./bridge-registry";
import { SUPPORTED_CHAIN_IDS } from "./chain-registry";

describe("bridge-registry curated addresses", () => {
  it("recognizes the Across SpokePool on every supported chain (case-insensitive)", () => {
    const acrossSpokePool: Record<number, string> = {
      1: "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5",
      10: "0x6f26bf09b1c792e3228e5467807a900a503c0281",
      8453: "0x09aea4b2242abc8bb4bb78d537a67a245a7bec64",
      42161: "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a",
      137: "0x9295ee1d8c5b022be115a2ad3c30c72e34e7f096",
    };
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      const address = acrossSpokePool[chainId];
      expect(isBridgeContract(chainId, address)).toBe(true);
      // checksum-case variant resolves to the same entry
      expect(isBridgeContract(chainId, address.toUpperCase().replace("0X", "0x"))).toBe(true);
    }
  });

  it("recognizes Stargate V2 pools (native/USDC/USDT) on their chains", () => {
    expect(isBridgeContract(1, "0x77b2043768d28e9c9ab44e1abfc95944bce57931")).toBe(true); // ETH native pool
    expect(isBridgeContract(137, "0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4")).toBe(true); // Polygon USDC pool
    expect(isBridgeContract(8453, "0x27a16dc786820b16e5c9028b75b99f6f604b5d26")).toBe(true); // Base USDC pool
  });

  it("keeps the LI.FI aggregator on every supported chain (same CREATE2 address)", () => {
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      expect(isBridgeContract(chainId, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae")).toBe(true);
    }
  });

  it("is chain-scoped: an address registered on one chain is not matched on another", () => {
    // The Ethereum Stargate native pool is not a bridge address on Polygon.
    expect(isBridgeContract(1, "0x77b2043768d28e9c9ab44e1abfc95944bce57931")).toBe(true);
    expect(isBridgeContract(137, "0x77b2043768d28e9c9ab44e1abfc95944bce57931")).toBe(false);
  });

  it("does not flag a random non-bridge address", () => {
    expect(isBridgeContract(1, "0x000000000000000000000000000000000000dead")).toBe(false);
    expect(isBridgeContract(999, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae")).toBe(false); // unsupported chain
  });

  it("registers a bridge set for exactly the supported chains", () => {
    expect(Object.keys(BRIDGE_CONTRACTS).map(Number).sort((a, b) => a - b)).toEqual([...SUPPORTED_CHAIN_IDS].sort((a, b) => a - b));
  });

  it("recognizes the newly curated same-address CREATE2 aggregators on every supported chain", () => {
    const aggregators = [
      "0x89c6340b1a1f4b25d36cd8b063d49045caf3f818", // LI.FI Permit2 Proxy v1.0.4
      "0x74f665be90ffcd9ce9dca68cb5875570b711ceca", // Owlto Finance: EVM Maker
      "0x4cd00e387622c35bddb9b4c962c136462338bc31", // Relay: Depository
      "0x87a26566dbb3bf206634c1792a96ff4989e3f56e", // Mayan: MayanForwarderWithReferrer
    ];
    for (const chainId of SUPPORTED_CHAIN_IDS) {
      for (const address of aggregators) {
        expect(isBridgeContract(chainId, address)).toBe(true);
        expect(isBridgeContract(chainId, address.toUpperCase().replace("0X", "0x"))).toBe(true);
      }
    }
  });

  it("recognizes the Owlto Bridge-Core depositor only on the chains it was confirmed on (Ethereum, Optimism, Arbitrum One)", () => {
    const owltoDepositor = "0x0e83ded9f80e1c92549615d96842f5cb64a08762";
    expect(isBridgeContract(1, owltoDepositor)).toBe(true);
    expect(isBridgeContract(10, owltoDepositor)).toBe(true);
    expect(isBridgeContract(42161, owltoDepositor)).toBe(true);
    expect(isBridgeContract(8453, owltoDepositor)).toBe(false);
    expect(isBridgeContract(137, owltoDepositor)).toBe(false);
  });

  it("recognizes the legacy Optimism L1StandardBridge (L1ChugSplashProxy) alongside the current one, on Ethereum only", () => {
    expect(isBridgeContract(1, "0xeb9bf100225c214efc3e7c651ebbadcf85177607")).toBe(true);
    expect(isBridgeContract(1, "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1")).toBe(true);
    expect(isBridgeContract(10, "0xeb9bf100225c214efc3e7c651ebbadcf85177607")).toBe(false);
  });

  it("recognizes Mayan Swift as an Ethereum-only entry, not on other chains", () => {
    const mayanSwift = "0xc38e4e6a15593f908255214653d3d947ca1c2338";
    expect(isBridgeContract(1, mayanSwift)).toBe(true);
    expect(isBridgeContract(10, mayanSwift)).toBe(false);
    expect(isBridgeContract(8453, mayanSwift)).toBe(false);
    expect(isBridgeContract(42161, mayanSwift)).toBe(false);
    expect(isBridgeContract(137, mayanSwift)).toBe(false);
  });

  it("recognizes the newly curated Arbitrum One native gateway entrypoints (TODO(curate) resolved)", () => {
    const arbitrumNative = [
      "0x0000000000000000000000000000000000000064", // ArbSys precompile
      "0x5288c571fd7ad117bea99bf60fe0846c4e84f933", // L2 Gateway Router
      "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // L2 ERC20 Gateway
      "0x096760f208390250649e3e8763348e783aef5562", // L2 Custom Gateway
      "0x6c411ad3e74de3e7bd422b94a27770f5b86c623b", // L2 WETH Gateway
    ];
    for (const address of arbitrumNative) {
      expect(isBridgeContract(42161, address)).toBe(true);
      expect(isBridgeContract(1, address)).toBe(false);
    }
  });

  it("recognizes the newly curated Polygon PoS native child-chain bridge manager (TODO(curate) resolved)", () => {
    expect(isBridgeContract(137, "0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa")).toBe(true);
    expect(isBridgeContract(1, "0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa")).toBe(false);
  });
});

describe("bridgeContractLabel", () => {
  // A few entries per chain, spanning same-address aggregators, per-chain curated addresses, and
  // the OP-Stack predeploy whose label is assigned per chain (not baked into the shared address).
  const labeled: ReadonlyArray<[number, string, string]> = [
    [1, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", "LI.FI Diamond"],
    [1, "0x89c6340b1a1f4b25d36cd8b063d49045caf3f818", "LI.FI Permit2 Proxy"],
    [1, "0x74f665be90ffcd9ce9dca68cb5875570b711ceca", "Owlto Finance: EVM Maker"],
    [1, "0x4cd00e387622c35bddb9b4c962c136462338bc31", "Relay: Depository"],
    [1, "0x87a26566dbb3bf206634c1792a96ff4989e3f56e", "Mayan: Forwarder"],
    [1, "0xc38e4e6a15593f908255214653d3d947ca1c2338", "Mayan: Swift"],
    [1, "0x99c9fc46f92e8a1c0dec1b1747d010903e884be1", "Optimism: L1StandardBridge"],
    [1, "0xeb9bf100225c214efc3e7c651ebbadcf85177607", "Optimism: L1StandardBridge (legacy)"],
    [1, "0x3154cf16ccdb4c6d922629664174b904d80f2c35", "Base: L1StandardBridge"],
    [1, "0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f", "Arbitrum: Delayed Inbox"],
    [1, "0xa0c68c638235ee32657e8f720a23cec1bfc77c77", "Polygon PoS: RootChainManager"],
    [1, "0x40ec5b33f54e0e8a33a975908c5ba1c14e5bbbdf", "Polygon PoS: ERC20 Predicate"],
    [1, "0x0e83ded9f80e1c92549615d96842f5cb64a08762", "Owlto Finance: Bridge-Core"],
    [1, "0x5c7bcd6e7de5423a257d81b442095a1a6ced35c5", "Across: SpokePool"],
    [1, "0x77b2043768d28e9c9ab44e1abfc95944bce57931", "Stargate: Pool (Native)"],
    [1, "0xc026395860db2d07ee33e05fe50ed7bd583189c7", "Stargate: Pool (USDC)"],
    [1, "0x933597a323eb81cae705c5bc29985172fd5a3973", "Stargate: Pool (USDT)"],
    // Same predeploy address, different label depending on which chain it's queried on.
    [10, "0x4200000000000000000000000000000000000010", "Optimism: L2StandardBridge"],
    [8453, "0x4200000000000000000000000000000000000010", "Base: L2StandardBridge"],
    [42161, "0x0000000000000000000000000000000000000064", "Arbitrum: ArbSys"],
    [42161, "0x5288c571fd7ad117bea99bf60fe0846c4e84f933", "Arbitrum: L2 Gateway Router"],
    [42161, "0x09e9222e96e7b4ae2a407b98d48e330053351eee", "Arbitrum: L2 ERC20 Gateway"],
    [42161, "0x096760f208390250649e3e8763348e783aef5562", "Arbitrum: L2 Custom Gateway"],
    [42161, "0x6c411ad3e74de3e7bd422b94a27770f5b86c623b", "Arbitrum: L2 WETH Gateway"],
    [42161, "0xe35e9842fceaca96570b734083f4a58e8f7c5f2a", "Across: SpokePool"],
    [137, "0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa", "Polygon PoS: ChildChainManager"],
    [137, "0x9aa02d4fae7f58b8e8f34c66e756cc734dac7fe4", "Stargate: Pool (USDC)"],
  ];

  it("returns the curated display label for each seeded address, case-insensitively", () => {
    for (const [chainId, address, label] of labeled) {
      expect(bridgeContractLabel(chainId, address)).toBe(label);
      expect(bridgeContractLabel(chainId, address.toUpperCase().replace("0X", "0x"))).toBe(label);
    }
  });

  it("keeps isBridgeContract true for every labeled address", () => {
    for (const [chainId, address] of labeled) {
      expect(isBridgeContract(chainId, address)).toBe(true);
    }
  });

  it("returns null for an unknown address, an unsupported chain, and a wrong-chain lookup", () => {
    expect(bridgeContractLabel(1, "0x000000000000000000000000000000000000dead")).toBeNull();
    expect(bridgeContractLabel(999, "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae")).toBeNull();
    // Mayan Swift is Ethereum-only.
    expect(bridgeContractLabel(10, "0xc38e4e6a15593f908255214653d3d947ca1c2338")).toBeNull();
  });
});
