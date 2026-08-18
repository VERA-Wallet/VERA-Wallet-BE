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
    expect(updated.payload).toEqual({ fiat_value: "2" });
  });
});
