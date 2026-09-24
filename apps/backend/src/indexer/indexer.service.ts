import { measureOperation } from "../shared/request-timing";
import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { ChainIndexer, ChainScanHooks, ChainScanOutcome } from "@vera/interfaces";
import { keccak256, toBytes } from "viem";
import type { AnchorQueryPort, AnchorSubmissionPort } from "../anchor/anchor.port";
import { ANCHOR_QUERY, ANCHOR_SUBMISSION } from "../anchor/anchor.tokens";
import type { BindingRecord, TransactionRecord } from "../shared/repository.types";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import { SUPPORTED_CHAIN_IDS } from "./chain-registry";
import { NORMALIZATION_RULES_VERSION } from "./normalization-rules";
import { SyncProgressTracker, type SyncProgress } from "./sync-progress";
import type { SyncCursorRepository } from "./sync-cursor.repository";
import type { TransactionSyncRepository } from "./transaction.repository";
import { CHAIN_INDEXER, SYNC_CURSOR_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";
import { PriceEnrichmentService } from "./price-enrichment.service";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { BridgeLinkingService } from "./bridge-linking.service";
import { OwnWalletLinkingService } from "./own-wallet-linking.service";

type SyncMode = "subset" | "all";
type SyncTotals = { fetched: number; normalized: number; byChain: Map<number, number> };
type SkipEntry = { bindingId: string; chainId?: number; code: string; message?: string };
// Per-chain fetched counts across the whole run (all bindings). Always covers every supported
// chain (0 allowed) so the FE import modal can render the full scan list from one response.
export type ChainFetchCount = { chainId: number; fetched: number };
export type SyncResult = { bindings: number; fetched: number; normalized: number; chains: ChainFetchCount[]; skipped: SkipEntry[] };
export type SyncOptions = { onProgress?: (progress: SyncProgress) => void };

const sanitize = (message: unknown): string | undefined =>
  typeof message === "string" && message.length > 0 ? message.slice(0, 200) : undefined;

@Injectable()
export class IndexerService {
  private readonly logger = new Logger(IndexerService.name);
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
    private readonly ownWalletLinking: OwnWalletLinkingService,
  ) {}

  /**
   * Forced incremental refresh across ALL bindings (manual resync + legacy /indexer/sync).
   * `onProgress` receives (binding, chain) snapshots while the run is in flight; a call that rides an
   * already in-flight run (see `coalesce`) shares its result but not its progress stream.
   */
  async sync(userId: string, options: SyncOptions = {}): Promise<SyncResult> {
    const bindings = await this.wallets.findAllByUser(userId);
    if (bindings.length === 0) throw new NotFoundException("A bound wallet is required before sync.");
    // A wallet that has never been synced is the one the user is waiting on (the import modal opens right
    // after binding it). Walk those first so a long-standing big wallet does not keep it queued for minutes.
    // Stable sort: the repository's order is kept within each group.
    const ordered = [...bindings].sort((a, b) => Number(a.initialSyncedAt !== null) - Number(b.initialSyncedAt !== null));
    return this.coalesce(userId, "all", () => this.runSync(userId, ordered, options.onProgress));
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
      // The in-flight run is a 'subset' bootstrap -- almost always the read-path's first-import gate
      // that fired just before this forced call (e.g. the dashboard's first read right after the user
      // registers a wallet). Wait for it, then run 'all' for the fresh cursors it just advanced. But the
      // 'all' pass alone would report near-zero: its cursors start where the subset just left them, so it
      // only sees the tiny post-bootstrap delta. The user's resync toast/modal must reflect what THEIR
      // import actually brought in, not just that delta -- so merge the subset's totals into the forced
      // pass's result. A rejected subset carries nothing to merge, so on failure we keep today's behavior:
      // swallow it and report the 'all' pass alone.
      return existing.promise.then(
        (subsetResult) => this.coalesce(userId, "all", work).then((allResult) => this.mergeSyncResults(subsetResult, allResult)),
        () => this.coalesce(userId, "all", work),
      );
    }
    const entry: { mode: SyncMode; promise: Promise<SyncResult> } = { mode, promise: Promise.resolve({ bindings: 0, fetched: 0, normalized: 0, chains: [], skipped: [] }) };
    // Insert synchronously (no await between create and set); clean up in finally only if still mapped.
    entry.promise = work().finally(() => {
      if (this.inflight.get(userId) === entry) this.inflight.delete(userId);
    });
    this.inflight.set(userId, entry);
    return entry.promise;
  }

  // Merges a settled subset (bootstrap) result into the forced 'all' pass that waited on it. `all`'s
  // binding count wins (subset bindings are always a subset of all's), everything else additive.
  private mergeSyncResults(subset: SyncResult, all: SyncResult): SyncResult {
    const chainTotals = new Map<number, number>();
    for (const entry of subset.chains) chainTotals.set(entry.chainId, (chainTotals.get(entry.chainId) ?? 0) + entry.fetched);
    for (const entry of all.chains) chainTotals.set(entry.chainId, (chainTotals.get(entry.chainId) ?? 0) + entry.fetched);

    const seenSkips = new Set<string>();
    const skipped: SkipEntry[] = [];
    for (const entry of [...subset.skipped, ...all.skipped]) {
      const key = `${entry.bindingId}:${entry.chainId ?? ""}:${entry.code}`;
      if (seenSkips.has(key)) continue;
      seenSkips.add(key);
      skipped.push(entry);
    }

    return {
      bindings: all.bindings,
      fetched: subset.fetched + all.fetched,
      normalized: subset.normalized + all.normalized,
      chains: SUPPORTED_CHAIN_IDS.map((chainId) => ({ chainId, fetched: chainTotals.get(chainId) ?? 0 })),
      skipped,
    };
  }

  private runSync(userId: string, bindings: BindingRecord[], onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    return measureOperation("sync.total", () => this.runSyncWork(userId, bindings, onProgress));
  }

  private async runSyncWork(userId: string, bindings: BindingRecord[], onProgress?: (progress: SyncProgress) => void): Promise<SyncResult> {
    const skipped: SkipEntry[] = [];
    const totals: SyncTotals = { fetched: 0, normalized: 0, byChain: new Map<number, number>() };
    let allFailed = true;
    // Progress is reported per (binding, chain). Registering every pair up front lets a viewer count
    // "n of m" and keeps bindings whose turn has not come from vanishing off the list.
    const progress = new SyncProgressTracker(bindings, SUPPORTED_CHAIN_IDS, onProgress);

    for (const binding of bindings) {
      try {
        const cursors = await this.cursors.listForBinding(binding.id);
        const sinceByChain: Record<number, bigint> = {};
        const rewalk: number[] = [];
        for (const cursor of cursors) {
          // A cursor walked under older normalization rules is stale evidence, not progress: its rows carry
          // judgments the current rules would not make (a forged "EТH" send indexed before the forgery rule
          // stayed SEND). Leaving the chain out of `sinceByChain` walks it from genesis again; the
          // edit-preserving upsert and the superseded-row purge in persistChain turn that into corrections
          // rather than duplicates. See normalization-rules.ts.
          if (cursor.rulesVersion < NORMALIZATION_RULES_VERSION) {
            rewalk.push(cursor.chainId);
            continue;
          }
          sinceByChain[cursor.chainId] = cursor.lastSyncedBlock;
        }
        if (rewalk.length > 0) {
          this.logger.log(`binding ${binding.id}: re-walking chain(s) ${rewalk.join(", ")} from genesis — cursor rules version is behind ${NORMALIZATION_RULES_VERSION}.`);
        }

        // Each chain is persisted the moment the adapter hands it over (streaming), so a big wallet shows
        // its finished chains while the slow ones are still being scanned. Persistence is serialized on
        // one queue: three chains can finish at once, but DB round-trips do not interleave and one chain's
        // failure never drags another down. The adapter is not made to wait for the queue.
        const persisted = new Set<number>();
        let queue: Promise<void> = Promise.resolve();
        const hooks: ChainScanHooks = {
          onProgress: (update) => progress.chain(binding.id, update.chainId).scanning(update),
          onChainError: (chainId, message) => progress.chain(binding.id, chainId).fail(message),
          onChain: (outcome) => {
            persisted.add(outcome.chainId);
            queue = queue.then(() => measureOperation("sync.persist", () => this.persistChain(userId, binding, outcome, progress, skipped, totals)));
          },
        };
        const { transactions, chainHeads } = await measureOperation("sync.scan", () => this.indexer.fetchTransactions(binding.walletAddress, sinceByChain, hooks));
        await queue;

        // Non-streaming adapters (mock, test fakes) only return the aggregate: persist whatever was not
        // handed over above through the very same routine. A chain without a head was not completely
        // observed — hold its cursor and report it.
        for (const chainId of SUPPORTED_CHAIN_IDS) {
          if (persisted.has(chainId)) continue;
          const head = chainHeads[chainId];
          if (head === undefined) {
            skipped.push({ bindingId: binding.id, chainId, code: "chain_incomplete" });
            progress.chain(binding.id, chainId).fail("chain incomplete");
            continue;
          }
          await this.persistChain(userId, binding, { chainId, head, transactions: transactions.filter((item) => Number(item.chain) === chainId) }, progress, skipped, totals);
        }

        // Mark the first attempt done ONLY when currently null, so a manual ALL resync preserves the
        // original first-attempt timestamp (null-gating still drives the read path either way).
        if (binding.initialSyncedAt === null) await this.wallets.markInitialSynced(binding.id, new Date());
        // At least one chain was observed (fetchTransactions throws otherwise) -> the run is not a total failure.
        allFailed = false;
      } catch (error) {
        // Binding-level failure: hold its cursors + marker, record a diagnostic, keep other bindings going.
        const message = sanitize((error as Error).message);
        skipped.push({ bindingId: binding.id, code: "binding_unavailable", message });
        for (const chainId of SUPPORTED_CHAIN_IDS) progress.chain(binding.id, chainId).fail(message ?? "binding unavailable");
      }
    }

    if (allFailed && bindings.length > 0) {
      throw new ServiceUnavailableException(`Sync failed for all ${bindings.length} wallet(s).`);
    }

    // Cross-chain bridge linking runs ONCE after every binding is persisted, so it sees the user's
    // full multi-chain dataset (a bridge's destination IN may live on a different binding/chain).
    // Best-effort: a linking failure must never fail an otherwise-successful sync.
    try {
      // Own-wallet linking runs FIRST and claims every leg it can prove is a same-user move, so
      // bridge linking (which skips `own:` keys) can never re-link one of them on a lucky amount.
      await this.ownWalletLinking.linkForUser(userId);
      await this.bridgeLinking.linkForUser(userId);
    } catch (error) {
      skipped.push({ bindingId: bindings[0]?.id ?? "", code: "bridge_linking_failed", message: sanitize((error as Error).message) });
    }

    return {
      bindings: bindings.length,
      fetched: totals.fetched,
      normalized: totals.normalized,
      chains: SUPPORTED_CHAIN_IDS.map((chainId) => ({ chainId, fetched: totals.byChain.get(chainId) ?? 0 })),
      skipped,
    };
  }

  /**
   * One chain of one binding, from enrichment to cursor: price, save (edit-preserving upsert), purge the
   * rows this normalization superseded, advance the cursor, anchor. Runs the same whether the chain was
   * streamed by the adapter or taken from the aggregate result, so both paths produce identical rows.
   * A failure anywhere leaves the cursor where it was — the next sync sees the same window again.
   */
  private async persistChain(
    userId: string,
    binding: BindingRecord,
    outcome: ChainScanOutcome,
    progress: SyncProgressTracker,
    skipped: SkipEntry[],
    totals: SyncTotals,
  ): Promise<void> {
    const { chainId, head, transactions } = outcome;
    const chain = progress.chain(binding.id, chainId);
    totals.fetched += transactions.length;
    totals.byChain.set(chainId, (totals.byChain.get(chainId) ?? 0) + transactions.length);
    try {
      chain.pricing(transactions.length);
      // Best-effort market enrichment (DexScreener): dust gate + informational price.
      // A pricing failure must NEVER fail the chain, so it is fully guarded.
      try {
        await measureOperation("sync.spot_prices", () => this.pricing.enrich(transactions));
      } catch (error) {
        skipped.push({ bindingId: binding.id, code: "price_enrichment_failed", message: sanitize((error as Error).message) });
      }

      // Tax-basis enrichment (CoinGecko historical KRW): fills fiat_value/price_status the
      // real adapter leaves null. Distinct concern from the display-only spot price above,
      // and equally guarded — a basis lookup failure must never fail the chain.
      try {
        await measureOperation("sync.historical_prices", () => this.historicalPricing.enrich(transactions));
      } catch (error) {
        skipped.push({ bindingId: binding.id, code: "historical_price_enrichment_failed", message: sanitize((error as Error).message) });
      }

      chain.saving(0);
      const withHashes = transactions.map((item) => ({
        ...item,
        payload: { ...item.payload, _anchorPayloadHash: keccak256(toBytes(JSON.stringify({ txHash: item.txHash, eventType: item.eventType, payload: item.payload }))) },
      }));
      const stored = await measureOperation("sync.db_save", () => this.transactions.save(binding.id, userId, withHashes, (saved) => chain.saving(saved)));
      totals.normalized += stored.length;

      // Re-normalization can move a leg to another eventType (UNKNOWN transfer_out -> EXCHANGE swap)
      // or fold it into a neighbouring leg's row (netted_leg_ids). The storage key is
      // (binding, txHash, eventType), so the upsert above writes the NEW row and leaves the old one
      // behind — the FE then shows the corrected event AND a ghost 미분류 row next to it. This purge
      // is keyed ONLY on legs that were positively re-emitted just now, never on a block range, so a
      // partial fetch can never wipe real history. Guarded: it must not fail an otherwise-good chain.
      try {
        await this.transactions.deleteSupersededRows(binding.id, userId, stored.map((row) => ({
          id: row.txHash,
          eventType: row.eventType,
          nettedLegIds: Array.isArray(row.payload.netted_leg_ids) ? row.payload.netted_leg_ids.map(String) : [],
        })));
      } catch (error) {
        skipped.push({ bindingId: binding.id, code: "superseded_purge_failed", message: sanitize((error as Error).message) });
      }

      // The chain was completely observed up to `head` and its rows are stored: advance its cursor.
      await this.cursors.advance(binding.id, chainId, BigInt(head), NORMALIZATION_RULES_VERSION);

      // Anchor submission is reserved for verified (siwe) bindings; watch-only rows
      // are still fetched/normalized/stored, just never anchored.
      if (binding.verifiedAt !== null) await measureOperation("sync.anchor", () => this.anchorStored(stored, skipped, binding.id));
      chain.done(stored.length);
    } catch (error) {
      const message = sanitize((error as Error).message);
      skipped.push({ bindingId: binding.id, chainId, code: "chain_incomplete", message });
      chain.fail(message ?? "chain persist failed");
    }
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
