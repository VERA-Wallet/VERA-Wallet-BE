/**
 * Native-value recovery from BALANCE DIFFERENCES — the free-tier fallback behind native-trace.ts.
 *
 * WHY THIS EXISTS
 * native-trace.ts recovers the internal native movements the Transfers API omits on Arbitrum
 * (42161) and Optimism (10), but it does so through `debug_traceTransaction`, which the provider
 * gates behind a paid plan: on the live key the call is rejected with JSON-RPC -32600
 * "debug_traceTransaction is not available on the Free tier - upgrade to Pay As You Go, or
 * Enterprise for access." The trace path then degrades to "no native legs at all", so a USDC -> ETH
 * swap still shows only the USDC disposal and a later ETH send computes a cost basis of 0.
 *
 * Two reads that ARE served on the free tier reconstruct the same amount without any trace:
 * `eth_getTransactionReceipt` (block, fee, success) and `eth_getBalance` at the block before and
 * the block of the transaction. Everything that moved the wallet's native balance across that block
 * boundary, minus the parts already visible elsewhere (the fee it paid, the top-level value it sent
 * or received — that leg is the Transfers API's `external` category), IS the internal movement:
 *
 *     delta = balanceAfter - balanceBefore
 *     if the wallet SENT the transaction:      delta += feePaid + value
 *     if the wallet RECEIVED the top-level value: delta -= value
 *
 * Measured live on 2026-09-10 against the reported Arbitrum swap (tx 0xc88e2736…a240, wallet
 * 0xF8D0…EFAD): before 98883166198000 wei, after 6423512562504764 wei, fee 4708060206000 wei, value
 * 0 -> 6329337456512764 wei = 0.006329337456512764 ETH, which is what Koinly shows (0.00632934).
 *
 * WHAT IT CANNOT DO — read before widening its use
 *  - It is a NET number, not a list. A transaction that pays the wallet twice yields ONE leg, and
 *    one that both pays and takes yields only the difference. The trace path is strictly better and
 *    is always tried first (chain-registry.ts `nativeSources`).
 *  - It cannot attribute a block in which the wallet has MORE than one candidate transaction: the
 *    two balance snapshots straddle all of them. The caller drops such blocks rather than guess.
 *  - It cannot see a transaction the wallet has no visible leg in. Discovery is unchanged from the
 *    trace path, because a balance diff still needs a transaction hash to anchor on.
 *  - The sender's fee must be accounted for EXACTLY or the residue is mistaken for a movement.
 *    `feePaid` therefore sums `gasUsed * effectiveGasPrice` with the OP-stack surcharges the
 *    receipt reports separately (`l1Fee`, `operatorFee`); on Arbitrum Nitro the L1 cost is already
 *    folded into `gasUsed`, so no surcharge field appears and the sum is unchanged. A chain that
 *    charges a fee component reported in neither place must not be given this source.
 *
 * Pure by design: the RPC lives in the adapter, the value semantics live here.
 */

export interface ReceiptFacts {
  blockNumber: bigint;
  /** False when the transaction reverted: it moved nothing but the fee, so there is nothing to recover. */
  succeeded: boolean;
  gasUsed: bigint;
  /** Receipt-reported gas price; null when the node omits it (the transaction's own is the fallback). */
  effectiveGasPrice: bigint | null;
  /** Fees charged ON TOP of `gasUsed * gasPrice` (OP-stack `l1Fee` / `operatorFee`); 0n elsewhere. */
  surcharges: bigint;
}

export interface TransactionFacts {
  from: string;
  /** null on a contract-creation transaction. */
  to: string | null;
  value: bigint;
  /** Transaction-declared gas price; null on a type-2 transaction that declares only fee caps. */
  gasPrice: bigint | null;
}

export interface NativeDeltaInput {
  wallet: string;
  transaction: TransactionFacts;
  /** Total native the SENDER was charged for this transaction. Ignored when the wallet is not the sender. */
  feePaid: bigint;
  balanceBefore: bigint;
  balanceAfter: bigint;
}

/** The recovered movement: a direction and a base-unit magnitude, shaped like a trace leg's. */
export interface NativeDeltaLeg {
  direction: "IN" | "OUT";
  /** Base-unit (wei) magnitude as a canonical 0x-hex quantity. Always strictly positive. */
  hexValue: string;
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Parse a 0x-hex quantity. Returns null for anything that is not strict 0x-hex. */
export function parseHexQuantity(value: unknown): bigint | null {
  const raw = asString(value);
  if (raw === null || !/^0x[0-9a-fA-F]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

/** Optional 0x-hex quantity: absent (or null) reads as 0n, present-but-malformed as null. */
function optionalHexQuantity(value: unknown): bigint | null {
  if (value === undefined || value === null) return 0n;
  return parseHexQuantity(value);
}

/**
 * Read an `eth_getTransactionReceipt` result. Returns null for anything unusable — including a
 * `null` result, which means the node does not have the transaction we were just told exists and is
 * therefore an inconsistency, not an empty answer. The caller withholds the chain on null.
 *
 * `status` is required rather than defaulted: guessing "succeeded" on a receipt shaped differently
 * than expected would let a reverted transaction's fee be read as a movement.
 */
export function parseReceiptFacts(result: unknown): ReceiptFacts | null {
  if (!isRecord(result)) return null;
  const blockNumber = parseHexQuantity(result.blockNumber);
  const gasUsed = parseHexQuantity(result.gasUsed);
  const status = parseHexQuantity(result.status);
  if (blockNumber === null || gasUsed === null || status === null) return null;
  const effectiveGasPrice = result.effectiveGasPrice === undefined || result.effectiveGasPrice === null ? null : parseHexQuantity(result.effectiveGasPrice);
  if (result.effectiveGasPrice !== undefined && result.effectiveGasPrice !== null && effectiveGasPrice === null) return null;
  const l1Fee = optionalHexQuantity(result.l1Fee);
  const operatorFee = optionalHexQuantity(result.operatorFee);
  if (l1Fee === null || operatorFee === null) return null;
  return { blockNumber, succeeded: status === 1n, gasUsed, effectiveGasPrice, surcharges: l1Fee + operatorFee };
}

/** Read an `eth_getTransactionByHash` result. Returns null for anything unusable. */
export function parseTransactionFacts(result: unknown): TransactionFacts | null {
  if (!isRecord(result)) return null;
  const from = asString(result.from);
  const value = parseHexQuantity(result.value);
  if (from === null || value === null) return null;
  const to = result.to === undefined || result.to === null ? null : asString(result.to);
  if (result.to !== undefined && result.to !== null && to === null) return null;
  const gasPrice = result.gasPrice === undefined || result.gasPrice === null ? null : parseHexQuantity(result.gasPrice);
  return { from, to, value, gasPrice };
}

/**
 * Total native the sender was charged, or null when NEITHER the receipt nor the transaction reports
 * a gas price. Null is not zero: for a sender, an unknown fee is indistinguishable from a movement
 * of the same size, so the caller must drop the candidate rather than emit a leg made of gas.
 */
export function totalFeePaid(receipt: ReceiptFacts, transaction: TransactionFacts): bigint | null {
  const price = receipt.effectiveGasPrice ?? transaction.gasPrice;
  if (price === null) return null;
  return receipt.gasUsed * price + receipt.surcharges;
}

/**
 * The native movement attributable to internal calls, in base units. Positive means the wallet
 * received, negative means an internal call took native out of it, zero means the balance moved by
 * exactly the amounts we can already see.
 *
 * The two adjustments are exactly the two legs the Transfers API already returns for this
 * transaction, removed so they are not counted twice: the fee (never a transfer at all) and the
 * top-level `value`, which lands as the `external` category. A wallet that is both sender and
 * recipient (a self-send) has both applied and nets to zero, which is correct.
 */
export function internalNativeDelta({ wallet, transaction, feePaid, balanceBefore, balanceAfter }: NativeDeltaInput): bigint {
  const target = wallet.toLowerCase();
  const from = transaction.from.toLowerCase();
  const to = transaction.to?.toLowerCase() ?? null;
  let delta = balanceAfter - balanceBefore;
  if (from === target) delta += feePaid + transaction.value;
  if (to === target) delta -= transaction.value;
  return delta;
}

/**
 * Shape a delta into a leg, or null when there is nothing to emit. A zero delta MUST produce no leg:
 * it is the ordinary case (an approve, a plain token transfer) and emitting a zero-amount native row
 * for every one of them would bury the real movements.
 */
export function nativeLegFromDelta(delta: bigint): NativeDeltaLeg | null {
  if (delta === 0n) return null;
  const magnitude = delta > 0n ? delta : -delta;
  return { direction: delta > 0n ? "IN" : "OUT", hexValue: `0x${magnitude.toString(16)}` };
}

/**
 * Split candidates into the ones a balance diff can attribute and the blocks it cannot.
 *
 * Two balance snapshots one block apart cover EVERY transaction the wallet took part in inside that
 * block, so with more than one candidate there the delta belongs to the set, not to any member of
 * it. Splitting it would invent amounts; assigning it to one would misattribute the rest. Both
 * candidates are therefore dropped and the block is reported so the caller can say so once.
 *
 * Input order is preserved among the usable candidates, which keeps the emitted ids stable across a
 * re-sync.
 */
export function selectUnambiguousCandidates<T>(
  candidates: readonly T[],
  blockOf: (candidate: T) => bigint,
): { usable: T[]; ambiguousBlocks: bigint[] } {
  const byBlock = new Map<bigint, T[]>();
  for (const candidate of candidates) {
    const block = blockOf(candidate);
    const bucket = byBlock.get(block);
    if (bucket) bucket.push(candidate);
    else byBlock.set(block, [candidate]);
  }
  const usable: T[] = [];
  const ambiguousBlocks: bigint[] = [];
  for (const [block, bucket] of byBlock) {
    if (bucket.length === 1) usable.push(bucket[0]);
    else ambiguousBlocks.push(block);
  }
  return { usable, ambiguousBlocks };
}
