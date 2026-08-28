import { describe, expect, it } from "vitest";
import { CONTRACT_ALLOWLIST, SPAM_CONTRACT_DENYLIST, isInboundSpam, isWeaponizedSymbol } from "./spam-filter";

describe("isWeaponizedSymbol", () => {
  it("accepts real short ASCII tickers, including the UNKNOWN placeholder", () => {
    for (const good of ["ETH", "USDC", "aEthWETH", "UNKNOWN", "POL", "WBTC"]) {
      expect(isWeaponizedSymbol(good)).toBe(false);
    }
  });

  it("flags empty / whitespace-only symbols", () => {
    expect(isWeaponizedSymbol("")).toBe(true);
    expect(isWeaponizedSymbol("   ")).toBe(true);
  });

  it("flags URL / domain / handle phishing in the symbol field", () => {
    expect(isWeaponizedSymbol("⭐Airdrop: solshiba .live")).toBe(true);
    expect(isWeaponizedSymbol("claim-at-uni.fi")).toBe(true);
    expect(isWeaponizedSymbol("https://x.io")).toBe(true);
    expect(isWeaponizedSymbol("@airdrop")).toBe(true);
  });

  it("flags non-ASCII homoglyph impersonation", () => {
    expect(isWeaponizedSymbol("EꓔH")).toBe(true); // ꓔ is a Lisu letter, not Latin T
  });

  it("flags absurdly long symbols", () => {
    expect(isWeaponizedSymbol("VISITMYWEBSITE")).toBe(true);
  });
});

describe("isInboundSpam", () => {
  const nft = { assetType: "ERC1155" as const, symbol: "UNKNOWN", assetContract: "0x" + "ab".repeat(20) };

  it("treats an inbound-only NFT as airdrop dust", () => {
    expect(isInboundSpam(nft)).toBe(true);
    expect(isInboundSpam({ ...nft, assetType: "ERC721" })).toBe(true);
  });

  it("treats an ERC20 with a weaponized symbol as spam", () => {
    expect(isInboundSpam({ assetType: "ERC20", symbol: "⭐Airdrop: solshiba .live", assetContract: "0x" + "cd".repeat(20) })).toBe(true);
  });

  it("keeps a clean-ticker ERC20 inbound as non-spam", () => {
    expect(isInboundSpam({ assetType: "ERC20", symbol: "DAI", assetContract: "0x" + "ef".repeat(20) })).toBe(false);
  });

  it("never flags a native inbound", () => {
    expect(isInboundSpam({ assetType: "NATIVE", symbol: "ETH", assetContract: null })).toBe(false);
  });

  it("forces spam for a denylisted contract even with a clean ticker", () => {
    const denylisted = [...SPAM_CONTRACT_DENYLIST][0];
    expect(isInboundSpam({ assetType: "ERC20", symbol: "GOOD", assetContract: denylisted.toUpperCase() })).toBe(true);
  });

  it("rescues an allowlisted contract from every heuristic", () => {
    const allowed = [...CONTRACT_ALLOWLIST][0];
    // Even an NFT asset type is rescued when the contract is explicitly trusted.
    expect(isInboundSpam({ assetType: "ERC721", symbol: "", assetContract: allowed })).toBe(false);
  });
});
