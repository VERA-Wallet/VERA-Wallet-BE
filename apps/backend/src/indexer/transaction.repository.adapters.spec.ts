import { describe, expect, it, vi } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { MockTransactionRepository, PrismaTransactionRepository } from "./transaction.repository.adapters";

describe("TransactionRepository contract", () => {
  it("updates normalized fields when a duplicate transaction is synchronized", async () => {
    const repository = new MockTransactionRepository();
    const original: IndexedTransaction = {
      source: "mock", txHash: `0x${"01".repeat(32)}`, chain: "1", eventType: "transfer_in",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"), payload: { fiat_value: "1" },
    };
    const [created] = await repository.save("binding-1", "user-1", [original]);
    const updatedAt = new Date("2025-01-02T00:00:00.000Z");
    const [updated] = await repository.save("binding-1", "user-1", [{ ...original, occurredAt: updatedAt, payload: { fiat_value: "2" } }]);

    expect(updated.id).toBe(created.id);
    expect(updated.occurredAt).toEqual(updatedAt);
    // The provider resync merges in the persisted user-edit fields (all defaults here).
    expect(updated.payload).toEqual({ fiat_value: "2", user_override: null, _version: 1, _overrideHistory: [] });
  });

  it("preserves user override / version / history and the original anchor hash across a resync (AC9)", async () => {
    const repository = new MockTransactionRepository();
    const base: IndexedTransaction = {
      source: "mock", txHash: "0xtx", chain: "1", eventType: "transfer_in",
      occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      payload: { id: "e1", classification: "RECEIVE", raw_amount: "1", user_override: null, _version: 1, _overrideHistory: [], _anchorPayloadHash: "0xorig" },
    };
    await repository.save("b1", "u1", [base]);
    // Simulate a reclassify (mutates classification + user_override + version + history).
    await repository.updatePayload("u1", "e1", {
      id: "e1", classification: "SEND", raw_amount: "1",
      user_override: { classification: "SEND", reason: null, overridden_at: "t" }, _version: 2,
      _overrideHistory: [{ from: "RECEIVE", to: "SEND" }], _anchorPayloadHash: "0xorig",
    });
    // Resync with fresh provider payload: new raw_amount, provider classification, a new anchor hash.
    await repository.save("b1", "u1", [{ ...base, payload: { id: "e1", classification: "RECEIVE", raw_amount: "2", user_override: null, _version: 1, _overrideHistory: [], _anchorPayloadHash: "0xnew" } }]);
    const [row] = await repository.listForUser("u1");
    expect(row.payload.classification).toBe("SEND"); // user's classification kept
    expect(row.payload._version).toBe(2);
    expect(row.payload._overrideHistory).toEqual([{ from: "RECEIVE", to: "SEND" }]);
    expect(row.payload._anchorPayloadHash).toBe("0xorig"); // NOT re-anchored
    expect(row.payload.raw_amount).toBe("2"); // provider field updated
  });
});

// ---------------------------------------------------------------------------
// Superseded-row purge (a re-sync must CONVERGE, not accumulate ghost rows)
// ---------------------------------------------------------------------------

const HASH = "0xbde5610f";
const leg = (uniqueId: string, eventType: IndexedTransaction["eventType"], payload: Record<string, unknown> = {}): IndexedTransaction => ({
  source: "alchemy", txHash: `1:${HASH}:${uniqueId}`, chain: "1", eventType,
  occurredAt: new Date("2025-12-03T00:00:00.000Z"),
  payload: { id: `1:${HASH}:${uniqueId}`, classification: "UNKNOWN", user_override: null, _version: 1, _overrideHistory: [], ...payload },
});
const emit = (item: IndexedTransaction) => ({
  id: item.txHash,
  eventType: item.eventType,
  nettedLegIds: Array.isArray(item.payload.netted_leg_ids) ? item.payload.netted_leg_ids.map(String) : [],
});
const keyed = async (repository: MockTransactionRepository, userId = "u1") =>
  (await repository.listForUser(userId)).map((row) => `${row.txHash}#${row.eventType}`).sort();

describe("superseded-row purge", () => {
  it("removes the row a leg moved away from when re-normalization changes its eventType", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:275", "transfer_out")]);
    const moved = leg("log:275", "swap", { classification: "EXCHANGE" });
    await repository.save("b1", "u1", [moved]);
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:275#swap`, `1:${HASH}:log:275#transfer_out`]);

    const result = await repository.deleteSupersededRows("b1", "u1", [emit(moved)]);
    expect(result).toEqual({ deleted: 1, carriedOverrides: 0, preserved: [] });
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:275#swap`]);
  });

  it("removes a leg that was netted into another row (netted_leg_ids)", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:275", "transfer_out"), leg("log:273", "transfer_out")]);
    const netted = leg("log:275", "swap", { classification: "EXCHANGE", netted_leg_ids: [`1:${HASH}:log:273`] });
    await repository.save("b1", "u1", [netted]);

    const result = await repository.deleteSupersededRows("b1", "u1", [emit(netted)]);
    expect(result.deleted).toBe(2); // the moved row AND the absorbed leg
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:275#swap`]);
  });

  it("carries a user override forward onto the leg's new row instead of dropping the edit", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:275", "transfer_out", { _anchorPayloadHash: "0xorig" })]);
    await repository.updatePayload("u1", `1:${HASH}:log:275`, {
      id: `1:${HASH}:log:275`, classification: "GIFT", _anchorPayloadHash: "0xorig",
      user_override: { classification: "GIFT", reason: "선물", overridden_at: "t" },
      _version: 2, _overrideHistory: [{ from: "UNKNOWN", to: "GIFT" }],
    });
    const moved = leg("log:275", "swap", { classification: "EXCHANGE", raw_amount: "42", _anchorPayloadHash: "0xnew" });
    await repository.save("b1", "u1", [moved]);

    const result = await repository.deleteSupersededRows("b1", "u1", [emit(moved)]);
    expect(result).toEqual({ deleted: 1, carriedOverrides: 1, preserved: [] });
    const rows = await repository.listForUser("u1");
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe("swap"); // the leg lives in its new row
    expect(rows[0].payload.classification).toBe("GIFT"); // the user's decision followed it
    expect(rows[0].payload._version).toBe(2);
    expect(rows[0].payload._overrideHistory).toEqual([{ from: "UNKNOWN", to: "GIFT" }]);
    expect(rows[0].payload._anchorPayloadHash).toBe("0xorig"); // never re-anchored
    expect(rows[0].payload.raw_amount).toBe("42"); // provider fields still refreshed
  });

  it("never deletes a user-edited leg that was absorbed into another row; it reports it instead", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:273", "transfer_out")]);
    await repository.updatePayload("u1", `1:${HASH}:log:273`, {
      id: `1:${HASH}:log:273`, classification: "GIFT",
      user_override: { classification: "GIFT", reason: null, overridden_at: "t" }, _version: 2, _overrideHistory: [],
    });
    const netted = leg("log:275", "swap", { classification: "EXCHANGE", netted_leg_ids: [`1:${HASH}:log:273`] });
    await repository.save("b1", "u1", [netted]);

    const result = await repository.deleteSupersededRows("b1", "u1", [emit(netted)]);
    expect(result.deleted).toBe(0);
    expect(result.preserved).toEqual([`1:${HASH}:log:273#transfer_out`]);
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:273#transfer_out`, `1:${HASH}:log:275#swap`]);
  });

  it("leaves other bindings and other transactions alone", async () => {
    const repository = new MockTransactionRepository();
    const other = { ...leg("log:275", "transfer_out"), txHash: `1:0xother:log:1`, payload: { id: "1:0xother:log:1" } };
    await repository.save("b1", "u1", [leg("log:275", "transfer_out"), other]);
    await repository.save("b2", "u2", [leg("log:275", "transfer_out")]);
    const moved = leg("log:275", "swap", { classification: "EXCHANGE" });
    await repository.save("b1", "u1", [moved]);

    await repository.deleteSupersededRows("b1", "u1", [emit(moved)]);
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:275#swap`, "1:0xother:log:1#transfer_out"]);
    expect(await keyed(repository, "u2")).toEqual([`1:${HASH}:log:275#transfer_out`]); // the other binding is untouched
  });

  it("is a no-op on a second identical run (the ledger has converged)", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:275", "transfer_out")]);
    const moved = leg("log:275", "swap", { classification: "EXCHANGE", netted_leg_ids: [`1:${HASH}:log:273`] });
    await repository.save("b1", "u1", [moved]);
    await repository.deleteSupersededRows("b1", "u1", [emit(moved)]);

    const second = await repository.deleteSupersededRows("b1", "u1", [emit(moved)]);
    expect(second).toEqual({ deleted: 0, carriedOverrides: 0, preserved: [] });
    expect(await keyed(repository)).toEqual([`1:${HASH}:log:275#swap`]);
  });

  it("does nothing when a fetch produced no rows at all (a partial fetch must never wipe history)", async () => {
    const repository = new MockTransactionRepository();
    await repository.save("b1", "u1", [leg("log:275", "transfer_out"), leg("log:273", "transfer_out")]);
    const result = await repository.deleteSupersededRows("b1", "u1", []);
    expect(result.deleted).toBe(0);
    expect(await keyed(repository)).toHaveLength(2);
  });
});

describe("PrismaTransactionRepository purge (SQL shape)", () => {
  // The rules themselves are covered above through the in-memory adapter; what matters here is the
  // statement shape: the TaxEvent children must go BEFORE their parent rows, in one transaction, and
  // TransactionRaw / AnchorRecord must never be touched.
  function fakePrisma(rows: { id: string; txHash: string; eventType: string; payload: Record<string, unknown> }[]) {
    const calls: string[] = [];
    const prisma = {
      transactionNormalized: {
        findMany: vi.fn(async ({ where }: { where: { txHash: { in: string[] } } }) => rows.filter((row) => where.txHash.in.includes(row.txHash))),
        update: vi.fn((args: unknown) => { calls.push("update:normalized"); return args; }),
        deleteMany: vi.fn((args: { where: { id: { in: string[] } } }) => { calls.push(`delete:normalized:${args.where.id.in.join(",")}`); return args; }),
      },
      taxEvent: {
        count: vi.fn(async () => 0),
        deleteMany: vi.fn((args: { where: { txId: { in: string[] } } }) => { calls.push(`delete:taxEvent:${args.where.txId.in.join(",")}`); return args; }),
      },
      $transaction: vi.fn(async (operations: unknown[]) => operations),
    };
    return { prisma, calls };
  }

  it("deletes tax events before their transaction rows inside one transaction", async () => {
    const stale = { id: "row-stale", txHash: `1:${HASH}:log:275`, eventType: "transfer_out", payload: { user_override: null } };
    const survivor = { id: "row-new", txHash: `1:${HASH}:log:275`, eventType: "swap", payload: { user_override: null } };
    const { prisma, calls } = fakePrisma([stale, survivor]);
    const repository = new PrismaTransactionRepository(prisma as never);

    const result = await repository.deleteSupersededRows("b1", "u1", [{ id: `1:${HASH}:log:275`, eventType: "swap", nettedLegIds: [] }]);

    expect(result.deleted).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["delete:taxEvent:row-stale", "delete:normalized:row-stale"]);
  });

  it("issues no statements at all when nothing was superseded", async () => {
    const survivor = { id: "row-new", txHash: `1:${HASH}:log:275`, eventType: "swap", payload: { user_override: null } };
    const { prisma } = fakePrisma([survivor]);
    const repository = new PrismaTransactionRepository(prisma as never);

    const result = await repository.deleteSupersededRows("b1", "u1", [{ id: `1:${HASH}:log:275`, eventType: "swap", nettedLegIds: [] }]);
    expect(result).toEqual({ deleted: 0, carriedOverrides: 0, preserved: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.taxEvent.count).not.toHaveBeenCalled();
  });
});
