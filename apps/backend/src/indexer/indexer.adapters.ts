import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChainIndexer, ChainScanResult, IndexedTransaction } from "@vera/interfaces";
import { CHAIN_REGISTRY, SUPPORTED_CHAIN_IDS, type ChainRegistryEntry, type NativeValueSource } from "./chain-registry";
import { extractNativeTransfers, isTraceCapabilityError, unwrapTraceResult } from "./native-trace";
import {
  internalNativeDelta,
  nativeLegFromDelta,
  parseHexQuantity,
  parseReceiptFacts,
  parseTransactionFacts,
  selectUnambiguousCandidates,
  totalFeePaid,
  type ReceiptFacts,
} from "./native-balance-diff";
import { BRIDGE_REVIEW_CONFIDENCE, bridgeContractLabel, isBridgeContract } from "./bridge-registry";
import { CONTRACT_ALLOWLIST, SPAM_CONTRACT_DENYLIST, isInboundSpam, isNativeImpersonation, isWeaponizedSymbol, type SpamAssetType } from "./spam-filter";

const chains = SUPPORTED_CHAIN_IDS;

// Bounded per-chain fan-out. Alchemy's compute-unit budget is shared across every network host on one key,
// so a full 5-chain burst can trip 429s; three in flight keeps a zero-delta resync near one round-trip
// instead of five sequential ones (12.5s -> ~3s observed on 2026-09-08) while staying under the burst.
const CHAIN_CONCURRENCY = 3;
// Per-transaction `debug_traceTransaction` fan-out on chains that need native-value recovery
// (see native-trace.ts). A trace is far heavier than a transfers page, and it shares the same
// compute-unit budget as the five chain hosts, so it is kept to a small pool.
const TRACE_CONCURRENCY = 4;
// Per-transaction fan-out for the balance-diff native source (see native-balance-diff.ts). Each
// candidate costs FOUR round-trips (receipt, transaction, balance at block-1, balance at block)
// against one trace, so a smaller pool keeps roughly the same number of requests in flight.
const BALANCE_DIFF_CONCURRENCY = 3;
// How long a (chain, native source) pair stays marked "not available to this API key" before we
// probe again. Long enough that a Free-tier key is not hammered on every sync, short enough that a
// plan upgrade starts producing native legs the same day without a restart.
const NATIVE_SOURCE_REPROBE_MS = 6 * 60 * 60 * 1_000;
// 429 (rate limited) is retried with Retry-After or exponential backoff; other failures are chain-fatal as before.
const RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run `work` over `items` with at most `limit` in flight; results keep the input order. */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}
const classifications = ["RECEIVE", "SEND", "EXCHANGE", "INTERNAL_TRANSFER", "UNKNOWN"] as const;

// A detected swap is a strong signal (matched IN/OUT of distinct assets in one tx), so it sits
// above the FE review floor (CONFIDENCE_FLOOR = 0.5) with margin. Kept a hair above 0.5 so a
// small future adjustment can't silently drop both legs below the floor and break FE pairing.
const SWAP_CONFIDENCE = 0.6;

@Injectable()
export class MockAlchemyAdapter implements ChainIndexer {
  // Deterministic per-call-incrementing head so a manual resync advances cursors in the mock path.
  private syncCount = 0;
  async fetchTransactions(address: string, _sinceByChain?: Record<number, bigint>): Promise<ChainScanResult> {
    this.syncCount += 1;
    const transactions: IndexedTransaction[] = Array.from({ length: 25 }, (_, index) => {
      const n = index + 1;
      const classification = classifications[index % classifications.length];
      const unknownPrice = [3, 9, 17].includes(index);
      const assetType = (["NATIVE", "ERC20", "ERC721", "ERC1155"] as const)[index % 4];
      const direction = index % 2 === 0 ? "IN" : "OUT";
      const occurredAt = new Date(Date.UTC(2025, 0, 1 + index, 12));
      return {
        source: "mock" as const,
        txHash: `0x${n.toString(16).padStart(64, "0")}`,
        chain: String(chains[index % chains.length]),
        eventType: classification === "EXCHANGE" ? "swap" as const : direction === "IN" ? "transfer_in" as const : "transfer_out" as const,
        occurredAt,
        payload: {
          id: `event-${String(n).padStart(2, "0")}`, tx_hash: `0x${n.toString(16).padStart(64, "0")}`, chain_id: chains[index % chains.length], log_index: index,
          block_timestamp: occurredAt.toISOString(), wallet_address: address, direction, asset_type: assetType,
          asset_contract: assetType === "NATIVE" ? null : `0x${(1000 + index).toString(16).padStart(40, "0")}`,
          token_id: assetType === "ERC721" || assetType === "ERC1155" ? String(index + 100) : null,
          decimals: assetType === "ERC721" || assetType === "ERC1155" ? 0 : 18,
          raw_amount: assetType === "ERC721" || assetType === "ERC1155" ? String((index % 3) + 1) : `${n}${"0".repeat(16)}`,
          counterparty: `0x${(2000 + index).toString(16).padStart(40, "0")}`, gas_fee_native: "0.001", classification,
          confidence: [3, 9, 20].includes(index) ? 0.3 : 0.9, user_override: null,
          price_status: unknownPrice ? "UNKNOWN" : index % 3 === 0 ? "ESTIMATED" : "RESOLVED",
          fiat_value: unknownPrice ? null : `${n * 1000}.00`, fiat_currency: "KRW", symbol: assetType === "NATIVE" ? "ETH" : "TOKEN",
          _version: 1, _overrideHistory: [],
        },
      };
    });
    const chainHeads: Record<number, number> = {};
    for (const chainId of SUPPORTED_CHAIN_IDS) chainHeads[chainId] = 1000 + this.syncCount;
    return { transactions, chainHeads };
  }
}

// ---------------------------------------------------------------------------
// Real Alchemy adapter
// ---------------------------------------------------------------------------

const MAX_PAGES = 100;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type Direction = "IN" | "OUT";
type EventType = IndexedTransaction["eventType"];

// Signals that a chain could not be fully/consistently observed. Any such error
// makes the WHOLE chain incomplete (chain-atomic through normalization): the
// chain's rows are discarded and it is counted as skipped, exactly like a
// direction-call failure. This prevents persisting a provisional classification
// (e.g. transfer_in) that could later flip to swap under the frozen upsert key.
class ChainIncompleteError extends Error {}

/**
 * A native-value SOURCE is not available to this API key (plan tier, or the provider does not expose
 * the method on this network). Unlike ChainIncompleteError this is NOT a reason to withhold the
 * chain: the transfers-API legs are complete and correct on their own, and retrying will never help.
 * The adapter moves on to the chain's next `nativeSources` entry, and if none is left the chain is
 * normalized without recovered native legs and the degradation is logged once.
 */
class NativeSourceUnavailableError extends Error {}

interface AlchemyTransfer {
  uniqueId?: unknown;
  category?: unknown;
  from?: unknown;
  to?: unknown;
  asset?: unknown;
  hash?: unknown;
  rawContract?: { value?: unknown; address?: unknown; decimal?: unknown } | null;
  tokenId?: unknown;
  erc721TokenId?: unknown;
  erc1155Metadata?: Array<{ tokenId?: unknown; value?: unknown }> | null;
  metadata?: { blockTimestamp?: unknown } | null;
  /**
   * Set only on legs this adapter synthesized, naming the `nativeSources` entry that produced them,
   * so a traced movement and an inferred net can be told apart downstream. Carried through to
   * `payload.native_source`; the FE contract (normalized-event.ts) strips it rather than rejecting
   * it, exactly like bridge_suspected.
   */
  nativeSource?: unknown;
}

interface NormalizedLeg {
  pureHash: string;
  storageTxHash: string;
  occurredAt: Date;
  direction: Direction;
  isSelf: boolean;
  assetKey: string;
  payload: Record<string, unknown>;
}

// One collapsed side of a detected swap. `netting` is present only when a same-asset residual on the
// OTHER side was absorbed into this one: it carries the replacement base-unit amount and the ids of
// the legs it swallowed, so the dropped legs stay traceable instead of vanishing from provenance.
interface SwapSide {
  legs: NormalizedLeg[];
  netting?: { amount: string; absorbedIds: string[] };
}

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

function parseRawAmount(value: unknown): string {
  const raw = asString(value);
  if (raw === null || raw.trim() === "") throw new ChainIncompleteError("transfer amount missing");
  try {
    return BigInt(raw).toString();
  } catch {
    throw new ChainIncompleteError("transfer amount unparseable");
  }
}

function normalizeTokenId(value: unknown): string | null {
  const raw = asString(value);
  if (raw === null || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("0x")) {
    try {
      return BigInt(trimmed).toString();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

@Injectable()
export class AlchemyAdapter implements ChainIndexer {
  private readonly logger = new Logger(AlchemyAdapter.name);
  // `${network}:${source}` -> epoch ms until which that native source is treated as unavailable.
  // Bounded by the registry's chain count times its source count, so it cannot grow; entries expire
  // after NATIVE_SOURCE_REPROBE_MS. Keyed per SOURCE because a key that cannot trace can still read
  // balances: blocking the chain wholesale would throw away the fallback that does work.
  private readonly nativeSourceBlockedUntil = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  async fetchTransactions(address: string, sinceByChain?: Record<number, bigint>): Promise<ChainScanResult> {
    const apiKey = this.config.get<string>("ALCHEMY_API_KEY");
    if (!apiKey) throw new ServiceUnavailableException("Alchemy real adapter requires ALCHEMY_API_KEY.");

    const wallet = address.toLowerCase();
    const results: IndexedTransaction[] = [];
    const chainHeads: Record<number, number> = {};
    let skippedChains = 0;

    // Bounded parallel per-chain fan-out (see CHAIN_CONCURRENCY). Each chain is still scanned
    // head -> inbound -> outbound in order, so the IN/OUT head-drift guarantee is unchanged.
    // Outcomes are collected in registry order so callers see the same ordering as before.
    type ChainOutcome = { entry: ChainRegistryEntry; head: number; transactions: IndexedTransaction[] } | { entry: ChainRegistryEntry; error: Error };
    const outcomes = await mapWithConcurrency<ChainRegistryEntry, ChainOutcome>(CHAIN_REGISTRY, CHAIN_CONCURRENCY, async (entry) => {
      try {
        const url = `https://${entry.network}.g.alchemy.com/v2/${apiKey}`;
        // Snapshot ONE head before both directions and pass the same toBlock to each,
        // so a later direction can never advance past a block an earlier direction did
        // not scan (fixes IN/OUT head drift). Cursor advances only to this proven horizon.
        const head = await this.fetchChainHead(entry, url);
        const toBlock = `0x${head.toString(16)}`;
        const since = sinceByChain?.[entry.chainId];
        const fromBlock = since !== undefined ? `0x${since.toString(16)}` : undefined;

        // Independent direction calls (separate diagnostics). Either throwing, OR
        // any normalization skip inside normalizeChain, withholds the whole chain.
        const inbound = await this.fetchDirection(entry, url, { toAddress: address }, fromBlock, toBlock);
        const outbound = await this.fetchDirection(entry, url, { fromAddress: address }, fromBlock, toBlock);
        // Chains without Alchemy's `internal` category recover native-value legs by tracing the
        // transactions the two direction calls already proved the wallet took part in. A trace
        // failure throws, so it lands in this same catch and withholds the WHOLE chain — never a
        // silent half-observation that would persist a swap as a bare SEND.
        const traced = await this.recoverNativeLegs(entry, url, wallet, [...inbound, ...outbound], fromBlock !== undefined);
        return { entry, head, transactions: this.normalizeChain(entry, address, wallet, inbound, outbound, traced) };
      } catch (error) {
        return { entry, error: error as Error };
      }
    });
    for (const outcome of outcomes) {
      if ("error" in outcome) {
        skippedChains += 1;
        this.logger.warn(`Skipping chain ${outcome.entry.chainId} (${outcome.entry.network}): ${outcome.error.message}`);
        continue;
      }
      results.push(...outcome.transactions);
      // Complete observation: record the scanned head even when zero transfers returned.
      chainHeads[outcome.entry.chainId] = outcome.head;
    }

    // Truthful empty/outage boundary: a result requires at least one completely-observed
    // chain. No chainHeads at all means total outage -> throw (never a trustworthy empty).
    if (Object.keys(chainHeads).length === 0) {
      throw new ServiceUnavailableException(`Alchemy sync observed no chain; ${skippedChains} chain(s) unavailable.`);
    }
    if (skippedChains > 0) {
      this.logger.warn(`Alchemy sync partial: ${Object.keys(chainHeads).length} complete chain(s), ${skippedChains} skipped.`);
    }
    return { transactions: results, chainHeads };
  }

  /**
   * One JSON-RPC POST with rate-limit retry. 429 is the only status retried: it is Alchemy telling us to slow
   * down, not a broken chain. Retry-After (seconds) wins when present; otherwise exponential backoff from
   * ALCHEMY_RETRY_BASE_MS (default 500ms). Anything else is returned as-is for the caller's chain-fatal handling.
   */
  private async rpcPost(url: string, body: Record<string, unknown>): Promise<Response> {
    const configured = Number(this.config.get<string>("ALCHEMY_RETRY_BASE_MS"));
    const baseDelay = Number.isFinite(configured) && configured >= 0 && this.config.get<string>("ALCHEMY_RETRY_BASE_MS") !== undefined ? configured : DEFAULT_RETRY_BASE_MS;
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (response.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return response;
      const retryAfter = Number(response.headers?.get?.("retry-after"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : baseDelay * 2 ** attempt;
      this.logger.warn(`Alchemy rate limited (429); retry ${attempt + 1}/${RATE_LIMIT_RETRIES} in ${delay}ms`);
      await sleep(delay);
    }
  }

  // Snapshot the chain head once via eth_blockNumber; validate as a safe non-negative integer.
  private async fetchChainHead(entry: ChainRegistryEntry, url: string): Promise<number> {
    const response = await this.rpcPost(url, { id: 1, jsonrpc: "2.0", method: "eth_blockNumber", params: [] });
    if (!response.ok) throw new Error(`${entry.network} head HTTP ${response.status}`);
    const body = (await response.json()) as { error?: { message?: string }; result?: unknown };
    if (body?.error) throw new Error(`${entry.network} head RPC error: ${body.error.message ?? "unknown"}`);
    // Require strict 0x-hex quantity syntax: a decimal or trailing-junk string must NOT be accepted
    // (parseInt would silently coerce it and advance the cursor over an unobserved range).
    const raw = typeof body.result === "string" ? body.result : "";
    if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`${entry.network} malformed head ${String(body.result)}`);
    const head = Number.parseInt(raw, 16);
    if (!Number.isSafeInteger(head) || head < 0) throw new Error(`${entry.network} unsafe head ${raw}`);
    return head;
  }

  private async fetchDirection(
    entry: ChainRegistryEntry,
    url: string,
    selector: { toAddress?: string; fromAddress?: string },
    fromBlock: string | undefined,
    toBlock: string,
  ): Promise<AlchemyTransfer[]> {
    const collected: AlchemyTransfer[] = [];
    const seenPageKeys = new Set<string>();
    let pageKey: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, unknown> = {
        ...selector,
        category: entry.supportedCategories,
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: "0x3e8",
        order: "asc",
        toBlock,
        ...(fromBlock ? { fromBlock } : {}),
      };
      if (pageKey) params.pageKey = pageKey;

      const response = await this.rpcPost(url, { id: 1, jsonrpc: "2.0", method: "alchemy_getAssetTransfers", params: [params] });
      if (!response.ok) throw new Error(`${entry.network} HTTP ${response.status}`);

      const body = (await response.json()) as { error?: { message?: string }; result?: unknown };
      if (body?.error) throw new Error(`${entry.network} RPC error: ${body.error.message ?? "unknown"}`);

      // Strict shape validation: a malformed 2xx body must fail the direction
      // (chain-fatal), never be downgraded to a "complete empty" observation.
      const result = body?.result;
      if (typeof result !== "object" || result === null) throw new Error(`${entry.network} malformed response: missing result`);
      const { transfers, pageKey: nextPageKey } = result as { transfers?: unknown; pageKey?: unknown };
      if (!Array.isArray(transfers)) throw new Error(`${entry.network} malformed response: transfers not an array`);
      collected.push(...(transfers as AlchemyTransfer[]));

      if (nextPageKey === undefined || nextPageKey === null || nextPageKey === "") return collected; // terminal page
      if (typeof nextPageKey !== "string") throw new Error(`${entry.network} malformed response: non-string pageKey`);
      // A repeated pageKey is NOT proof the window is complete -> mark the chain incomplete (hold cursor).
      if (seenPageKeys.has(nextPageKey)) throw new Error(`${entry.network} repeated pageKey (incomplete)`);
      seenPageKeys.add(nextPageKey);
      pageKey = nextPageKey;
    }
    // Ran MAX_PAGES without natural termination: treat as truncation, not success.
    throw new Error(`${entry.network} pagination exceeded ${MAX_PAGES} pages (truncated)`);
  }

  /**
   * Recover native-ETH movements the Transfers API cannot see on this chain.
   *
   * Discovery (shared by every source): a recovery can only be requested for a transaction hash we
   * already know, so the candidate set is the transactions in which the wallet ALREADY has an
   * observed leg and a contract was necessarily involved — any token leg (erc20/erc721/erc1155), or
   * a wallet-initiated `external` transaction. A plain inbound `external` transfer is excluded: its
   * transaction is a bare value send whose only movement is the top-level one, already collected.
   *
   * Sources are tried in the registry's order and the FIRST one that answers wins, even when it
   * recovers nothing — an available trace saying "no internal transfers" is the truth, not a reason
   * to go re-derive a net from balances. A source steps aside only when the provider tells us the
   * method is not available to this key; every other failure throws and withholds the chain, so a
   * transient trace error never silently falls through to the weaker source.
   */
  private async recoverNativeLegs(
    entry: ChainRegistryEntry,
    url: string,
    wallet: string,
    observed: AlchemyTransfer[],
    incremental: boolean,
  ): Promise<AlchemyTransfer[]> {
    if (entry.nativeSources.length === 0) return [];
    const candidates = this.nativeCandidates(wallet, observed);
    if (candidates.size === 0) return [];

    for (const source of entry.nativeSources) {
      if (this.isSourceUnavailable(entry, source)) continue;
      const legs =
        source === "alchemy-debug"
          ? await this.fetchNativeTraceLegs(entry, url, wallet, candidates, incremental)
          : await this.fetchBalanceDiffLegs(entry, url, wallet, candidates, incremental);
      if (legs !== null) return legs;
    }
    return [];
  }

  /**
   * txHash -> blockTimestamp for every transaction worth a native-recovery round-trip. The timestamp
   * is borrowed from the observed leg of the same transaction, so a recovered leg never needs an
   * extra eth_getBlockByNumber.
   */
  private nativeCandidates(wallet: string, observed: AlchemyTransfer[]): Map<string, string> {
    const candidates = new Map<string, string>();
    for (const transfer of observed) {
      const category = asString(transfer.category);
      const isTokenLeg = category === "erc20" || category === "erc721" || category === "erc1155";
      const isWalletInitiated = category === "external" && asString(transfer.from)?.toLowerCase() === wallet;
      if (!isTokenLeg && !isWalletInitiated) continue;
      const hash = asString(transfer.hash)?.trim().toLowerCase() ?? "";
      // The RPCs below take a canonical 32-byte hash; a malformed one is left to normalizeTransfer,
      // which fails the chain on it anyway.
      if (!/^0x[0-9a-f]{64}$/.test(hash)) continue;
      const timestamp = asString(transfer.metadata?.blockTimestamp);
      if (timestamp === null || Number.isNaN(Date.parse(timestamp))) continue;
      if (!candidates.has(hash)) candidates.set(hash, timestamp);
    }
    return candidates;
  }

  /**
   * The `"alchemy-debug"` source: one `debug_traceTransaction` per candidate, TRACE_CONCURRENCY in
   * flight, reusing rpcPost's 429 retry/backoff. Incremental syncs pass a fromBlock, so steady state
   * traces only new activity.
   *
   * Returns null when the provider says the trace method is not available to us — the pair is
   * remembered as blocked for NATIVE_SOURCE_REPROBE_MS and the caller falls through to the next
   * source. Every other failure throws and withholds the chain.
   */
  private async fetchNativeTraceLegs(
    entry: ChainRegistryEntry,
    url: string,
    wallet: string,
    candidates: ReadonlyMap<string, string>,
    incremental: boolean,
  ): Promise<AlchemyTransfer[] | null> {
    this.logger.debug(`${entry.network}: tracing ${candidates.size} ${incremental ? "new" : "historical"} tx(s) for native legs`);
    // Held in an object so the closure's write is visible to the checks around it.
    const blocked: { message: string | null } = { message: null };
    const perTransaction = await mapWithConcurrency([...candidates], TRACE_CONCURRENCY, async ([hash, timestamp]) => {
      // A capability failure applies to the whole chain, so the remaining candidates are skipped
      // rather than each re-learning the same thing at one wasted request apiece.
      if (blocked.message !== null) return [];
      let root: unknown;
      try {
        root = await this.fetchCallTrace(entry, url, hash);
      } catch (error) {
        if (!(error instanceof NativeSourceUnavailableError)) throw error; // transient -> chain withheld
        blocked.message = error.message;
        return [];
      }
      return extractNativeTransfers(root, wallet).map<AlchemyTransfer>((movement) => ({
        // Mirrors Alchemy's own `${hash}:internal:${n}` uniqueId shape, so the storage key stays
        // `${chainId}:${txHash}:internal:${n}`. `n` is the frame path, a pure function of the trace
        // tree, which makes a re-sync of the same transaction reproduce identical ids (idempotent
        // under the frozen (bindingId, txHash, eventType) upsert key) and keeps several native legs
        // of ONE transaction distinct from each other.
        uniqueId: `${hash}:internal:${movement.path}`,
        category: "internal",
        from: movement.from,
        to: movement.to,
        asset: entry.nativeSymbol,
        hash,
        rawContract: { value: movement.hexValue, address: null, decimal: null },
        metadata: { blockTimestamp: timestamp },
      }));
    });
    if (blocked.message !== null) {
      // Drop whatever did come back: a chain half-covered by traces would classify two identical
      // swaps differently depending on which request won the race. All-or-nothing is predictable.
      this.markSourceUnavailable(entry, "alchemy-debug", blocked.message);
      return null;
    }
    return perTransaction.flat();
  }

  /**
   * The `"balance-diff"` source: reconstruct each candidate's internal native movement from the
   * wallet's balance either side of its block (see native-balance-diff.ts for the arithmetic and its
   * limits).
   *
   * Two passes, so the cheap disqualifiers run before the expensive reads. Pass one takes the
   * receipt of every candidate (one RPC each) and drops the reverted ones; the survivors are grouped
   * by block and any block holding more than one candidate is dropped whole, because two balance
   * snapshots cannot say which of them moved what. Pass two spends three more RPCs on each remaining
   * candidate — the transaction, and the balance at `block - 1` and at `block`.
   *
   * Cost: FOUR RPCs per candidate that survives pass one, BALANCE_DIFF_CONCURRENCY in flight,
   * reusing rpcPost's 429 retry/backoff. Incremental syncs pass a fromBlock, so steady state reads
   * only new activity.
   *
   * Returns null when the provider says one of those reads is not available to us; any other failure
   * raises ChainIncompleteError and withholds the chain, exactly like a failed transfers page.
   */
  private async fetchBalanceDiffLegs(
    entry: ChainRegistryEntry,
    url: string,
    wallet: string,
    candidates: ReadonlyMap<string, string>,
    incremental: boolean,
  ): Promise<AlchemyTransfer[] | null> {
    this.logger.debug(
      `${entry.network}: balance-diffing ${candidates.size} ${incremental ? "new" : "historical"} tx(s) for native legs`,
    );
    try {
      const withReceipts = await mapWithConcurrency([...candidates], BALANCE_DIFF_CONCURRENCY, async ([hash, timestamp]) => {
        const receipt = parseReceiptFacts(await this.nativeRpcRead(entry, url, "eth_getTransactionReceipt", [hash]));
        // A null or unreadable receipt for a transaction the Transfers API just reported is an
        // inconsistency, not an empty answer: hold the chain rather than infer from half of it.
        if (receipt === null) throw new ChainIncompleteError(`${entry.network} unusable receipt for ${hash}`);
        return { hash, timestamp, receipt };
      });

      // A reverted transaction rolled back every state change; only its fee moved.
      const succeeded = withReceipts.filter((candidate) => candidate.receipt.succeeded);
      const { usable, ambiguousBlocks } = selectUnambiguousCandidates(succeeded, (candidate) => candidate.receipt.blockNumber);
      if (ambiguousBlocks.length > 0) {
        this.logger.debug(
          `${entry.network}: balance-diff skipped ${ambiguousBlocks.length} block(s) holding several candidate tx(s) for this wallet (attribution ambiguous)`,
        );
      }

      const legs = await mapWithConcurrency(usable, BALANCE_DIFF_CONCURRENCY, async (candidate) =>
        this.recoverBalanceDiffLeg(entry, url, wallet, candidate),
      );
      return legs.filter((leg): leg is AlchemyTransfer => leg !== null);
    } catch (error) {
      if (!(error instanceof NativeSourceUnavailableError)) throw error; // transient -> chain withheld
      this.markSourceUnavailable(entry, "balance-diff", error.message);
      return null;
    }
  }

  /** One candidate's net internal native movement, or null when there is nothing to emit. */
  private async recoverBalanceDiffLeg(
    entry: ChainRegistryEntry,
    url: string,
    wallet: string,
    candidate: { hash: string; timestamp: string; receipt: ReceiptFacts },
  ): Promise<AlchemyTransfer | null> {
    const { hash, timestamp, receipt } = candidate;
    // Genesis has no predecessor block to compare against; no candidate can live there anyway.
    if (receipt.blockNumber === 0n) return null;

    const transaction = parseTransactionFacts(await this.nativeRpcRead(entry, url, "eth_getTransactionByHash", [hash]));
    if (transaction === null) throw new ChainIncompleteError(`${entry.network} unusable transaction ${hash}`);

    const feePaid = totalFeePaid(receipt, transaction);
    if (feePaid === null && transaction.from.toLowerCase() === wallet) {
      // No gas price from either side: for a SENDER the unaccounted fee is indistinguishable from a
      // movement of the same size, and a leg made of gas is worse than a missing leg.
      this.logger.debug(`${entry.network}: balance-diff skipped ${hash} (no gas price reported for a wallet-sent tx)`);
      return null;
    }

    const [balanceBefore, balanceAfter] = await Promise.all([
      this.fetchNativeBalance(entry, url, wallet, receipt.blockNumber - 1n),
      this.fetchNativeBalance(entry, url, wallet, receipt.blockNumber),
    ]);
    const leg = nativeLegFromDelta(
      internalNativeDelta({ wallet, transaction, feePaid: feePaid ?? 0n, balanceBefore, balanceAfter }),
    );
    if (leg === null) return null;

    // The counterparty of an inferred movement is the contract the wallet transacted with: the diff
    // knows the net, never which inner address paid it. `to === null` (contract creation) and
    // `to === wallet` (the wallet is its own top-level recipient) leave no usable address, and the
    // zero-address sentinel says "unknown" rather than naming the wallet on both sides, which
    // normalizeTransfer would read as a self-transfer.
    const contract = transaction.to;
    const counterparty = contract === null || contract.toLowerCase() === wallet ? ZERO_ADDRESS : contract;

    return {
      // ONE synthetic leg per transaction: the diff yields a net, not a list, so the index is a
      // constant rather than a movement number. Deterministic like the trace path's frame path, so a
      // re-sync reproduces the identical storage key `${chainId}:${txHash}:balance:0`, which cannot
      // collide with a Transfers API uniqueId nor with a `:internal:` id from the trace path.
      uniqueId: `${hash}:balance:0`,
      category: "internal",
      from: leg.direction === "IN" ? counterparty : wallet,
      to: leg.direction === "IN" ? wallet : counterparty,
      asset: entry.nativeSymbol,
      hash,
      rawContract: { value: leg.hexValue, address: null, decimal: null },
      metadata: { blockTimestamp: timestamp },
      nativeSource: "balance-diff",
    };
  }

  /** The wallet's native balance at one block, in base units. */
  private async fetchNativeBalance(entry: ChainRegistryEntry, url: string, wallet: string, block: bigint): Promise<bigint> {
    const raw = await this.nativeRpcRead(entry, url, "eth_getBalance", [wallet, `0x${block.toString(16)}`]);
    const balance = parseHexQuantity(raw);
    if (balance === null) throw new ChainIncompleteError(`${entry.network} malformed balance at block ${block}`);
    return balance;
  }

  /**
   * One plain `eth_*` read for the balance-diff source, with the same capability-vs-transient split
   * as fetchCallTrace: a gated method or a gated archive depth steps the source aside, anything else
   * withholds the chain. The body is read even on a non-2xx response because the live tier rejection
   * arrives as HTTP 400 carrying the JSON-RPC error.
   */
  private async nativeRpcRead(entry: ChainRegistryEntry, url: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await this.rpcPost(url, { id: 1, jsonrpc: "2.0", method, params });
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown }; result?: unknown } | null;
    const rpcError = body?.error;
    if (rpcError && isTraceCapabilityError(rpcError.code, rpcError.message)) {
      throw new NativeSourceUnavailableError(asString(rpcError.message) ?? `code ${String(rpcError.code)}`);
    }
    if (!response.ok) throw new ChainIncompleteError(`${entry.network} ${method} HTTP ${response.status}`);
    if (rpcError) throw new ChainIncompleteError(`${entry.network} ${method} RPC error: ${asString(rpcError.message) ?? "unknown"}`);
    return body?.result;
  }

  /** True while this (network, source) pair is known not to serve us (expired entries self-clear). */
  private isSourceUnavailable(entry: ChainRegistryEntry, source: NativeValueSource): boolean {
    const key = `${entry.network}:${source}`;
    const until = this.nativeSourceBlockedUntil.get(key);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.nativeSourceBlockedUntil.delete(key);
      return false;
    }
    return true;
  }

  /** Record the degradation and say so ONCE per (chain, source) per re-probe window. */
  private markSourceUnavailable(entry: ChainRegistryEntry, source: NativeValueSource, message: string): void {
    this.nativeSourceBlockedUntil.set(`${entry.network}:${source}`, Date.now() + NATIVE_SOURCE_REPROBE_MS);
    this.logger.warn(
      source === "alchemy-debug"
        ? `native tracing unavailable on ${entry.network}: ${message} — falling back to this chain's remaining native source, if any`
        : `native balance-diff unavailable on ${entry.network}: ${message} — continuing without internal native legs; swaps paying native ETH will show only the token leg`,
    );
  }

  /**
   * One callTracer trace.
   *
   * A capability rejection (the method is gated or absent) raises NativeSourceUnavailableError, which the
   * caller degrades on. Everything else — HTTP 5xx, a network error, any other JSON-RPC code — is a
   * ChainIncompleteError so the chain is held rather than half-observed. The body is read even on a
   * non-2xx response because the live tier rejection arrives as HTTP 400 carrying the JSON-RPC error.
   */
  private async fetchCallTrace(entry: ChainRegistryEntry, url: string, txHash: string): Promise<unknown> {
    const response = await this.rpcPost(url, {
      id: 1,
      jsonrpc: "2.0",
      method: "debug_traceTransaction",
      params: [txHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }],
    });
    const body = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown }; result?: unknown } | null;
    const rpcError = body?.error;
    if (rpcError && isTraceCapabilityError(rpcError.code, rpcError.message)) {
      throw new NativeSourceUnavailableError(asString(rpcError.message) ?? `code ${String(rpcError.code)}`);
    }
    if (!response.ok) throw new ChainIncompleteError(`${entry.network} trace HTTP ${response.status} for ${txHash}`);
    if (rpcError) throw new ChainIncompleteError(`${entry.network} trace RPC error for ${txHash}: ${asString(rpcError.message) ?? "unknown"}`);
    const root = unwrapTraceResult(body?.result);
    if (root === null) throw new ChainIncompleteError(`${entry.network} malformed trace for ${txHash}`);
    return root;
  }

  private normalizeChain(
    entry: ChainRegistryEntry,
    address: string,
    wallet: string,
    inbound: AlchemyTransfer[],
    outbound: AlchemyTransfer[],
    traced: AlchemyTransfer[] = [],
  ): IndexedTransaction[] {
    // Merge + dedupe by chain-scoped uniqueId (a self-transfer appears in both
    // direction responses with the same uniqueId). Trace-recovered legs carry their own
    // synthetic uniqueId and cannot collide with a Transfers API one.
    const byUniqueId = new Map<string, AlchemyTransfer>();
    for (const transfer of [...inbound, ...outbound, ...traced]) {
      const uniqueId = asString(transfer.uniqueId)?.trim() ?? "";
      if (uniqueId === "") throw new ChainIncompleteError("transfer missing uniqueId");
      if (!byUniqueId.has(uniqueId)) byUniqueId.set(uniqueId, transfer);
    }

    const legs: NormalizedLeg[] = [];
    for (const [uniqueId, transfer] of byUniqueId) {
      legs.push(...this.normalizeTransfer(entry, address, wallet, uniqueId, transfer));
    }

    // Classification is per (chain, pureHash) group.
    const groups = new Map<string, NormalizedLeg[]>();
    for (const leg of legs) {
      const bucket = groups.get(leg.pureHash);
      if (bucket) bucket.push(leg);
      else groups.set(leg.pureHash, [leg]);
    }

    const output: IndexedTransaction[] = [];
    for (const group of groups.values()) output.push(...this.classifyGroup(entry, group));
    return output;
  }

  private normalizeTransfer(
    entry: ChainRegistryEntry,
    address: string,
    wallet: string,
    uniqueId: string,
    transfer: AlchemyTransfer,
  ): NormalizedLeg[] {
    const rawHash = asString(transfer.hash);
    const pureHash = rawHash ? rawHash.trim().toLowerCase() : "";
    if (pureHash === "") throw new ChainIncompleteError("transfer missing hash");

    const timestamp = asString(transfer.metadata?.blockTimestamp);
    if (timestamp === null || Number.isNaN(Date.parse(timestamp))) {
      throw new ChainIncompleteError("transfer missing/invalid blockTimestamp");
    }
    const occurredAt = new Date(timestamp);

    const from = asString(transfer.from)?.toLowerCase() ?? null;
    const to = asString(transfer.to)?.toLowerCase() ?? null;
    let direction: Direction;
    let isSelf = false;
    if (from === wallet && to === wallet) {
      direction = "OUT";
      isSelf = true;
    } else if (to === wallet) {
      direction = "IN";
    } else if (from === wallet) {
      direction = "OUT";
    } else {
      throw new ChainIncompleteError("transfer matches neither wallet side");
    }

    const category = asString(transfer.category);
    if (category !== "external" && category !== "internal" && category !== "erc20" && category !== "erc721" && category !== "erc1155") {
      throw new ChainIncompleteError("transfer has unknown category");
    }
    const assetType =
      category === "erc20" ? "ERC20" : category === "erc721" ? "ERC721" : category === "erc1155" ? "ERC1155" : "NATIVE";

    const contractAddress = asString(transfer.rawContract?.address);
    if (assetType !== "NATIVE" && (contractAddress === null || contractAddress.trim() === "")) {
      throw new ChainIncompleteError("token transfer missing rawContract.address");
    }
    const assetContract = assetType === "NATIVE" ? null : contractAddress;

    let decimals: number;
    if (assetType === "NATIVE") {
      decimals = entry.nativeDecimals;
    } else if (assetType === "ERC20") {
      const rawDecimal = asString(transfer.rawContract?.decimal);
      const parsed = rawDecimal ? Number.parseInt(rawDecimal, 16) : Number.NaN;
      decimals = Number.isFinite(parsed) ? parsed : 18;
    } else {
      decimals = 0;
    }

    const counterpartyRaw = direction === "IN" ? asString(transfer.from) : asString(transfer.to);
    const counterparty = counterpartyRaw ?? ZERO_ADDRESS; // contract-creation to:null sentinel

    const logIndex = this.deriveLogIndex(uniqueId);
    const symbol =
      assetType === "NATIVE"
        ? asString(transfer.asset) ?? entry.nativeSymbol
        : asString(transfer.asset) ?? "UNKNOWN";
    const nativeSource = asString(transfer.nativeSource);

    // payload.id is derived from the UNIQUE storage key (chain-scoped uniqueId),
    // guaranteeing uniqueness across the returned set even when two non-log
    // transfers of the same tx would hash to the same numeric log_index.
    const makeLeg = (storageTxHash: string, rawAmount: string, tokenId: string | null): NormalizedLeg => {
      const assetKey = `${entry.chainId}:${assetType}:${assetType === "NATIVE" ? "native" : (assetContract ?? "").toLowerCase()}:${tokenId ?? ""}`;
      return {
        pureHash,
        storageTxHash,
        occurredAt,
        direction,
        isSelf,
        assetKey,
        payload: {
          id: storageTxHash,
          tx_hash: pureHash,
          chain_id: entry.chainId,
          log_index: logIndex,
          block_timestamp: occurredAt.toISOString(),
          wallet_address: address,
          direction,
          asset_type: assetType,
          asset_contract: assetContract,
          token_id: tokenId,
          decimals,
          raw_amount: rawAmount,
          counterparty,
          gas_fee_native: "0",
          classification: "UNKNOWN",
          confidence: 0,
          user_override: null,
          price_status: "UNKNOWN",
          fiat_value: null,
          fiat_currency: "KRW",
          symbol,
          // Names the recovery source of a synthesized native leg (see AlchemyTransfer.nativeSource);
          // absent on every leg the Transfers API returned.
          ...(nativeSource === null ? {} : { native_source: nativeSource }),
          _version: 1,
          _overrideHistory: [],
        },
      };
    };

    if (assetType === "ERC1155") {
      const items = Array.isArray(transfer.erc1155Metadata) ? transfer.erc1155Metadata : [];
      if (items.length === 0) throw new ChainIncompleteError("erc1155 transfer missing metadata");
      return items.map((item, index) =>
        makeLeg(`${entry.chainId}:${uniqueId}:${index}`, parseRawAmount(item?.value), normalizeTokenId(item?.tokenId)),
      );
    }

    if (assetType === "ERC721") {
      return [makeLeg(`${entry.chainId}:${uniqueId}`, "1", normalizeTokenId(transfer.tokenId ?? transfer.erc721TokenId))];
    }

    // NATIVE / ERC20: raw base-unit amount from rawContract.value.
    return [makeLeg(`${entry.chainId}:${uniqueId}`, parseRawAmount(transfer.rawContract?.value), null)];
  }

  private classifyGroup(entry: ChainRegistryEntry, legs: NormalizedLeg[]): IndexedTransaction[] {
    // Scam tokens forge the OUT side too. The contract emits a Transfer whose `from` is the victim,
    // so a wallet that never held the token appears to have SENT it — a taxable disposal invented by
    // the attacker. Direction is therefore no evidence of intent, and the two hard signals (a curated
    // denylist entry, a weaponized symbol) are read on BOTH sides, not just on inbound legs. Forged
    // legs are pulled out of the group BEFORE shape detection so one of them cannot turn a genuine
    // swap in the same transaction into an ambiguous 3-asset mix; they are still emitted, tagged
    // SPAM, never dropped.
    const forged = new Set(legs.filter((leg) => this.isForgedLeg(leg)));
    const real = forged.size === 0 ? legs : legs.filter((leg) => !forged.has(leg));
    const spamRows = [...forged].map((leg) => this.buildLeg(entry, leg, "SPAM", 0));

    const inLegs = real.filter((leg) => !leg.isSelf && leg.direction === "IN");
    const outLegs = real.filter((leg) => !leg.isSelf && leg.direction === "OUT");
    const inAssets = new Set(inLegs.map((leg) => leg.assetKey));
    const outAssets = new Set(outLegs.map((leg) => leg.assetKey));
    const swapLike =
      inLegs.length > 0 &&
      outLegs.length > 0 &&
      inAssets.size === 1 &&
      outAssets.size === 1 &&
      [...inAssets][0] !== [...outAssets][0];

    // A swap is exactly ONE disposal (sent asset) + ONE acquisition (received asset). Collapse
    // each side's legs (a router may split one side across several transfers) into a single
    // amount-summed event, so the tx yields EXACTLY two rows: an OUT EXCHANGE (taxable disposal)
    // and an IN RECEIVE (cost-basis anchor, never income). This is the shape the FE swap pairing
    // (lib/swap-pair.ts) collapses into one ledger line. isSelf legs are intra-swap self-moves
    // (wrap/unwrap/router change) with no economic effect and are dropped to keep the pair clean.
    if (swapLike) {
      // Pairing contract: both sides carry ONE deterministic group_id and the FE merges legs by
      // key equality — no tx_hash/exactly-2-count heuristics. The derivation (chain:txHash today)
      // is BE-internal and MUST be treated as an opaque string by consumers: future recognized
      // multi-leg actions (cross-chain bridge links, fee legs) reuse this field with their own
      // derivations that no longer map 1:1 to a single tx. Deterministic (not random) so a resync
      // reproduces the identical payload and never churns the anchor hash.
      const groupId = `${entry.chainId}:${outLegs[0].pureHash}`;
      return [
        this.buildSwapSide(entry, outLegs, "EXCHANGE", groupId),
        this.buildSwapSide(entry, inLegs, "RECEIVE", groupId),
        ...spamRows,
      ];
    }

    // The same swap wearing a residual leg. One side moves a single asset and the other brings back
    // the real counter-asset PLUS a little of the asset that just moved — an aToken's interest minted
    // in the withdraw block, a router rebate, a dust refund. Reading that as three UNKNOWN rows loses
    // the trade the wallet actually made, so the residual is netted against the side it shares an
    // asset with and what remains is an ordinary two-sided swap (same EXCHANGE + RECEIVE pair, same
    // shared group_id). Only these two shapes net; every other mix stays ambiguous.
    const residual = this.netSameAssetResidual(inLegs, outLegs);
    if (residual) {
      const groupId = `${entry.chainId}:${outLegs[0].pureHash}`;
      return [
        this.buildSwapSide(entry, residual.out.legs, "EXCHANGE", groupId, residual.out.netting),
        this.buildSwapSide(entry, residual.in.legs, "RECEIVE", groupId, residual.in.netting),
        ...spamRows,
      ];
    }

    const ambiguousMix = inLegs.length > 0 && outLegs.length > 0;

    const rows = real.map((leg) => {
      if (leg.isSelf) return this.buildLeg(entry, leg, "INTERNAL_TRANSFER", 0.9);
      if (ambiguousMix) return this.buildLeg(entry, leg, "UNKNOWN", 0.3);
      if (leg.direction === "IN") {
        // What is left for a pure inbound receive are the SOFT dust heuristics — chiefly "an
        // inbound-only NFT is airdrop dust" — which are only true when the wallet never paid for it.
        // The hard, direction-independent signals were already applied above.
        const spam = isInboundSpam({
          assetType: leg.payload.asset_type as SpamAssetType,
          symbol: String(leg.payload.symbol),
          assetContract: leg.payload.asset_contract as string | null,
        });
        return spam ? this.buildLeg(entry, leg, "SPAM", 0) : this.buildLeg(entry, leg, "RECEIVE", 0.9);
      }
      return this.buildLeg(entry, leg, "SEND", 0.9);
    });
    return spamRows.length === 0 ? rows : [...rows, ...spamRows];
  }

  // The direction-independent half of spam detection: signals that can only mean "this contract is
  // hostile", never "the wallet did something". A NATIVE leg is never forged (no one else can move a
  // chain's own coin out of a wallet), an allowlisted contract is never spam, and everything else
  // rests on the curated denylist or a symbol weaponized with homoglyphs/URLs. A false positive stays
  // fully recoverable: the row is tagged, not deleted (see spam-filter.ts).
  private isForgedLeg(leg: NormalizedLeg): boolean {
    if (leg.isSelf) return false;
    if (leg.payload.asset_type === "NATIVE") return false;
    const contract = (leg.payload.asset_contract as string | null)?.toLowerCase() ?? null;
    if (contract && CONTRACT_ALLOWLIST.has(contract)) return false;
    if (contract && SPAM_CONTRACT_DENYLIST.has(contract)) return true;
    const symbol = String(leg.payload.symbol ?? "");
    // A blank symbol is enough to flag an unsolicited INBOUND drop, but on the OUT side the wallet
    // actively moved the asset: a legitimate NFT/ERC20 with no symbol metadata would be a real
    // disposal, and hiding it as SPAM would silently drop taxable income. Outbound forgery must
    // therefore carry positive evidence (denylist above, or a visibly weaponized non-empty symbol).
    if (leg.direction === "OUT" && symbol.trim() === "") return false;
    if (isNativeImpersonation(leg.payload.asset_type as SpamAssetType, symbol)) return true;
    return isWeaponizedSymbol(symbol);
  }

  // One event row from one leg. Extracted so the spam sweep above and the ordinary per-leg pass below
  // produce byte-identical rows; only the classification/confidence differ.
  private buildLeg(entry: ChainRegistryEntry, leg: NormalizedLeg, classification: string, confidence: number): IndexedTransaction {
    const eventType: EventType = classification === "EXCHANGE" ? "swap" : leg.direction === "IN" ? "transfer_in" : "transfer_out";

    // A non-self leg whose counterparty is a known bridge contract is a SUSPECTED cross-chain
    // bridge move. Conservative policy: keep the classification (no silent disposal drop) but
    // flag it for review by lowering confidence below the FE floor; expose bridge_suspected so a
    // future FE can show a bridge-specific reason. When the registry also carries a curated
    // display name for that address, surface it as counterparty_label so the FE can render
    // "Relay: Depository (0x4cd0…bc31)" instead of a bare hash; omit the key entirely (never
    // write null) when the address isn't labeled, keeping payloads deterministic across resyncs.
    const counterparty = String(leg.payload.counterparty);
    const bridgeSuspected = !leg.isSelf && isBridgeContract(entry.chainId, counterparty);
    const counterpartyLabel = leg.isSelf ? null : bridgeContractLabel(entry.chainId, counterparty);
    const finalConfidence = bridgeSuspected ? Math.min(confidence, BRIDGE_REVIEW_CONFIDENCE) : confidence;

    return {
      source: "alchemy" as const,
      txHash: leg.storageTxHash,
      chain: String(entry.chainId),
      eventType,
      occurredAt: leg.occurredAt,
      payload: {
        ...leg.payload,
        classification,
        confidence: finalConfidence,
        ...(bridgeSuspected ? { bridge_suspected: true } : {}),
        ...(counterpartyLabel !== null ? { counterparty_label: counterpartyLabel } : {}),
      },
    };
  }

  // Detect the same-asset-residual swap and return its two collapsed sides, or null.
  //
  // Shape A (Aave-style withdraw): ONE asset out, TWO in — the real counter-asset plus a residual of
  // the asset that just left. Shape B is the mirror (ONE asset in, TWO out, one of them the asset
  // that just arrived): a fee or refund taken in the received asset. A residual is not a second
  // trade; it adjusts the SIZE of the side it shares an asset with, so it is subtracted there with
  // exact BigInt arithmetic on raw base units. If that subtraction does not leave a strictly positive
  // amount the group is not the shape it resembles, and it stays ambiguous rather than guessing.
  private netSameAssetResidual(inLegs: NormalizedLeg[], outLegs: NormalizedLeg[]): { out: SwapSide; in: SwapSide } | null {
    const total = (side: NormalizedLeg[]) => side.reduce((sum, leg) => sum + BigInt(String(leg.payload.raw_amount)), 0n);

    // `single` is the one-asset side; `mixed` must be exactly {that same asset, one other}.
    const net = (single: NormalizedLeg[], mixed: NormalizedLeg[]): { netted: SwapSide; counter: SwapSide } | null => {
      if (single.length === 0 || mixed.length === 0) return null;
      const singleAssets = new Set(single.map((leg) => leg.assetKey));
      const mixedAssets = new Set(mixed.map((leg) => leg.assetKey));
      if (singleAssets.size !== 1 || mixedAssets.size !== 2) return null;
      const shared = [...singleAssets][0];
      if (!mixedAssets.has(shared)) return null;
      const residual = mixed.filter((leg) => leg.assetKey === shared);
      const amount = total(single) - total(residual);
      if (amount <= 0n) return null;
      return {
        netted: { legs: single, netting: { amount: amount.toString(), absorbedIds: residual.map((leg) => String(leg.payload.id)) } },
        counter: { legs: mixed.filter((leg) => leg.assetKey !== shared) },
      };
    };

    const residualInbound = net(outLegs, inLegs);
    if (residualInbound) return { out: residualInbound.netted, in: residualInbound.counter };
    const residualOutbound = net(inLegs, outLegs);
    if (residualOutbound) return { out: residualOutbound.counter, in: residualOutbound.netted };
    return null;
  }

  // Collapse one side of a swap into a single event. `sideLegs` all share ONE assetKey (both swapLike
  // and the residual netting guarantee a single asset per side), so their base-unit amounts sum into
  // one disposal (OUT -> EXCHANGE) or one acquisition (IN -> RECEIVE, income_kind null). The first leg
  // supplies identity (id/log_index/counterparty/asset fields); only the amount and classification are
  // rewritten. `netting`, when present, replaces that sum with the residual-adjusted amount and names
  // the absorbed legs in netted_leg_ids so the rows folded away are still traceable — an extra payload
  // field, which the FE contract (normalized-event.ts) strips rather than rejects, exactly like
  // bridge_suspected.
  private buildSwapSide(
    entry: ChainRegistryEntry,
    sideLegs: NormalizedLeg[],
    classification: "EXCHANGE" | "RECEIVE",
    groupId: string,
    netting?: { amount: string; absorbedIds: string[] },
  ): IndexedTransaction {
    const representative = sideLegs[0];
    const totalRaw =
      netting?.amount ?? sideLegs.reduce((sum, leg) => sum + BigInt(String(leg.payload.raw_amount)), 0n).toString();
    // Preserve the conservative bridge-review policy: if either summed leg routed through a known
    // bridge/aggregator, flag the side for review (below the FE floor) instead of pairing it. The
    // display label, if the registry has one, is taken from the REPRESENTATIVE leg's counterparty
    // (the identity source for the whole collapsed side) — omit the key (never write null) when
    // that address isn't labeled, keeping payloads deterministic across resyncs.
    const bridgeSuspected = sideLegs.some((leg) => isBridgeContract(entry.chainId, String(leg.payload.counterparty)));
    const counterpartyLabel = bridgeContractLabel(entry.chainId, String(representative.payload.counterparty));
    const confidence = bridgeSuspected ? Math.min(SWAP_CONFIDENCE, BRIDGE_REVIEW_CONFIDENCE) : SWAP_CONFIDENCE;
    const eventType: EventType = classification === "EXCHANGE" ? "swap" : "transfer_in";

    return {
      source: "alchemy" as const,
      txHash: representative.storageTxHash,
      chain: String(entry.chainId),
      eventType,
      occurredAt: representative.occurredAt,
      payload: {
        ...representative.payload,
        raw_amount: totalRaw,
        classification,
        confidence,
        group_id: groupId,
        // The acquisition leg is a cost-basis anchor, never income; the FE swap pairing requires
        // income_kind === null on the IN leg to treat it as the received side of a swap.
        ...(classification === "RECEIVE" ? { income_kind: null } : {}),
        ...(netting ? { netted_leg_ids: netting.absorbedIds } : {}),
        ...(bridgeSuspected ? { bridge_suspected: true } : {}),
        ...(counterpartyLabel !== null ? { counterparty_label: counterpartyLabel } : {}),
      },
    };
  }

  // payload.log_index: a pure function of THIS transfer's own uniqueId. Real EVM
  // log index for `:log:N`; otherwise a stable NON-NEGATIVE FNV-1a-32 hash of the
  // transfer's own uniqueId. It must be non-negative because the FE contract
  // (normalized-event.ts: log_index int nonnegative) rejects negatives. Uniqueness
  // of an event is carried by payload.id (the chain-scoped storage key), never by
  // this number, so a synthetic value colliding with a real log index is harmless.
  private deriveLogIndex(uniqueId: string): number {
    const match = /:log:(\d+)$/.exec(uniqueId);
    if (match) {
      const parsed = Number(match[1]);
      if (!Number.isSafeInteger(parsed)) throw new ChainIncompleteError("transfer has non-safe-integer log index");
      return parsed;
    }
    let hash = 0x811c9dc5;
    for (let index = 0; index < uniqueId.length; index += 1) {
      hash ^= uniqueId.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }
}
