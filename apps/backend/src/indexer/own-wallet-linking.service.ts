import { Inject, Injectable, Logger } from "@nestjs/common";
import type { TransactionRecord } from "../shared/repository.types";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import { TRANSACTION_REPOSITORY } from "./indexer.tokens";
import type { TransactionRepository } from "./transaction.repository";

// Namespace for the pairing key this pass writes into `bridge_group_id`. Bridge linking writes
// `bridge:` keys and skips anything carrying an `own:` key, so the two passes never fight over a leg.
export const OWN_TRANSFER_GROUP_PREFIX = "own:";

/** True when a `bridge_group_id` was written by THIS pass (a same-chain wallet-to-wallet move). */
export function isOwnTransferGroup(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(OWN_TRANSFER_GROUP_PREFIX);
}

// Same confidence bridge linking uses for a confirmed pair: the FE's "needs review" floor is 0.5
// (lib/review.ts), and a move proven by the user's own binding list is not a guess.
const LINK_CONFIDENCE = 0.9;

const lower = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : null;

// Same shape as assetKeyOf() in the tax engine, so "same asset" means the same thing on both sides.
const assetKeyOf = (payload: Record<string, unknown>): string => {
  const assetType = String(payload.asset_type ?? "");
  const contract = assetType === "NATIVE" ? "native" : String(payload.asset_contract ?? "").toLowerCase();
  return `${assetType}:${contract}:${String(payload.token_id ?? "")}`;
};

/**
 * Same-user wallet-to-wallet linking over the user's OWN indexed data.
 *
 * A user with two bound wallets who moves funds between them produces two ledger rows for ONE
 * on-chain transfer: an OUT on the sending binding and an IN on the receiving binding, same chain
 * and same tx hash. Untouched they read as a taxable SEND plus a RECEIVE, so a self-move is taxed
 * as a disposal and re-acquired at market - the most expensive misclassification we can make.
 *
 * The proof here is stronger than the bridge heuristic and needs no amount/time window: the OUT's
 * counterparty IS another wallet the user proved ownership of (`wallet` module bindings). That fact
 * alone settles it, so a leg is classified even when the opposite leg is not in our DB (only one of
 * the two wallets indexed yet) - it just gets no pairing key, because there is no pair to key.
 *
 * Conservative, tax-safe matching:
 *  - both endpoints must be bound wallets OF THE SAME USER (an address the user merely claims proves
 *    nothing; only a binding does);
 *  - a `user_override` leg is never touched, and a swap-grouped leg (`group_id`) is left to the swap
 *    pass;
 *  - a pair must agree on chain, tx hash, transfer slot (log_index), asset and raw amount, with the
 *    two wallet addresses swapped. Anything ambiguous (a bucket that is not exactly one OUT and one
 *    IN) degrades to the one-sided treatment rather than guessing which leg pairs with which.
 *
 * Field choice - this reuses `bridge_group_id` with `bridge_dest_chain_id` left null:
 *  - the FE pairs INTERNAL_TRANSFER legs by `bridge_group_id` (lib/swap-pair.ts `pairBridgeLegs`)
 *    and only calls a row a bridge when `bridge_dest_chain_id` is set, so a null dest chain renders
 *    the merged row as "이동", not "브릿지" - exactly right for a same-chain move;
 *  - the tax engine reads the same pair (cost-basis.ts `bridgeGroupOf`) and moves cost from the OUT
 *    pool to the IN pool. For a same-chain, same-asset move that transfer is algebraically a no-op
 *    (the holding pool is keyed by chain+asset, not by wallet), so the key costs nothing there and
 *    buys the FE its single row.
 *
 * Deterministic + idempotent + self-healing: the group key is a pure function of the transfer
 * (chain, tx hash, slot), every link is re-derived from stable data on each run, and only a payload
 * that actually differs is written.
 */
@Injectable()
export class OwnWalletLinkingService {
  private readonly logger = new Logger(OwnWalletLinkingService.name);

  constructor(
    @Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepository,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
  ) {}

  /** Classify every own-wallet move for the user. Returns the number of legs written this run. */
  async linkForUser(userId: string): Promise<number> {
    const bound = new Set(
      (await this.wallets.findAllByUser(userId))
        .map((binding) => lower(binding.walletAddress))
        .filter((address): address is string => address !== null),
    );
    if (bound.size === 0) return 0;

    const all = await this.transactions.listForUser(userId);
    const legs = all.filter((leg) => this.isOwnMove(leg, bound));
    if (legs.length === 0) return 0;

    // Bucket by the transfer itself, not by leg: the key is symmetric in the two wallet addresses,
    // so the OUT row and the IN row of one on-chain transfer land in the same bucket.
    const buckets = new Map<string, TransactionRecord[]>();
    for (const leg of legs) {
      const key = this.transferKey(leg);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(leg);
      else buckets.set(key, [leg]);
    }

    let changed = 0;
    for (const bucket of buckets.values()) {
      const outs = bucket.filter((leg) => leg.payload.direction === "OUT");
      const ins = bucket.filter((leg) => leg.payload.direction === "IN");
      // Exactly one OUT and one IN (as two distinct stored rows) is a pair; anything else is
      // one-sided or ambiguous and gets classified without a pairing key.
      const paired = outs.length === 1 && ins.length === 1 && outs[0].id !== ins[0].id;
      const groupId = paired ? this.groupIdOf(outs[0]) : null;
      for (const leg of bucket) {
        try {
          // Per-leg isolation: one failed write leaves the others (and a repair run) unaffected.
          if (await this.apply(userId, leg, groupId)) changed += 1;
        } catch (error) {
          this.logger.warn(`own-wallet link write failed for ${leg.id}: ${(error as Error).message}`);
        }
      }
    }
    return changed;
  }

  /**
   * True when this leg is one side of a transfer between two wallets the SAME user has bound.
   *
   * `wallet_address === counterparty` is the adapter's `isSelf` shape (a wallet paying itself inside
   * a swap route); that is already handled at normalization and is not a two-wallet move.
   */
  private isOwnMove(leg: TransactionRecord, bound: ReadonlySet<string>): boolean {
    const p = leg.payload;
    if (p.user_override != null) return false; // a user edit is final
    if (p.group_id != null) return false; // a swap leg belongs to the swap pass
    if (p.direction !== "IN" && p.direction !== "OUT") return false;
    const wallet = lower(p.wallet_address);
    const counterparty = lower(p.counterparty);
    if (wallet === null || counterparty === null || wallet === counterparty) return false;
    return bound.has(wallet) && bound.has(counterparty);
  }

  /**
   * Symmetric identity of the underlying transfer. Both rows of one transfer produce the same
   * string: the wallet pair is sorted (the OUT sees A->B, the IN sees B<-A) and the slot pins the
   * exact transfer, so a transaction that moves two assets between the same two wallets still
   * yields two separate buckets.
   */
  private transferKey(leg: TransactionRecord): string {
    const p = leg.payload;
    const pair = [lower(p.wallet_address) ?? "", lower(p.counterparty) ?? ""].sort().join("~");
    return [
      String(p.chain_id ?? ""),
      String(p.tx_hash ?? ""),
      this.slotOf(p),
      assetKeyOf(p),
      String(p.raw_amount ?? ""),
      pair,
    ].join("|");
  }

  /**
   * The transfer's slot within its transaction. `log_index` is derived from the provider's
   * per-transfer uniqueId, so both rows of one transfer carry the same value; the asset key is the
   * fallback for a payload that never got one.
   */
  private slotOf(payload: Record<string, unknown>): string {
    const raw = Number(payload.log_index);
    return Number.isFinite(raw) ? String(raw) : assetKeyOf(payload);
  }

  private groupIdOf(leg: TransactionRecord): string {
    const p = leg.payload;
    return `${OWN_TRANSFER_GROUP_PREFIX}${String(p.chain_id ?? "")}:${String(p.tx_hash ?? "")}:${this.slotOf(p)}`;
  }

  /**
   * Apply the classification to one leg. `groupId` is null for a one-sided move (the counterparty
   * is provably the user's own wallet but its row is not in our DB, so there is nothing to pair).
   * Returns true if the payload actually changed.
   */
  private async apply(userId: string, leg: TransactionRecord, groupId: string | null): Promise<boolean> {
    const p = leg.payload;
    const settled =
      p.classification === "INTERNAL_TRANSFER" &&
      (p.bridge_group_id ?? null) === groupId &&
      (p.bridge_dest_chain_id ?? null) === null &&
      p.confidence === LINK_CONFIDENCE;
    if (settled) return false; // no write -> no churn, and repeat runs are true no-ops

    // Spread the existing payload so _anchorPayloadHash / _version / _overrideHistory survive
    // untouched (a system reclassification is not a user edit and never re-anchors).
    // bridge_dest_chain_id is written null on purpose: this move never leaves its chain, and a stale
    // value from an earlier (wrong) bridge link would make the FE label it "브릿지".
    const payload: Record<string, unknown> = {
      ...p,
      classification: "INTERNAL_TRANSFER",
      confidence: LINK_CONFIDENCE,
      bridge_group_id: groupId,
      bridge_dest_chain_id: null,
    };
    // Address the row by its STORAGE id, not payload.id: the provider's uniqueId is a property of
    // the transfer, not of the wallet that queried it, so both rows of a same-user move can carry
    // the SAME payload.id and a payload.id lookup would write one row twice.
    await this.transactions.updatePayload(userId, leg.id, payload);
    return true;
  }
}
