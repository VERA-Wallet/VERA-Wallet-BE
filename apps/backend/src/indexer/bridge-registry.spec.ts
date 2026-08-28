import { describe, expect, it } from "vitest";
import { isBridgeContract, BRIDGE_CONTRACTS } from "./bridge-registry";
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
});
