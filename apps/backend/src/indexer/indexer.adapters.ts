import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChainIndexer, ChainScanResult, IndexedTransaction } from "@vera/interfaces";
import { CHAIN_REGISTRY, SUPPORTED_CHAIN_IDS, type ChainRegistryEntry } from "./chain-registry";
import { BRIDGE_REVIEW_CONFIDENCE, isBridgeContract } from "./bridge-registry";
import { isInboundSpam, type SpamAssetType } from "./spam-filter";

const chains = SUPPORTED_CHAIN_IDS;

// Bounded per-chain fan-out. Alchemy's compute-unit budget is shared across every network host on one key,
// so a full 5-chain burst can trip 429s; three in flight keeps a zero-delta resync near one round-trip
// instead of five sequential ones (12.5s -> ~3s observed on 2026-09-08) while staying under the burst.
const CHAIN_CONCURRENCY = 3;
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
        return { entry, head, transactions: this.normalizeChain(entry, address, wallet, inbound, outbound) };
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

  private normalizeChain(
    entry: ChainRegistryEntry,
    address: string,
    wallet: string,
    inbound: AlchemyTransfer[],
    outbound: AlchemyTransfer[],
  ): IndexedTransaction[] {
    // Merge + dedupe by chain-scoped uniqueId (a self-transfer appears in both
    // direction responses with the same uniqueId).
    const byUniqueId = new Map<string, AlchemyTransfer>();
    for (const transfer of [...inbound, ...outbound]) {
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
    const inLegs = legs.filter((leg) => !leg.isSelf && leg.direction === "IN");
    const outLegs = legs.filter((leg) => !leg.isSelf && leg.direction === "OUT");
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
      ];
    }

    const ambiguousMix = inLegs.length > 0 && outLegs.length > 0;

    return legs.map((leg) => {
      let classification: string;
      let confidence: number;
      if (leg.isSelf) {
        classification = "INTERNAL_TRANSFER";
        confidence = 0.9;
      } else if (ambiguousMix) {
        classification = "UNKNOWN";
        confidence = 0.3;
      } else if (leg.direction === "IN") {
        // A pure inbound receive is the only shape dust/airdrop spam can take.
        if (isInboundSpam({ assetType: leg.payload.asset_type as SpamAssetType, symbol: String(leg.payload.symbol), assetContract: leg.payload.asset_contract as string | null })) {
          classification = "SPAM";
          confidence = 0;
        } else {
          classification = "RECEIVE";
          confidence = 0.9;
        }
      } else {
        classification = "SEND";
        confidence = 0.9;
      }

      const eventType: EventType = classification === "EXCHANGE" ? "swap" : leg.direction === "IN" ? "transfer_in" : "transfer_out";

      // A non-self leg whose counterparty is a known bridge contract is a SUSPECTED cross-chain
      // bridge move. Conservative policy: keep the classification (no silent disposal drop) but
      // flag it for review by lowering confidence below the FE floor; expose bridge_suspected so a
      // future FE can show a bridge-specific reason.
      const bridgeSuspected = !leg.isSelf && isBridgeContract(entry.chainId, String(leg.payload.counterparty));
      const finalConfidence = bridgeSuspected ? Math.min(confidence, BRIDGE_REVIEW_CONFIDENCE) : confidence;

      return {
        source: "alchemy" as const,
        txHash: leg.storageTxHash,
        chain: String(entry.chainId),
        eventType,
        occurredAt: leg.occurredAt,
        payload: { ...leg.payload, classification, confidence: finalConfidence, ...(bridgeSuspected ? { bridge_suspected: true } : {}) },
      };
    });
  }

  // Collapse one side of a swap into a single event. `sideLegs` all share ONE assetKey (swapLike
  // guarantees a single asset per side), so their base-unit amounts sum into one disposal (OUT ->
  // EXCHANGE) or one acquisition (IN -> RECEIVE, income_kind null). The first leg supplies identity
  // (id/log_index/counterparty/asset fields); only the amount and classification are rewritten.
  private buildSwapSide(
    entry: ChainRegistryEntry,
    sideLegs: NormalizedLeg[],
    classification: "EXCHANGE" | "RECEIVE",
    groupId: string,
  ): IndexedTransaction {
    const representative = sideLegs[0];
    const totalRaw = sideLegs.reduce((sum, leg) => sum + BigInt(String(leg.payload.raw_amount)), 0n).toString();
    // Preserve the conservative bridge-review policy: if either summed leg routed through a known
    // bridge/aggregator, flag the side for review (below the FE floor) instead of pairing it.
    const bridgeSuspected = sideLegs.some((leg) => isBridgeContract(entry.chainId, String(leg.payload.counterparty)));
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
        ...(bridgeSuspected ? { bridge_suspected: true } : {}),
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
