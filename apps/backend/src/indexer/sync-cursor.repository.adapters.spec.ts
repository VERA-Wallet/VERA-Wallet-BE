import { describe, expect, it } from "vitest";
import { MockSyncCursorRepository } from "./sync-cursor.repository.adapters";

describe("MockSyncCursorRepository", () => {
  it("advances monotonically and never lowers a stored head", async () => {
    const repo = new MockSyncCursorRepository();
    await repo.advance("b1", 1, 100n);
    await repo.advance("b1", 1, 50n); // out-of-order lower head -> ignored
    expect((await repo.listForBinding("b1"))[0]).toEqual({ chainId: 1, lastSyncedBlock: 100n });
    await repo.advance("b1", 1, 150n); // higher -> raises
    expect((await repo.listForBinding("b1"))[0].lastSyncedBlock).toBe(150n);
  });

  it("isolates cursors per binding and per chain", async () => {
    const repo = new MockSyncCursorRepository();
    await repo.advance("b1", 1, 10n);
    await repo.advance("b1", 8453, 20n);
    await repo.advance("b2", 1, 30n);
    expect((await repo.listForBinding("b1")).sort((a, b) => a.chainId - b.chainId)).toEqual([
      { chainId: 1, lastSyncedBlock: 10n },
      { chainId: 8453, lastSyncedBlock: 20n },
    ]);
    expect(await repo.listForBinding("b2")).toEqual([{ chainId: 1, lastSyncedBlock: 30n }]);
  });
});
