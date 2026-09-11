// Spam / dust detection for inbound-only transfers.
//
// Anyone can push an arbitrary token or NFT into a wallet for free. These dust
// airdrops flood the ledger (in the live DB they were ~65% of all rows, almost
// entirely inbound ERC1155/ERC721) and must never enter tax computation. They
// are still real on-chain events under a frozen upsert key and an anchor trail,
// so they are TAGGED (classification "SPAM"), never deleted. A false positive is
// fully recoverable through manual reclassification.
//
// Detection is layered and applies ONLY to a pure-inbound receive (a group the
// wallet never touched on the OUT side). Send / swap / internal-transfer groups
// can never be spam, so the caller invokes this only for a RECEIVE leg.

export type SpamAssetType = "NATIVE" | "ERC20" | "ERC721" | "ERC1155";

export interface SpamLegInput {
  assetType: SpamAssetType;
  symbol: string;
  assetContract: string | null;
}

// Authority seam (Layer 2): a curated feed populates these. Addresses are stored
// lowercased. The denylist forces SPAM even for a clean-looking ticker; the
// allowlist rescues a trusted contract from every heuristic below.
const seed = (addresses: readonly string[]): ReadonlySet<string> => new Set(addresses.map((a) => a.toLowerCase()));

export const SPAM_CONTRACT_DENYLIST: ReadonlySet<string> = seed([
  // Phishing/impersonation tokens observed pushing dust into live wallets.
  "0x4283aa1d82a592853269a495751de36443c1f689", // symbol "⭐Airdrop: solshiba .live"
  "0x09ff1d86683687f944dfda018c7870a869499481", // symbol "EꓔH" (homoglyph impersonating ETH)
  // Polygon USDT impersonators. These forge the OUT side: the contract emits a Transfer whose
  // `from` is the victim, so the wallet looks like it SENT 50 "USDT" it never held.
  "0x248e1aaffcf66930d22f6bcc3e3b560d64c92678", // symbol "UЅDТ0" (Cyrillic Ѕ/Т impersonating USDT0)
  "0x93e58aa4d8f8f9cfb02ca3d1fa5332d55006252c", // symbol "UЅDТ" (Cyrillic Ѕ/Т impersonating USDT)
]);

export const CONTRACT_ALLOWLIST: ReadonlySet<string> = seed([
  // Canonical USD stablecoins across supported chains — never auto-flagged.
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC ethereum
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC base
  "0xaf88d065e77c8cc2239327c5edb3a432268e5831", // USDC arbitrum
  "0x0b2c639c533813f4aa9d7837caf62653d097ff85", // USDC optimism
  "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", // USDT polygon
]);

// Real tickers are short printable-ASCII alphanumerics. Spam weaponizes the
// symbol field with URLs, domains, emoji, whitespace, or Unicode homoglyphs to
// phish the wallet owner. NOTE: the adapter's own "UNKNOWN" placeholder symbol
// is a clean ASCII word and is intentionally NOT weaponized on its own — an
// NFT airdrop is caught by the asset-type rule, not by its missing symbol.
// An ERC20 whose ticker is exactly the chain's native coin ("ETH") is an impersonation: no legitimate
// fungible token carries the bare native symbol (wrapped ETH is "WETH", staked variants are prefixed),
// and the live wallet showed such tokens forging outbound Transfer logs to fake a 0.0055 ETH "send".
// Kept deliberately narrow — "POL"/"MATIC" are real ERC20s on Ethereum, so only the bare "ETH" ticker
// is treated as impersonation, and an allowlisted contract always wins.
const NATIVE_IMPERSONATION_SYMBOLS: ReadonlySet<string> = new Set(["ETH"]);

export function isNativeImpersonation(assetType: SpamAssetType, symbol: string): boolean {
  return assetType === "ERC20" && NATIVE_IMPERSONATION_SYMBOLS.has(symbol.trim().toUpperCase());
}

export function isWeaponizedSymbol(symbol: string): boolean {
  const value = symbol.trim();
  if (value === "") return true; // an inbound token with no symbol at all
  if (value.length > 11) return true; // longer than any legitimate ticker
  if (/[^\x21-\x7e]/.test(value)) return true; // emoji, homoglyph, or inner whitespace (non printable-ASCII)
  if (/(https?:|www\.|[/@]|\.(io|live|xyz|com|net|org|app|fi|finance|claim|gift|vip|top|site))\b/i.test(value)) return true;
  return false;
}

// Decide whether a pure-inbound RECEIVE leg is dust/airdrop spam.
export function isInboundSpam(leg: SpamLegInput): boolean {
  const contract = leg.assetContract?.toLowerCase() ?? null;
  if (contract && CONTRACT_ALLOWLIST.has(contract)) return false;
  if (contract && SPAM_CONTRACT_DENYLIST.has(contract)) return true;
  // Inbound-only NFTs are airdrop dust by default (a purchased/minted NFT carries
  // an outbound payment leg and never classifies as a bare RECEIVE).
  if (leg.assetType === "ERC721" || leg.assetType === "ERC1155") return true;
  if (leg.assetType === "ERC20" && isWeaponizedSymbol(leg.symbol)) return true;
  if (isNativeImpersonation(leg.assetType, leg.symbol)) return true;
  return false;
}
