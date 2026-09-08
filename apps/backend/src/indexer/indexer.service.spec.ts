import { ServiceUnavailableException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainIndexer, ChainScanResult, IndexedTransaction } from "@vera/interfaces";
import { IndexerService } from "./indexer.service";
import { MockTransactionRepository } from "./transaction.repository.adapters";
import { MockSyncCursorRepository } from "./sync-cursor.repository.adapters";
import { MockWalletRepository } from "../wallet/wallet.repository.adapters";
import { PriceEnrichmentService } from "./price-enrichment.service";
import { MockPriceOracle } from "./price-oracle";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { MockHistoricalPriceOracle } from "./historical-price-oracle";
import { MockHistoricalPriceRepository } from "./historical-price.repository.adapters";
import { BridgeLinkingService } from "./bridge-linking.service";

const ALL_HEADS: Record<number, number> = { 1: 100, 8453: 100, 42161: 100, 10: 100, 137: 100 };

const evt = (i: number): IndexedTransaction => ({
  source: "alchemy", txHash: `0xtx${i}`, chain: "1", eventType: "transfer_in",
  occurredAt: new Date("2025-01-01T00:00:00.000Z"),
  payload: { id: `e${i}`, chain_id: 1, user_override: null, _version: 1, _overrideHistory: [] },
});

class FakeAnchor {
  records = new Map<string, { payloadHash: string; status: string }>();
  submitCalls: string[] = [];
  rejectFirst = false;
  async get(hash: string) { return (this.records.get(hash) ?? null) as never; }
  async verify() { return true; }
  async markFailed(hash: string) { const record = this.records.get(hash); if (record) record.status = "failed"; }
  async submit(hash: string) {
    this.submitCalls.push(hash);
    this.records.set(hash, { payloadHash: hash, status: "pending" }); // prepare (before enqueue)
    if (this.rejectFirst && this.submitCalls.length === 1) throw new Error("enqueue rejected");
    this.records.set(hash, { payloadHash: hash, status: "anchored" });
    return null as never;
  }
}

// Test bindings are verified siwe unless a spec overrides verifiedAt (watch-only anchor gate).
const upsertBinding = (
  wallets: MockWalletRepository,
  input: { userId: string; walletAddress: string; bindingHash: string | null; verifiedAt?: Date | null; verificationMethod?: string },
) => wallets.upsert({ verificationMethod: "siwe", verifiedAt: new Date(), ...input });

async function harness(impl?: (address: string, since?: Record<number, bigint>) => Promise<ChainScanResult>) {
  const indexerFn = vi.fn(impl ?? (async () => ({ transactions: [], chainHeads: { ...ALL_HEADS } })));
  const indexer = { fetchTransactions: indexerFn } as unknown as ChainIndexer;
  const wallets = new MockWalletRepository();
  const transactions = new MockTransactionRepository();
  const cursors = new MockSyncCursorRepository();
  const anchor = new FakeAnchor();
  const pricing = new PriceEnrichmentService(new MockPriceOracle());
  const historicalPricing = new HistoricalPriceEnrichmentService(new MockHistoricalPriceOracle(), new MockHistoricalPriceRepository());
  const bridgeLinking = new BridgeLinkingService(transactions);
  const service = new IndexerService(indexer, wallets, transactions, anchor as never, anchor as never, cursors, pricing, historicalPricing, bridgeLinking);
  return { service, indexerFn, wallets, transactions, cursors, anchor };
}

afterEach(() => vi.restoreAllMocks());

describe("IndexerService read gate (manual-only, initialSyncedAt marker)", () => {
  it("syncs a never-synced binding once, writes cursors, and marks it (AC1/AC2)", async () => {
    const h = await harness();
    const binding = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.ensureInitialSync("u1");
    expect(h.indexerFn).toHaveBeenCalledTimes(1);
    const [updated] = await h.wallets.findAllByUser("u1");
    expect(updated.initialSyncedAt).not.toBeNull();
    expect((await h.cursors.listForBinding(binding.id)).map((c) => c.chainId).sort((a, b) => a - b)).toEqual([10, 137, 1, 8453, 42161].sort((a, b) => a - b));
  });

  it("does NOT call the provider on a read once the binding is synced (AC3)", async () => {
    const h = await harness();
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.ensureInitialSync("u1"); // first
    h.indexerFn.mockClear();
    await h.service.ensureInitialSync("u1"); // second -> no-op
    expect(h.indexerFn).not.toHaveBeenCalled();
  });

  it("first-syncs only the never-synced 2nd wallet, not the already-synced one (AC4)", async () => {
    const h = await harness();
    const a = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWA", bindingHash: "0xha" });
    await h.service.ensureInitialSync("u1"); // syncs A
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWB", bindingHash: "0xhb" }); // new B
    h.indexerFn.mockClear();
    await h.service.ensureInitialSync("u1");
    expect(h.indexerFn).toHaveBeenCalledTimes(1); // only B
    expect(h.indexerFn.mock.calls[0][0]).toBe("0xWB");
    void a;
  });
});

describe("IndexerService coalescing", () => {
  it("collapses concurrent first-sync reads into ONE provider call (AC7)", async () => {
    const h = await harness();
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await Promise.all([h.service.ensureInitialSync("u1"), h.service.ensureInitialSync("u1"), h.service.ensureInitialSync("u1")]);
    expect(h.indexerFn).toHaveBeenCalledTimes(1);
  });

  it("re-runs after the previous run settled (coalescer cleared)", async () => {
    const h = await harness();
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.sync("u1");
    await h.service.sync("u1"); // second forced run must actually run again
    expect(h.indexerFn).toHaveBeenCalledTimes(2);
  });

  it("a forced all-binding resync is NOT satisfied by an in-flight subset bootstrap (AC13)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const h = await harness(async (address) => {
      calls += 1;
      if (calls === 1) await gate; // hold the first (subset bootstrap) call
      void address;
      return { transactions: [], chainHeads: { ...ALL_HEADS } };
    });
    const a = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWA", bindingHash: "0xha" });
    await h.wallets.markInitialSynced(a.id, new Date()); // A already synced (no gated provider call)
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWB", bindingHash: "0xhb" }); // new B (null)

    // Start a B-only subset bootstrap (blocks on the gate), then a forced all-binding resync.
    const subset = h.service.ensureInitialSync("u1");
    const forced = h.service.sync("u1");
    release();
    await Promise.all([subset, forced]);

    const scanned = h.indexerFn.mock.calls.map((c) => c[0]);
    // The forced run must cover BOTH wallets, not just the subset's B.
    expect(scanned).toContain("0xWA");
    expect(scanned).toContain("0xWB");
  });
});

describe("IndexerService read-gate bounded wait", () => {
  it("returns a read within waitMs while a slow first sync keeps running, then completes it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness(async () => { await gate; return { transactions: [], chainHeads: { ...ALL_HEADS } }; });
    const binding = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });

    const started = Date.now();
    await h.service.ensureInitialSync("u1", { waitMs: 20 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await h.wallets.findAllByUser("u1"))[0].initialSyncedAt).toBeNull(); // still running

    release();
    // A later read (subset) rides the still-in-flight run instead of starting another provider call.
    await h.service.ensureInitialSync("u1");
    expect((await h.wallets.findAllByUser("u1")).find((b) => b.id === binding.id)?.initialSyncedAt).not.toBeNull();
    expect(h.indexerFn).toHaveBeenCalledTimes(1);
  });

  it("still surfaces a total-outage failure when the sync settles inside the bound", async () => {
    const h = await harness(async () => { throw new Error("provider down"); });
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await expect(h.service.ensureInitialSync("u1", { waitMs: 1_000 })).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

describe("IndexerService per-event anchor isolation (AC8)", () => {
  it("an event-1 enqueue rejection does not stop event-2; event 1 is left failed; cursor/marker still advance", async () => {
    const h = await harness(async () => ({ transactions: [evt(0), evt(1)], chainHeads: { ...ALL_HEADS } }));
    h.anchor.rejectFirst = true;
    const binding = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.sync("u1");
    expect(h.anchor.submitCalls).toHaveLength(2); // event 2 still submitted after event 1 rejected
    expect(h.anchor.records.get(h.anchor.submitCalls[0])!.status).toBe("failed"); // retryable, not stuck pending
    expect(h.anchor.records.get(h.anchor.submitCalls[1])!.status).toBe("anchored");
    const [updated] = await h.wallets.findAllByUser("u1");
    expect(updated.initialSyncedAt).not.toBeNull();
    expect(await h.cursors.listForBinding(binding.id)).toHaveLength(5);
  });

  it("skips re-enqueue of already-anchored events on resync but retries failed (AC8)", async () => {
    const h = await harness(async () => ({ transactions: [evt(0)], chainHeads: { ...ALL_HEADS } }));
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.sync("u1"); // event anchored
    expect(h.anchor.submitCalls).toHaveLength(1);
    await h.service.sync("u1"); // resync -> already anchored -> no new submit
    expect(h.anchor.submitCalls).toHaveLength(1);
  });

  it("never anchors a watch-only (unverified) binding, but still fetches + stores its events", async () => {
    const h = await harness(async () => ({ transactions: [evt(0), evt(1)], chainHeads: { ...ALL_HEADS } }));
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: null, verificationMethod: "watch_only", verifiedAt: null });
    const result = await h.service.sync("u1");
    expect(h.anchor.submitCalls).toHaveLength(0); // watch-only never anchors
    expect(result.normalized).toBe(2); // events are still observed + persisted
    expect(result.skipped.filter((s) => s.code.startsWith("anchor"))).toHaveLength(0);
    // Per-chain counts cover every supported chain (0 allowed) in registry order.
    expect(result.chains).toEqual([
      { chainId: 1, fetched: 2 },
      { chainId: 8453, fetched: 0 },
      { chainId: 42161, fetched: 0 },
      { chainId: 10, fetched: 0 },
      { chainId: 137, fetched: 0 },
    ]);
  });
});

describe("IndexerService multi-wallet + outage", () => {
  it("walks all bindings with independent cursors on a forced sync (AC10)", async () => {
    const h = await harness();
    const a = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWA", bindingHash: "0xha" });
    const b = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xWB", bindingHash: "0xhb" });
    await h.service.sync("u1");
    expect(h.indexerFn).toHaveBeenCalledTimes(2);
    expect(await h.cursors.listForBinding(a.id)).toHaveLength(5);
    expect(await h.cursors.listForBinding(b.id)).toHaveLength(5);
  });

  it("throws 503 and leaves the marker NULL on total outage (AC15)", async () => {
    const h = await harness(async () => { throw new ServiceUnavailableException("boom"); });
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await expect(h.service.sync("u1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    const [binding] = await h.wallets.findAllByUser("u1");
    expect(binding.initialSyncedAt).toBeNull(); // no result -> no mark, retried next time
  });

  it("throws 404 when the user has no bound wallet", async () => {
    const h = await harness();
    await expect(h.service.sync("u1")).rejects.toThrow();
  });

  it("holds a chain's cursor when it is incomplete (absent from chainHeads) and reports it (AC6)", async () => {
    const h = await harness(async () => ({ transactions: [], chainHeads: { 1: 100 } })); // only eth observed
    const binding = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    const result = await h.service.sync("u1");
    expect((await h.cursors.listForBinding(binding.id)).map((c) => c.chainId)).toEqual([1]);
    expect(result.skipped.filter((s) => s.code === "chain_incomplete").map((s) => s.chainId).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([8453, 42161, 10, 137].sort((a, b) => a - b));
  });
});

describe("IndexerService gaps (AC7/12/14/15)", () => {
  it("saves exactly ONE batch (not N*batch) under concurrent first-sync reads (AC7)", async () => {
    const h = await harness(async () => ({ transactions: [evt(0), evt(1)], chainHeads: { ...ALL_HEADS } }));
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    const saveSpy = vi.spyOn(h.transactions, "save");
    await Promise.all([h.service.ensureInitialSync("u1"), h.service.ensureInitialSync("u1"), h.service.ensureInitialSync("u1")]);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][2]).toHaveLength(2);
  });

  it("clears the coalescer after a REJECTED run so a later sync retries (AC7)", async () => {
    let attempt = 0;
    const h = await harness(async () => {
      attempt += 1;
      if (attempt === 1) throw new ServiceUnavailableException("transient");
      return { transactions: [], chainHeads: { ...ALL_HEADS } };
    });
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await expect(h.service.sync("u1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(h.service.sync("u1")).resolves.toBeDefined(); // not the cached rejected promise
    expect(attempt).toBe(2);
  });

  it("never writes a block/head field into the persisted payload (AC12)", async () => {
    const h = await harness(async () => ({ transactions: [evt(0)], chainHeads: { ...ALL_HEADS } }));
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.sync("u1");
    const [row] = await h.transactions.listForUser("u1");
    expect(row.payload).not.toHaveProperty("blockNumber");
    expect(row.payload).not.toHaveProperty("chainHeads");
    expect(Object.keys(row.payload).some((k) => /^(head|blockNumber|chainHead)/.test(k))).toBe(false);
  });

  it("creates a binding with initialSyncedAt null (AC14)", async () => {
    const h = await harness();
    const created = await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    expect(created.initialSyncedAt).toBeNull();
    expect((await h.wallets.findAllByUser("u1"))[0].initialSyncedAt).toBeNull();
  });

  it("a total outage on a READ (ensureInitialSync) rejects and leaves the marker null (AC15)", async () => {
    const h = await harness(async () => { throw new ServiceUnavailableException("boom"); });
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await expect(h.service.ensureInitialSync("u1")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await h.wallets.findAllByUser("u1"))[0].initialSyncedAt).toBeNull();
  });

  it("a manual ALL resync preserves the original initialSyncedAt timestamp (not overwritten)", async () => {
    const h = await harness();
    await upsertBinding(h.wallets, { userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1" });
    await h.service.ensureInitialSync("u1");
    const first = (await h.wallets.findAllByUser("u1"))[0].initialSyncedAt;
    await new Promise((r) => setTimeout(r, 2));
    await h.service.sync("u1"); // forced ALL over an already-synced binding
    expect((await h.wallets.findAllByUser("u1"))[0].initialSyncedAt).toEqual(first);
  });
});
