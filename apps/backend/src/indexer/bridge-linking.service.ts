import { Inject, Injectable, Logger } from "@nestjs/common";
import type { TransactionRecord } from "../shared/repository.types";
import type { TransactionRepository } from "./transaction.repository";
import { TRANSACTION_REPOSITORY } from "./indexer.tokens";
import { isOwnTransferGroup } from "./own-wallet-linking.service";

// A destination IN arrives shortly after the source OUT; a 6h window is generous for slow bridges
// while staying far below the "unrelated transfer" horizon.
const LINK_WINDOW_MS = 6 * 60 * 60 * 1000;

// Accept a received amount from 80% to 100.5% of the sent amount. Bridge fees are normally < 3%,
// but a fixed relayer fee on a tiny transfer can be a large percentage, so the lower bound is loose;
// the isolated-1:1 + recognized-canonical-asset + different-chain + short-window rules keep false
// links away.
const FEE_LOWER = 800n;
const FEE_UPPER = 1005n;
const FEE_SCALE = 1000n;

// Canonical WETH (wrapped native ETH) per supported chain. WETH is the same economic unit as native
// ETH, so both resolve to the "native:ETH" asset key. A spoofed ERC20 with symbol WETH but a
// non-canonical contract does NOT resolve here and can never be treated as ETH.
const WETH_CONTRACTS: Record<number, string> = {
  1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  10: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  137: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619",
};

// Canonical ERC20 stablecoins per chain, keyed `${chainId}:${lowercasedContract}` -> symbol. A
// cross-chain bridge of the SAME canonical asset uses DIFFERENT contracts per chain, so identity is
// resolved to a symbol-keyed canonical asset ONLY when the contract is a known canonical deployment.
// An unknown or spoofed same-symbol token does NOT resolve, so it is never auto-linked (it stays
// flagged for manual review) - a spoof can never erase a real disposal. (Follow-up: a fuller
// cross-chain token registry would widen coverage beyond native + WETH + canonical stables.)
const CANONICAL_ERC20: Record<string, string> = {
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "USDC",
  "10:0x0b2c639c533813f4aa9d7837caf62653d097ff85": "USDC",
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831": "USDC",
  "137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "USDC",
  "1:0xdac17f958d2ee523a2206206994597c13d831ec7": "USDT",
  "10:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": "USDT",
  "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "USDT",
  "137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "USDT",
};

// Canonical asset keys that are interchangeable USD units. A bridge aggregator routing through a
// liquidity pool (Mayan, Relay, LI.FI) routinely pays out the OTHER stablecoin on the destination
// chain, so a same-symbol rule loses the whole move. Membership is checked on the RESOLVED key,
// which only a known canonical contract can produce - a spoofed "USDC" never reaches this set.
const USD_STABLE_KEYS = new Set(["token:USDC", "token:USDT"]);

/**
 * How a matched pair should be booked.
 *  - `transfer`: same canonical asset on both ends. A pure non-taxable self-move.
 *  - `swap`: two DIFFERENT canonical USD stablecoins. The bridge sold one and delivered the other,
 *    which is a disposal, so it is booked as a swap that happens to cross a chain.
 */
type LinkKind = "transfer" | "swap";

// Classification each leg gets per kind. The `swap` row keeps the disposal on the OUT leg and makes
// the IN leg the cost-basis anchor for the asset that arrived.
const OUT_CLASSIFICATION: Record<LinkKind, string> = { transfer: "INTERNAL_TRANSFER", swap: "EXCHANGE" };
const IN_CLASSIFICATION: Record<LinkKind, string> = { transfer: "INTERNAL_TRANSFER", swap: "RECEIVE" };

// A confirmed pair is no longer a suspicion, so both legs leave the FE's "needs review" floor (0.5).
const LINK_CONFIDENCE = 0.9;

/**
 * Cross-chain bridge linking over the user's OWN indexed data.
 *
 * A bridge is one OUT leg on the source chain plus one IN leg on the destination chain: different
 * tx hash, different chain, no shared key. Because we already index EVERY bound wallet on EVERY
 * supported chain, any IN leg present in our DB is by construction addressed to the user's own
 * wallet -> a matched OUT/IN pair PROVES a self-move. A confirmed pair becomes INTERNAL_TRANSFER on
 * both legs (a non-taxable move) instead of a taxable SEND on one side and a stray RECEIVE (or
 * SPAM-misflagged dust) on the other. No external bridge API is needed.
 *
 * Conservative, tax-safe matching (an auto-reclassification must never erase a real disposal):
 *  - only a `bridge_suspected` OUT (counterparty is a known bridge/aggregator) is considered;
 *  - ISOLATED 1:1 edge only: the OUT has exactly one eligible IN AND that IN has exactly one eligible
 *    OUT. A two-OUT/one-IN (or one-OUT/two-IN) shape is ambiguous and is NEVER linked;
 *  - RECOGNIZED CANONICAL ASSET only (native, canonical WETH, or a canonical stablecoin). An unknown
 *    or spoofed same-symbol token does not resolve and is left flagged for manual review;
 *  - cross-chain, destination within 6h after the source, received amount inside the fee band.
 *
 * Two kinds of pair, because a bridge does not always deliver what it took (see `LinkKind`):
 *  - SAME canonical asset -> both legs INTERNAL_TRANSFER, the non-taxable move described above;
 *  - two DIFFERENT canonical USD stablecoins (USDT in, USDC out) -> the aggregator sold one asset and
 *    delivered another, which IS a disposal. Those legs are booked EXCHANGE (OUT) + RECEIVE (IN) so
 *    the tax engine still charges the conversion, and they carry the SAME `bridge_group_id` +
 *    `bridge_dest_chain_id` purely as display/provenance. `bridge_group_id` moves cost between pools
 *    only together with `classification: "INTERNAL_TRANSFER"` (cost-basis.ts `bridgeGroupOf`), so a
 *    swap pair links for the FE without ever relocating the cost of a taxable event.
 *  The swap kind deliberately does NOT set `group_id`. `group_id` means "one transaction" to every
 *  consumer, and the tax engine collapses a `group_id` to a single gas target (cost-basis.ts
 *  `planGasAttribution`) - across two chains that would silently drop the source-chain fee the user
 *  actually paid in favour of the destination leg, whose fee a relayer paid.
 *
 * Deterministic + idempotent + self-healing: `bridge_group_id` is a pure function of the source leg,
 * and this re-derives every link from stable asset data (chain/asset/amount/time) on every run. A
 * resync reverts payloads to SEND/RECEIVE/SPAM, and a mid-pair write failure can leave one leg linked
 * and the other not; the next run recomputes and repairs both, writing only what actually changed.
 */
@Injectable()
export class BridgeLinkingService {
  private readonly logger = new Logger(BridgeLinkingService.name);

  constructor(@Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepository) {}

  /** Link every isolated-1:1 bridge pair for the user. Returns the number of pairs written this run. */
  async linkForUser(userId: string): Promise<number> {
    const all = await this.transactions.listForUser(userId);
    const outs = all
      .filter((leg) => this.isBridgeOutCandidate(leg))
      .sort(
        (a, b) =>
          a.occurredAt.getTime() - b.occurredAt.getTime() ||
          String(a.payload.id).localeCompare(String(b.payload.id)),
      );
    const ins = all.filter((leg) => leg.payload.direction === "IN" && this.isLinkableIn(leg));

    // Build the full eligibility graph BEFORE mutating, so uniqueness is bidirectional (not greedy):
    // link only an isolated edge where the OUT has one eligible IN and that IN has one eligible OUT.
    // A same-asset and a cross-asset candidate compete in the SAME graph, so an OUT that could be
    // read either way is ambiguous and stays unlinked.
    const eligibleInsByOut = new Map<string, { leg: TransactionRecord; kind: LinkKind }[]>();
    const eligibleOutCountByIn = new Map<string, number>();
    for (const out of outs) {
      const matches: { leg: TransactionRecord; kind: LinkKind }[] = [];
      for (const inLeg of ins) {
        const kind = this.pairKind(out, inLeg);
        if (kind !== null) matches.push({ leg: inLeg, kind });
      }
      eligibleInsByOut.set(String(out.payload.id), matches);
      for (const match of matches) {
        const key = String(match.leg.payload.id);
        eligibleOutCountByIn.set(key, (eligibleOutCountByIn.get(key) ?? 0) + 1);
      }
    }

    let changed = 0;
    for (const out of outs) {
      const matches = eligibleInsByOut.get(String(out.payload.id)) ?? [];
      if (matches.length !== 1) continue; // the OUT must have exactly one eligible IN
      const { leg: inLeg, kind } = matches[0];
      if (eligibleOutCountByIn.get(String(inLeg.payload.id)) !== 1) continue; // ...and that IN exactly one OUT
      const groupId = `bridge:${out.payload.chain_id}:${out.payload.tx_hash}`;
      try {
        // Per-pair isolation: a write failure on one pair leaves the other pairs (and a later repair
        // run of this pair) unaffected. A one-sided failure is healed on the next run.
        const outChanged = await this.applyLink(
          userId,
          out,
          groupId,
          OUT_CLASSIFICATION[kind],
          Number(inLeg.payload.chain_id),
        );
        const inChanged = await this.applyLink(userId, inLeg, groupId, IN_CLASSIFICATION[kind]);
        if (outChanged || inChanged) changed += 1;
      } catch (error) {
        this.logger.warn(`bridge link write failed for ${groupId}: ${(error as Error).message}`);
      }
    }
    return changed;
  }

  private isBridgeOutCandidate(leg: TransactionRecord): boolean {
    const p = leg.payload;
    // No bridge_group_id guard: candidacy is re-derived every run so an orphaned/reverted link heals.
    // The one exception is an `own:` key - that leg is a proven same-user wallet-to-wallet move
    // (own-wallet-linking.service.ts) and its pairing must not be stolen by a bridge guess.
    return (
      p.bridge_suspected === true &&
      p.direction === "OUT" &&
      p.user_override == null &&
      p.group_id == null &&
      !isOwnTransferGroup(p.bridge_group_id)
    );
  }

  private isLinkableIn(leg: TransactionRecord): boolean {
    const p = leg.payload;
    // classification-agnostic (a SPAM dest can be rescued), but never an own-wallet-linked leg.
    return p.user_override == null && p.group_id == null && !isOwnTransferGroup(p.bridge_group_id);
  }

  /** How this OUT/IN edge should be booked, or null when it is not a pair at all. */
  private pairKind(out: TransactionRecord, inLeg: TransactionRecord): LinkKind | null {
    const p = inLeg.payload;
    if (String(p.id) === String(out.payload.id)) return null;
    if (Number(p.chain_id) === Number(out.payload.chain_id)) return null; // a bridge crosses chains
    const kind = this.linkKind(out.payload, p);
    if (kind === null) return null;
    if (!this.withinWindow(out.occurredAt, inLeg.occurredAt)) return null;
    // One band for both kinds. The observed cross-asset case (17.26924 USDT -> 15.941987 USDC, 92.3%)
    // already sits inside it, and a stablecoin-to-stablecoin rate is ~1.0 by construction, so the
    // same-asset band is not loosened to admit it.
    if (!this.amountWithinFeeBand(out.payload, p)) return null;
    return kind;
  }

  /**
   * Asset relationship between the two legs, resolved through canonical contracts only.
   * Same canonical key -> a transfer. Two different canonical USD stablecoins -> a bridge that also
   * swapped. Anything else (unknown token, spoof, ETH-for-USDC) -> null, left for manual review.
   */
  private linkKind(out: Record<string, unknown>, inLeg: Record<string, unknown>): LinkKind | null {
    const keyOut = this.canonicalAssetKey(out);
    const keyIn = this.canonicalAssetKey(inLeg);
    if (keyOut === null || keyIn === null) return null;
    if (keyOut === keyIn) return "transfer";
    return USD_STABLE_KEYS.has(keyOut) && USD_STABLE_KEYS.has(keyIn) ? "swap" : null;
  }

  /**
   * Canonical asset identity. Returns null for anything not provably the same economic unit across a
   * bridge (NFTs, unknown/spoofed ERC20s), so those never auto-link. Symbol alone is NOT trusted:
   * a spoof token can claim any symbol, so an ERC20 must be a known canonical contract to resolve.
   */
  private canonicalAssetKey(payload: Record<string, unknown>): string | null {
    const type = payload.asset_type;
    const chainId = Number(payload.chain_id);
    if (type === "NATIVE") {
      const symbol = typeof payload.symbol === "string" ? payload.symbol.toUpperCase() : "";
      return symbol ? `native:${symbol}` : null; // native ETH -> native:ETH, native POL -> native:POL
    }
    if (type === "ERC20") {
      const contract = typeof payload.asset_contract === "string" ? payload.asset_contract.toLowerCase() : null;
      if (contract === null) return null;
      if (WETH_CONTRACTS[chainId] === contract) return "native:ETH"; // canonical WETH == native ETH
      const symbol = CANONICAL_ERC20[`${chainId}:${contract}`];
      if (symbol) return `token:${symbol}`;
    }
    return null;
  }

  private withinWindow(outAt: Date, inAt: Date): boolean {
    const delta = inAt.getTime() - outAt.getTime();
    return delta >= 0 && delta <= LINK_WINDOW_MS; // the IN must arrive at or after the OUT
  }

  private amountWithinFeeBand(out: Record<string, unknown>, inLeg: Record<string, unknown>): boolean {
    const outRaw = this.toBigInt(out.raw_amount);
    const inRaw = this.toBigInt(inLeg.raw_amount);
    if (outRaw === null || inRaw === null || outRaw <= 0n || inRaw < 0n) return false;
    const outDec = 10n ** BigInt(Math.max(0, Number(out.decimals) || 0));
    const inDec = 10n ** BigInt(Math.max(0, Number(inLeg.decimals) || 0));
    // inNorm/outNorm = (inRaw / 10^inDec) / (outRaw / 10^outDec) = (inRaw * 10^outDec) / (outRaw * 10^inDec).
    // Compare against the fee band with pure BigInt cross-multiplication (no float precision loss).
    const a = inRaw * outDec;
    const b = outRaw * inDec;
    return a * FEE_SCALE >= b * FEE_LOWER && a * FEE_SCALE <= b * FEE_UPPER;
  }

  private toBigInt(value: unknown): bigint | null {
    try {
      if (typeof value === "string" || typeof value === "number") return BigInt(value);
    } catch {
      /* unparseable amount -> not a candidate */
    }
    return null;
  }

  /** Apply the link to one leg. Returns true if the payload actually changed (idempotent no-op otherwise). */
  private async applyLink(
    userId: string,
    leg: TransactionRecord,
    groupId: string,
    classification: string,
    destChainId?: number,
  ): Promise<boolean> {
    const p = leg.payload;
    const alreadyLinked =
      p.classification === classification &&
      p.bridge_group_id === groupId &&
      p.confidence === LINK_CONFIDENCE &&
      (destChainId === undefined || p.bridge_dest_chain_id === destChainId);
    if (alreadyLinked) return false; // no write -> no churn, and repeat runs are true no-ops

    // Spread the existing payload so _anchorPayloadHash / _version / _overrideHistory survive
    // untouched (this is a system reclassification, not a user edit, and never re-anchors).
    const payload: Record<string, unknown> = {
      ...p,
      classification,
      confidence: LINK_CONFIDENCE,
      bridge_group_id: groupId,
      ...(destChainId !== undefined ? { bridge_dest_chain_id: destChainId } : {}),
    };
    await this.transactions.updatePayload(userId, String(p.id), payload);
    return true;
  }
}
