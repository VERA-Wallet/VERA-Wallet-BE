import { describe, expect, it } from "vitest";
import type { AnchorReceipt, AnchorType, EvidenceAnchor } from "@vera/interfaces";
import { AnchorProcessor } from "./anchor.queue";
import { AnchorService } from "./anchor.service";
import { MockAnchorRepository } from "./anchor.repository.adapters";

/** 호출 횟수를 세는 체인 어댑터. 재시도가 그대로 새 트랜잭션이 되는지 보기 위한 것이다. */
class CountingAnchor implements EvidenceAnchor {
  calls = 0;
  async anchor(): Promise<AnchorReceipt> {
    this.calls += 1;
    return { txHash: `0x${String(this.calls).padStart(64, "0")}`, blockNumber: BigInt(100 + this.calls), anchoredAt: new Date() };
  }
  async verify() { return true; }
  /** 이 더미는 조회 대상이 아니다 — 멱등성 테스트는 anchor 호출 횟수만 본다. */
  async inspect() { return null; }
}

const HASH = `0x${"ab".repeat(32)}`;
const TYPE: AnchorType = "rule_version";

describe("앵커 멱등성", () => {
  it("이미 올라간 해시는 체인을 다시 건드리지 않는다", async () => {
    const adapter = new CountingAnchor();
    const service = new AnchorService(adapter, new MockAnchorRepository());
    await service.prepare(HASH, TYPE);

    const first = await service.process(HASH, TYPE);
    const second = await service.process(HASH, TYPE);

    expect(adapter.calls).toBe(1);
    // 두 번째 호출도 같은 영수증을 돌려준다 — 저장된 tx 해시가 재시도마다 바뀌면 사용자가 받아 둔 링크가 낡는다.
    expect(second).toEqual(first);
    expect((await service.get(HASH))?.chainTxHash).toBe(first.txHash);
  });

  it("아직 안 올라간 해시는 올린다", async () => {
    const adapter = new CountingAnchor();
    const service = new AnchorService(adapter, new MockAnchorRepository());
    await service.prepare(HASH, TYPE);
    await service.process(HASH, TYPE);
    expect(adapter.calls).toBe(1);
    expect((await service.get(HASH))?.status).toBe("anchored");
  });

  it("큐 작업은 영수증을 반환하지 않는다 — bigint는 Bull이 JSON으로 저장하지 못한다", async () => {
    const adapter = new CountingAnchor();
    const service = new AnchorService(adapter, new MockAnchorRepository());
    await service.prepare(HASH, TYPE);

    const returned = await new AnchorProcessor(service).process({ data: { payloadHash: HASH, type: TYPE } } as never);

    expect(returned).toBeUndefined();
    // 실제로 Bull이 하는 일: 반환값을 JSON으로 저장한다. bigint가 섞이면 여기서 던지고 성공한 작업이 실패가 된다.
    expect(() => JSON.stringify(returned)).not.toThrow();
    expect(() => JSON.stringify({ blockNumber: 1n })).toThrow(/BigInt/);
  });
});
