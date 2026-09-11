import { describe, expect, it, vi } from "vitest";
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
import { OwnWalletLinkingService } from "./own-wallet-linking.service";

// The live bug this covers: an Ethereum tx first normalized as three UNKNOWN legs, then re-normalized
// (Aave netting) into an EXCHANGE swap plus a RECEIVE. Before the purge the dashboard showed the correct
// swap AND two ghost 미분류 rows, because the storage key is (binding, txHash, eventType).
const ALL_HEADS: Record<number, number> = { 1: 100, 8453: 100, 42161: 100, 10: 100, 137: 100 };
const HASH = "0xbde5610f";

const leg = (uniqueId: string, eventType: IndexedTransaction["eventType"], payload: Record<string, unknown>): IndexedTransaction => ({
  source: "alchemy", txHash: `1:${HASH}:${uniqueId}`, chain: "1", eventType,
  occurredAt: new Date("2025-12-03T00:00:00.000Z"),
  payload: { id: `1:${HASH}:${uniqueId}`, chain_id: 1, counterparty: "0xpool", user_override: null, _version: 1, _overrideHistory: [], ...payload },
});

const BEFORE = [
  leg("log:275", "transfer_out", { classification: "UNKNOWN", direction: "OUT", raw_amount: "100" }),
  leg("log:273", "transfer_out", { classification: "UNKNOWN", direction: "OUT", raw_amount: "3" }),
  leg("internal:5", "transfer_in", { classification: "UNKNOWN", direction: "IN", raw_amount: "97" }),
];
const AFTER = [
  leg("log:275", "swap", { classification: "EXCHANGE", direction: "OUT", raw_amount: "97", netted_leg_ids: [`1:${HASH}:log:273`] }),
  leg("internal:5", "transfer_in", { classification: "RECEIVE", direction: "IN", raw_amount: "97", income_kind: null }),
];

class FakeAnchor {
  async get() { return null as never; }
  async markFailed() { /* no anchor bookkeeping in this spec */ }
  async submit() { return null as never; }
}

function harness(batches: IndexedTransaction[][]) {
  let call = 0;
  const scan = async (): Promise<ChainScanResult> => ({ transactions: batches[Math.min(call++, batches.length - 1)], chainHeads: { ...ALL_HEADS } });
  const indexer = { fetchTransactions: vi.fn(scan) } as unknown as ChainIndexer;
  const wallets = new MockWalletRepository();
  const transactions = new MockTransactionRepository();
  const anchor = new FakeAnchor();
  const service = new IndexerService(
    indexer, wallets, transactions, anchor as never, anchor as never, new MockSyncCursorRepository(),
    new PriceEnrichmentService(new MockPriceOracle()),
    new HistoricalPriceEnrichmentService(new MockHistoricalPriceOracle(), new MockHistoricalPriceRepository()),
    new BridgeLinkingService(transactions), new OwnWalletLinkingService(transactions, wallets),
  );
  return { service, wallets, transactions };
}

const keyed = async (transactions: MockTransactionRepository) =>
  (await transactions.listForUser("u1")).map((row) => `${row.txHash}#${row.eventType}`).sort();

describe("IndexerService superseded-row purge", () => {
  it("converges a re-normalized transaction from 3 UNKNOWN rows to exactly the EXCHANGE + RECEIVE pair", async () => {
    const h = harness([BEFORE, AFTER]);
    await h.wallets.upsert({ userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1", verificationMethod: "siwe", verifiedAt: new Date() });

    await h.service.sync("u1");
    expect(await keyed(h.transactions)).toHaveLength(3);

    const result = await h.service.sync("u1");
    expect(await keyed(h.transactions)).toEqual([`1:${HASH}:internal:5#transfer_in`, `1:${HASH}:log:275#swap`]);
    expect(result.skipped.filter((entry) => entry.code === "superseded_purge_failed")).toHaveLength(0);
    const [swap] = (await h.transactions.listForUser("u1")).filter((row) => row.eventType === "swap");
    expect(swap.payload.classification).toBe("EXCHANGE");
  });

  it("reports a purge failure as a skip instead of failing the binding sync", async () => {
    const h = harness([BEFORE, AFTER]);
    await h.wallets.upsert({ userId: "u1", walletAddress: "0xW1", bindingHash: "0xh1", verificationMethod: "siwe", verifiedAt: new Date() });
    await h.service.sync("u1");
    vi.spyOn(h.transactions, "deleteSupersededRows").mockRejectedValueOnce(new Error("db down"));

    const result = await h.service.sync("u1");
    expect(result.skipped.map((entry) => entry.code)).toContain("superseded_purge_failed");
    expect(result.normalized).toBe(2); // the write itself still counted
    vi.restoreAllMocks();
  });
});
