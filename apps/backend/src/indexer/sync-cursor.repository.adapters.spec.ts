import { describe, expect, it } from "vitest";
import { MockSyncCursorRepository } from "./sync-cursor.repository.adapters";

describe("MockSyncCursorRepository", () => {
  it("advances monotonically and never lowers a stored head", async () => {
    const repo = new MockSyncCursorRepository();
    await repo.advance("b1", 1, 100n, 1);
    await repo.advance("b1", 1, 50n, 1); // out-of-order lower head -> ignored
    expect((await repo.listForBinding("b1"))[0]).toEqual({ chainId: 1, lastSyncedBlock: 100n, rulesVersion: 1 });
    await repo.advance("b1", 1, 150n, 1); // higher -> raises
    expect((await repo.listForBinding("b1"))[0].lastSyncedBlock).toBe(150n);
  });

  it("keeps the rules version monotonic on its own: an older version never rolls back, a newer one lands without a higher head", async () => {
    const repo = new MockSyncCursorRepository();
    await repo.advance("b1", 1, 100n, 2);
    await repo.advance("b1", 1, 120n, 1); // 늦게 끝난 옛 규칙의 걷기 — 블록은 올라가되 버전은 내려가지 않는다
    expect((await repo.listForBinding("b1"))[0]).toEqual({ chainId: 1, lastSyncedBlock: 120n, rulesVersion: 2 });
    await repo.advance("b1", 1, 100n, 3); // 새 규칙으로 다시 걸었는데 헤드가 같다 — 버전만 올라간다
    expect((await repo.listForBinding("b1"))[0]).toEqual({ chainId: 1, lastSyncedBlock: 120n, rulesVersion: 3 });
  });

  it("isolates cursors per binding and per chain", async () => {
    const repo = new MockSyncCursorRepository();
    await repo.advance("b1", 1, 10n, 1);
    await repo.advance("b1", 8453, 20n, 1);
    await repo.advance("b2", 1, 30n, 1);
    expect((await repo.listForBinding("b1")).sort((a, b) => a.chainId - b.chainId)).toEqual([
      { chainId: 1, lastSyncedBlock: 10n, rulesVersion: 1 },
      { chainId: 8453, lastSyncedBlock: 20n, rulesVersion: 1 },
    ]);
    expect(await repo.listForBinding("b2")).toEqual([{ chainId: 1, lastSyncedBlock: 30n, rulesVersion: 1 }]);
  });
});
