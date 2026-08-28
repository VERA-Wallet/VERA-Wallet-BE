import { describe, expect, it } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { MockTransactionRepository } from "./transaction.repository.adapters";

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
