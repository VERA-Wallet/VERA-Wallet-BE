import { describe, expect, it } from "vitest";
import { SyncProgressTracker } from "./sync-progress";

const bindings = [
  { id: "b1", walletAddress: "0xA" },
  { id: "b2", walletAddress: "0xB" },
];

describe("SyncProgressTracker", () => {
  it("registers every binding × chain as pending and emits once on construction", () => {
    const emitted: ReturnType<SyncProgressTracker["snapshot"]>[] = [];
    new SyncProgressTracker(bindings, [1, 8453], (progress) => emitted.push(progress), () => 1_000);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].bindings.map((binding) => binding.bindingId)).toEqual(["b1", "b2"]);
    expect(emitted[0].bindings[1].chains).toEqual([
      { chainId: 1, phase: "pending", fetched: 0, saved: 0 },
      { chainId: 8453, phase: "pending", fetched: 0, saved: 0 },
    ]);
    expect(emitted[0].updatedAt).toBe("1970-01-01T00:00:01.000Z");
  });

  it("emits phase changes immediately but throttles counter-only updates", () => {
    let clock = 0;
    const emitted: number[] = [];
    const tracker = new SyncProgressTracker(bindings, [1], () => emitted.push(clock), () => clock, 250);
    const chain = tracker.chain("b1", 1);
    clock = 10;
    chain.scanning({ phase: "fetching", fetched: 0 }); // 단계 변화 → 즉시
    clock = 20;
    chain.scanning({ phase: "fetching", fetched: 1000 }); // 카운터만 → 250ms 안이라 생략
    clock = 300;
    chain.scanning({ phase: "fetching", fetched: 2000 }); // 간격이 지났다 → 내보냄
    clock = 310;
    chain.scanning({ phase: "tracing", fetched: 2000, traced: { done: 0, total: 40 } }); // 단계 변화 → 즉시
    expect(emitted).toEqual([0, 10, 300, 310]);
    expect(tracker.snapshot().bindings[0].chains[0]).toMatchObject({ phase: "tracing", fetched: 2000, traced: { done: 0, total: 40 } });
  });

  it("walks a chain through pricing → saving → done and keeps a failure's first reason", () => {
    const tracker = new SyncProgressTracker(bindings, [1, 10], undefined, () => 0);
    const chain = tracker.chain("b1", 1);
    chain.pricing(120);
    expect(tracker.snapshot().bindings[0].chains[0]).toMatchObject({ phase: "pricing", fetched: 120 });
    chain.saving(50);
    chain.saving(120);
    expect(tracker.snapshot().bindings[0].chains[0]).toMatchObject({ phase: "saving", saved: 120 });
    chain.done(118);
    expect(tracker.snapshot().bindings[0].chains[0]).toEqual({ chainId: 1, phase: "done", fetched: 118, saved: 118 });
    chain.fail("late failure"); // 끝난 체인은 되돌리지 않는다
    expect(tracker.snapshot().bindings[0].chains[0].phase).toBe("done");

    const other = tracker.chain("b1", 10);
    other.fail("arbitrum-mainnet repeated pageKey (incomplete)");
    other.fail("second reason");
    expect(tracker.snapshot().bindings[0].chains[1]).toMatchObject({ phase: "failed", message: "arbitrum-mainnet repeated pageKey (incomplete)" });
  });

  it("ignores scan callbacks that land after a chain already failed", () => {
    // 추적은 동시에 여러 요청이 돈다. 하나가 429로 체인을 실패시킨 뒤에도 나머지가 마저 끝나며 진척을 부른다 —
    // 그 늦은 보고가 '실패'를 다시 '추적 중'으로 되돌리면 화면은 실패 사유를 단 채 도는 것처럼 보인다.
    const tracker = new SyncProgressTracker(bindings, [42161], undefined, () => 0);
    const chain = tracker.chain("b1", 42161);
    chain.scanning({ phase: "tracing", fetched: 215, traced: { done: 100, total: 232 } });
    chain.fail("arb-mainnet eth_getBalance HTTP 429");
    chain.scanning({ phase: "tracing", fetched: 215, traced: { done: 101, total: 232 } });
    chain.saving(3);
    expect(tracker.snapshot().bindings[0].chains[0]).toMatchObject({ phase: "failed", message: "arb-mainnet eth_getBalance HTTP 429", traced: { done: 100, total: 232 } });
  });

  it("hands out snapshots that later updates do not mutate", () => {
    const tracker = new SyncProgressTracker(bindings, [1], undefined, () => 0);
    const before = tracker.snapshot();
    tracker.chain("b1", 1).scanning({ phase: "tracing", fetched: 5, traced: { done: 1, total: 5 } });
    expect(before.bindings[0].chains[0]).toEqual({ chainId: 1, phase: "pending", fetched: 0, saved: 0 });
  });

  it("attaches an unregistered chain to its binding instead of dropping the report", () => {
    const tracker = new SyncProgressTracker(bindings, [1], undefined, () => 0);
    tracker.chain("b2", 137).scanning({ phase: "fetching", fetched: 3 });
    expect(tracker.snapshot().bindings[1].chains.map((chain) => chain.chainId)).toEqual([1, 137]);
  });
});
