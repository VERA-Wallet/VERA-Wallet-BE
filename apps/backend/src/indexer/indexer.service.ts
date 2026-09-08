import { Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ChainIndexer } from "@vera/interfaces";
import { keccak256, toBytes } from "viem";
import type { AnchorQueryPort, AnchorSubmissionPort } from "../anchor/anchor.port";
import { ANCHOR_QUERY, ANCHOR_SUBMISSION } from "../anchor/anchor.tokens";
import type { BindingRecord, TransactionRecord } from "../shared/repository.types";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import { SUPPORTED_CHAIN_IDS } from "./chain-registry";
import type { SyncCursorRepository } from "./sync-cursor.repository";
import type { TransactionSyncRepository } from "./transaction.repository";
import { CHAIN_INDEXER, SYNC_CURSOR_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";
import { PriceEnrichmentService } from "./price-enrichment.service";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { BridgeLinkingService } from "./bridge-linking.service";

type SyncMode = "subset" | "all";
type SkipEntry = { bindingId: string; chainId?: number; code: string; message?: string };
// Per-chain fetched counts across the whole run (all bindings). Always covers every supported
// chain (0 allowed) so the FE import modal can render the full scan list from one response.
export type ChainFetchCount = { chainId: number; fetched: number };
export type SyncResult = { bindings: number; fetched: number; normalized: number; chains: ChainFetchCount[]; skipped: SkipEntry[] };

const sanitize = (message: unknown): string | undefined =>
  typeof message === "string" && message.length > 0 ? message.slice(0, 200) : undefined;

@Injectable()
export class IndexerService {
  // Per-user promise coalescer. Each entry is tagged with its work-set mode so a forced
  // all-binding refresh is never satisfied by an in-flight subset bootstrap.
  private readonly inflight = new Map<string, { mode: SyncMode; promise: Promise<SyncResult> }>();

  constructor(
    @Inject(CHAIN_INDEXER) private readonly indexer: ChainIndexer,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(TRANSACTION_SYNC_REPOSITORY) private readonly transactions: TransactionSyncRepository,
    @Inject(ANCHOR_SUBMISSION) private readonly anchors: AnchorSubmissionPort,
    @Inject(ANCHOR_QUERY) private readonly anchorQuery: AnchorQueryPort,
    @Inject(SYNC_CURSOR_REPOSITORY) private readonly cursors: SyncCursorRepository,
    private readonly pricing: PriceEnrichmentService,
    private readonly historicalPricing: HistoricalPriceEnrichmentService,
    private readonly bridgeLinking: BridgeLinkingService,
  ) {}

  /** Forced incremental refresh across ALL bindings (manual resync + legacy /indexer/sync). */
  async sync(userId: string): Promise<SyncResult> {
    const bindings = await this.wallets.findAllByUser(userId);
    if (bindings.length === 0) throw new NotFoundException("A bound wallet is required before sync.");
    return this.coalesce(userId, "all", () => this.runSync(userId, bindings));
  }

  /**
   * Read-path first sync: syncs ONLY bindings that have never completed a first attempt. No-op once done.
   *
   * `waitMs` bounds how long a READ waits for that first sync. A heavy wallet's first sync runs for minutes
   * (thousands of transfers + historical prices), and a read that blocks on it just trips the FE's 5s
   * upstream timeout — the dashboard and tax page 502 for the whole duration. Past the bound the read
   * returns whatever is stored (stale-until-refresh) while the sync keeps running; the import modal polls
   * the job for completion. Without `waitMs` the call waits for the sync to settle (mock/e2e paths).
   */
  async ensureInitialSync(userId: string, options: { waitMs?: number } = {}): Promise<void> {
    const bindings = await this.wallets.findAllByUser(userId);
    const incomplete = bindings.filter((binding) => binding.initialSyncedAt === null);
    if (incomplete.length === 0) return;
    const run = this.coalesce(userId, "subset", () => this.runSync(userId, incomplete));
    if (options.waitMs === undefined) {
      await run;
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), options.waitMs); });
    try {
      const outcome = await Promise.race([run.then(() => "settled" as const), timeout]);
      // Settled within the bound: surface the sync's own failure exactly as before (e.g. total outage -> 503).
      if (outcome === "timeout") run.catch(() => undefined); // still running; its rejection is reported via the job/skips, not this read
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private coalesce(userId: string, mode: SyncMode, work: () => Promise<SyncResult>): Promise<SyncResult> {
    const existing = this.inflight.get(userId);
    if (existing) {
      // A read-gate (subset) call may ride any in-flight run (an 'all' superset covers it).
      if (mode === "subset") return existing.promise;
      // A forced 'all' call may ride an in-flight 'all', but must NEVER be satisfied by a 'subset'
      // bootstrap (it would omit already-synced bindings). Wait for the subset to settle, then run 'all'.
      if (existing.mode === "all") return existing.promise;
      return existing.promise.catch(() => undefined).then(() => this.coalesce(userId, "all", work));
    }
    const entry: { mode: SyncMode; promise: Promise<SyncResult> } = { mode, promise: Promise.resolve({ bindings: 0, fetched: 0, normalized: 0, chains: [], skipped: [] }) };
    // Insert synchronously (no await between create and set); clean up in finally only if still mapped.
    entry.promise = work().finally(() => {
      if (this.inflight.get(userId) === entry) this.inflight.delete(userId);
    });
    this.inflight.set(userId, entry);
    return entry.promise;
  }

  private async runSync(userId: string, bindings: BindingRecord[]): Promise<SyncResult> {
    const skipped: SkipEntry[] = [];
    const fetchedByChain = new Map<number, number>();
    let fetched = 0;
    let normalized = 0;
    let allFailed = true;

    for (const binding of bindings) {
      try {
        const cursors = await this.cursors.listForBinding(binding.id);
        const sinceByChain: Record<number, bigint> = {};
        for (const cursor of cursors) sinceByChain[cursor.chainId] = cursor.lastSyncedBlock;

        const { transactions, chainHeads } = await this.indexer.fetchTransactions(binding.walletAddress, sinceByChain);
        fetched += transactions.length;
        for (const item of transactions) {
          const chainId = Number(item.chain);
          fetchedByChain.set(chainId, (fetchedByChain.get(chainId) ?? 0) + 1);
        }

        // Best-effort market enrichment (DexScreener): dust gate + informational price.
        // A pricing failure must NEVER fail the binding sync, so it is fully guarded.
        try {
          await this.pricing.enrich(transactions);
        } catch (error) {
          skipped.push({ bindingId: binding.id, code: "price_enrichment_failed", message: sanitize((error as Error).message) });
        }

        // Tax-basis enrichment (CoinGecko historical KRW): fills fiat_value/price_status the
        // real adapter leaves null. Distinct concern from the display-only spot price above,
        // and equally guarded — a basis lookup failure must never fail the binding sync.
        try {
          await this.historicalPricing.enrich(transactions);
        } catch (error) {
          skipped.push({ bindingId: binding.id, code: "historical_price_enrichment_failed", message: sanitize((error as Error).message) });
        }

        const withHashes = transactions.map((item) => ({
          ...item,
          payload: { ...item.payload, _anchorPayloadHash: keccak256(toBytes(JSON.stringify({ txHash: item.txHash, eventType: item.eventType, payload: item.payload }))) },
        }));
        const stored = await this.transactions.save(binding.id, userId, withHashes);
        normalized += stored.length;

        // Advance cursors ONLY for completely-observed chains; hold + report the rest.
        for (const chainId of SUPPORTED_CHAIN_IDS) {
          const head = chainHeads[chainId];
          if (head === undefined) skipped.push({ bindingId: binding.id, chainId, code: "chain_incomplete" });
          else await this.cursors.advance(binding.id, chainId, BigInt(head));
        }

        // Anchor submission is reserved for verified (siwe) bindings; watch-only rows
        // are still fetched/normalized/stored, just never anchored.
        if (binding.verifiedAt !== null) await this.anchorStored(stored, skipped, binding.id);

        // Mark the first attempt done ONLY when currently null, so a manual ALL resync preserves the
        // original first-attempt timestamp (null-gating still drives the read path either way).
        if (binding.initialSyncedAt === null) await this.wallets.markInitialSynced(binding.id, new Date());
        // The binding fully completed (fetch + persist + cursor + marker) -> the run is not a total failure.
        allFailed = false;
      } catch (error) {
        // Binding-level failure: hold its cursors + marker, record a diagnostic, keep other bindings going.
        skipped.push({ bindingId: binding.id, code: "binding_unavailable", message: sanitize((error as Error).message) });
      }
    }

    if (allFailed && bindings.length > 0) {
      throw new ServiceUnavailableException(`Sync failed for all ${bindings.length} wallet(s).`);
    }

    // Cross-chain bridge linking runs ONCE after every binding is persisted, so it sees the user's
    // full multi-chain dataset (a bridge's destination IN may live on a different binding/chain).
    // Best-effort: a linking failure must never fail an otherwise-successful sync.
    try {
      await this.bridgeLinking.linkForUser(userId);
    } catch (error) {
      skipped.push({ bindingId: bindings[0]?.id ?? "", code: "bridge_linking_failed", message: sanitize((error as Error).message) });
    }

    return {
      bindings: bindings.length,
      fetched,
      normalized,
      chains: SUPPORTED_CHAIN_IDS.map((chainId) => ({ chainId, fetched: fetchedByChain.get(chainId) ?? 0 })),
      skipped,
    };
  }

  // Per-event anchor guard, isolated: a rejection for one event never stops another. On enqueue
  // rejection the (now `pending`) record is transitioned to `failed` so it is retried IF re-observed
  // within the cursor window on a later resync. Durable cross-window anchor retry (an enqueue that
  // never produced a Bull job) is owned by the anchor queue (attempts/backoff) as a follow-up; the
  // cursor/marker stay decoupled from anchor outcome so a failure never strands the sync.
  private async anchorStored(stored: TransactionRecord[], skipped: SkipEntry[], bindingId: string): Promise<void> {
    for (const transaction of stored) {
      const payloadHash = String(transaction.payload._anchorPayloadHash);
      try {
        const existing = await this.anchorQuery.get(payloadHash);
        if (existing && existing.status !== "failed") continue; // anchored/pending -> skip; failed -> retry
        await this.anchors.submit(payloadHash, "audit");
      } catch (error) {
        // Transition pending -> failed; do NOT swallow a failed transition (report it distinctly).
        try {
          await this.anchorQuery.markFailed(payloadHash);
        } catch (markError) {
          skipped.push({ bindingId, code: "anchor_mark_failed", message: sanitize((markError as Error).message) });
        }
        skipped.push({ bindingId, code: "anchor_enqueue_failed", message: sanitize((error as Error).message) });
      }
    }
  }
}
