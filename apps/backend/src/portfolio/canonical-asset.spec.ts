import { describe, expect, it } from "vitest";
import { canonicalAssetIdOf } from "./canonical-asset";

describe("canonicalAssetIdOf", () => {
  it("groups native coins by chain nativeSymbol and canonical deployments by (chain, contract), case-insensitively", () => {
    expect(canonicalAssetIdOf(1, "NATIVE", null)).toBe("eth");
    expect(canonicalAssetIdOf(10, "NATIVE", null)).toBe("eth");
    expect(canonicalAssetIdOf(137, "NATIVE", null)).toBe("pol");
    expect(canonicalAssetIdOf(8453, "ERC20", "0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913")).toBe("usdc");
    expect(canonicalAssetIdOf(42161, "ERC20", "0xc87b37a581ec3257b734886d9d3a581f5a9d056c")).toBe("ath");
  });

  it("never groups by symbol: an unlisted contract is null even on a listed chain", () => {
    expect(canonicalAssetIdOf(8453, "ERC20", "0x1111111111111111111111111111111111111111")).toBeNull();
    expect(canonicalAssetIdOf(56, "NATIVE", null)).toBeNull();
    expect(canonicalAssetIdOf(1, "ERC20", null)).toBeNull();
  });
});
