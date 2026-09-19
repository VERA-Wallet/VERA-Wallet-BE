import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson, leafHash, merkleRoot } from "./evidence.merkle";

/**
 * FE(`lib/tax/evidence.ts`)와 **같은 루트**를 내는지 고정한다.
 *
 * 벡터는 FE가 만들고 이 저장소로 복사한다(`UPDATE_EVIDENCE_VECTOR=1`). 규칙을 한쪽만 고치면
 * 여기서 먼저 빨개진다 — 그래야 아무도 재현할 수 없는 해시가 체인에 올라가지 않는다.
 */
const vector = JSON.parse(readFileSync(join(process.cwd(), "test/fixtures/evidence-vector.json"), "utf8")) as {
  merkleRoot: string;
  leafHashes: string[];
  leaves: unknown[];
};

describe("evidence merkle (FE/BE 공유 규칙)", () => {
  it("공유 벡터의 잎 해시를 그대로 낸다", () => {
    expect(vector.leaves.map(leafHash)).toEqual(vector.leafHashes);
  });

  it("공유 벡터의 루트를 그대로 낸다", () => {
    expect(merkleRoot(vector.leaves)).toBe(vector.merkleRoot);
  });

  it("잎 하나만 바뀌어도 루트가 달라진다", () => {
    const [head, ...rest] = vector.leaves as Record<string, unknown>[];
    expect(merkleRoot([{ ...head, taxYear: 9999 }, ...rest])).not.toBe(vector.merkleRoot);
  });

  it("홀수로 남은 노드를 복제하지 않는다 — 복제하면 잎 3개와 4개가 같은 루트를 낼 수 있다", () => {
    const [a, b, c] = vector.leaves;
    expect(merkleRoot([a, b, c])).not.toBe(merkleRoot([a, b, c, c]));
  });

  it("판정이 없어도 루트가 있다", () => {
    expect(merkleRoot([])).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("정본 직렬화가 키 순서를 세우고 null 칸을 버린다", () => {
    expect(canonicalJson({ b: "2", a: "1", n: null })).toBe('{"a":"1","b":"2"}');
    expect(() => canonicalJson({ amount: 1.5 })).toThrow(/integers/);
  });
});
