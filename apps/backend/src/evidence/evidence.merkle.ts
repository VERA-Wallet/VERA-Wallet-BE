import { concat, keccak256, toBytes, toHex } from "viem";
import type { Hex } from "viem";

/**
 * 계산 근거 정본의 머클 규칙 — FE `lib/tax/evidence.ts`의 **거울**이다.
 *
 * FE가 계산 주체이지만 앵커는 서버가 책임진다: FE가 올린 문서를 그대로 믿고 해시를 받는 게 아니라,
 * 서버가 잎에서 루트를 **다시 계산**해 체인에 올린다. 그래서 두 구현이 한 글자라도 갈리면
 * "무엇을 봉인했는가"가 흔들린다 — `test/fixtures/evidence-vector.json`(FE가 생성)이 그 경계를 지킨다.
 *
 * 규칙(FE 주석과 동일):
 * 1. 정본 JSON — 키 오름차순, 공백 없음, undefined·null 값의 키는 버린다, 수는 정수만.
 * 2. 잎   = keccak256("VW-EVIDENCE-LEAF-v1:" ++ 정본JSON)
 * 3. 노드 = keccak256("VW-EVIDENCE-NODE-v1:" ++ 왼쪽 ++ 오른쪽)
 * 4. 홀수로 남은 노드는 복제하지 않고 그대로 올린다.
 * 5. 잎 0번은 헤더(귀속연도·국가·totals)다.
 */

const LEAF_TAG = "VW-EVIDENCE-LEAF-v1:";
const NODE_TAG = "VW-EVIDENCE-NODE-v1:";
const EMPTY_TAG = "VW-EVIDENCE-EMPTY-v1";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new Error(`Canonical evidence numbers must be integers: ${value}`);
    return String(value);
  }
  return JSON.stringify(value) ?? "null";
}

export function leafHash(leaf: unknown): Hex {
  return keccak256(toBytes(LEAF_TAG + canonicalJson(leaf)));
}

export function nodeHash(left: Hex, right: Hex): Hex {
  return keccak256(concat([toHex(toBytes(NODE_TAG)), left, right]));
}

export function merkleRoot(leaves: readonly unknown[]): Hex {
  if (leaves.length === 0) return keccak256(toBytes(EMPTY_TAG));
  let level = leaves.map(leafHash);
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length ? nodeHash(level[index], level[index + 1]) : level[index]);
    }
    level = next;
  }
  return level[0];
}
