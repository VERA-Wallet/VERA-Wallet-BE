import { describe, expect, it, vi } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import { CachedTransactionRepository, MockTransactionRepository } from "./transaction.repository.adapters";

const item = (txHash: string): IndexedTransaction => ({
  source: "mock",
  txHash,
  chain: "1",
  eventType: "transfer_in",
  occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  payload: { id: `${txHash}:0`, classification: "RECEIVE" },
});

function harness(ttlMs = 60_000) {
  const inner = new MockTransactionRepository();
  const listSpy = vi.spyOn(inner, "listForUser");
  let now = 1_000;
  const cache = new CachedTransactionRepository(inner, ttlMs, () => now);
  return { inner, cache, listSpy, tick: (ms: number) => { now += ms; } };
}

describe("CachedTransactionRepository", () => {
  it("serves repeated reads from one DB read and returns the same array instance", async () => {
    const h = await harness();
    await h.cache.save("b1", "u1", [item("0xa")]);
    const first = await h.cache.listForUser("u1");
    const second = await h.cache.listForUser("u1");
    expect(second).toBe(first);
    expect(h.listSpy).toHaveBeenCalledTimes(1);
    expect(await h.cache.findForUser("u1", "0xa:0")).not.toBeNull();
    expect(h.listSpy).toHaveBeenCalledTimes(1);
  });

  it("invalidates the user's snapshot on save and on updatePayload so reads never lag a write", async () => {
    const h = await harness();
    await h.cache.save("b1", "u1", [item("0xa")]);
    await h.cache.listForUser("u1");
    await h.cache.save("b1", "u1", [item("0xb")]);
    expect((await h.cache.listForUser("u1")).map((row) => row.txHash)).toEqual(["0xa", "0xb"]);
    const row = (await h.cache.listForUser("u1"))[0];
    await h.cache.updatePayload("u1", row.id, { ...row.payload, classification: "SEND" });
    expect((await h.cache.listForUser("u1"))[0].payload.classification).toBe("SEND");
    // 무효화 뒤 첫 읽기만 저장소를 두드리고 그다음 읽기는 스냅샷을 쓴다(inner 자체의 내부 읽기 횟수는 세지 않는다).
    const before = h.listSpy.mock.calls.length;
    await h.cache.listForUser("u1");
    await h.cache.listForUser("u1");
    expect(h.listSpy.mock.calls.length - before).toBe(0);
  });

  it("does not leak one user's invalidation into another user's snapshot", async () => {
    const h = await harness();
    await h.cache.save("b1", "u1", [item("0xa")]);
    await h.cache.save("b2", "u2", [item("0xc")]);
    const u2 = await h.cache.listForUser("u2");
    await h.cache.save("b1", "u1", [item("0xb")]);
    expect(await h.cache.listForUser("u2")).toBe(u2);
  });

  it("expires a snapshot after the TTL as a safety net", async () => {
    const h = await harness(1_000);
    await h.cache.save("b1", "u1", [item("0xa")]);
    await h.cache.listForUser("u1");
    h.tick(999);
    await h.cache.listForUser("u1");
    expect(h.listSpy).toHaveBeenCalledTimes(1);
    h.tick(2);
    await h.cache.listForUser("u1");
    expect(h.listSpy).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent cold reads into one DB read", async () => {
    const h = await harness();
    await h.cache.save("b1", "u1", [item("0xa")]);
    const [a, b] = await Promise.all([h.cache.listForUser("u1"), h.cache.listForUser("u1")]);
    expect(a).toBe(b);
    expect(h.listSpy).toHaveBeenCalledTimes(1);
  });
});
