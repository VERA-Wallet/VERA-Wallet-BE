import { createHash, timingSafeEqual } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { leafHash, merkleRoot, nodeHash } from "../evidence/evidence.merkle";
import type { Hex } from "viem";

export function reject(code: string, status = 409): never {
  throw new HttpException({ code, message: code }, status);
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function secretHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function matchesSecret(secret: unknown, expected: string): boolean {
  return typeof secret === "string" && /^[a-f0-9]{64}$/.test(secret) && /^[a-f0-9]{64}$/.test(expected) &&
    timingSafeEqual(Buffer.from(secretHash(secret), "hex"), Buffer.from(expected, "hex"));
}
export type ReportSnapshot = {
  evidenceRoot: string; countryCode: string; taxYear: number; holderDid: string;
  cxVerifiedAt: string; anchor: { chain: string; txHash: string; blockNumber: string };
  totals: { currency: "KRW"; estimatedCharge: string; taxableGains: string; incomeTotal: string };
  files: Record<string, unknown>[];
  disclaimer: "estimated_tax_report";
};
export function snapshot(input: {
  root: string; countryCode: string; taxYear: number; holderDid: string; cxVerifiedAt: Date;
  document: unknown; anchor: { chain: string; txHash: string; blockNumber: string };
}): ReportSnapshot {
  if (!/^did:[a-z0-9]+:.+$/.test(input.holderDid)) reject("invalid_holder", 400);
  const doc = input.document;
  if (!object(doc) || doc.version !== 1 || !Array.isArray(doc.leaves) || !doc.leaves.length || doc.leaves.length > 50_000 || !doc.leaves.every(object)) reject("invalid_evidence", 400);
  const header = doc.leaves[0];
  if (merkleRoot(doc.leaves).toLowerCase() !== input.root.toLowerCase() || header.kind !== "header" ||
      header.country !== input.countryCode || header.taxYear !== input.taxYear || header.currency !== "KRW" || !object(header.totals)) reject("invalid_evidence", 400);
  const totals = header.totals;
  for (const key of ["estimatedCharge", "taxableGains", "incomeTotal"]) {
    if (typeof totals[key] !== "string" || !/^-?\d+(\.\d+)?$/.test(totals[key] as string)) reject("invalid_evidence", 400);
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(input.anchor.txHash) || !/^\d+$/.test(input.anchor.blockNumber)) reject("evidence_not_anchored");
  return {
    evidenceRoot: input.root, countryCode: input.countryCode, taxYear: input.taxYear,
    holderDid: input.holderDid, cxVerifiedAt: input.cxVerifiedAt.toISOString(), anchor: input.anchor,
    totals: { currency: "KRW", estimatedCharge: totals.estimatedCharge as string, taxableGains: totals.taxableGains as string, incomeTotal: totals.incomeTotal as string },
    files: doc.leaves.filter(leaf => leaf.kind === "file"), disclaimer: "estimated_tax_report",
  };
}
/** File proof discloses only the selected file leaf and sibling hashes, never transaction/header leaves. */
export function fileProof(leaves: Record<string, unknown>[], index: number) {
  if (index < 0 || index >= leaves.length || leaves[index].kind !== "file") reject("invalid_file_leaf", 400);
  const proof: { side: "left" | "right"; hash: Hex }[] = [];
  let level = leaves.map(leafHash), cursor = index;
  while (level.length > 1) {
    const sibling = cursor % 2 ? cursor - 1 : cursor + 1;
    if (sibling < level.length) proof.push({ side: cursor % 2 ? "left" : "right", hash: level[sibling] });
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i]);
    level = next; cursor = Math.floor(cursor / 2);
  }
  return proof;
}
