import { describe, it, expect } from "vitest";
import { fileProof, matchesSecret, secretHash, snapshot } from "./report-vc.policy";
import { leafHash, merkleRoot, nodeHash } from "../evidence/evidence.merkle";
const file = { kind: "file", file: "csv", algorithm: "keccak256", hash: "0x" + "a".repeat(64), byteLength: 23 };
const header = { kind: "header", country: "KR", taxYear: 2027, currency: "KRW", totals: { estimatedCharge: "12.34", taxableGains: "100", incomeTotal: "0" } };
const leaves = [header, { kind: "judgment", amount: "100" }, file];
const input = { root: merkleRoot(leaves), countryCode: "KR", taxYear: 2027, holderDid: "did:omn:holder", cxVerifiedAt: new Date(), document: { version: 1, leaves }, anchor: { chain: "1", txHash: "0x" + "b".repeat(64), blockNumber: "100" } };
describe("report VC immutable evidence policy", () => {
  it("retains exact KRW decimals and binds the stored root and holder", () => {
    const result = snapshot(input);
    expect(result.totals.estimatedCharge).toBe("12.34");
    expect(result.evidenceRoot).toBe(merkleRoot(leaves));
    expect(result.files).toEqual([file]);
  });
  it.each([{ root: "0x" + "0".repeat(64) }, { taxYear: 2026 }, { countryCode: "US" }, { holderDid: "browser-text" }])("rejects mismatched evidence metadata %j", patch => {
    expect(() => snapshot({ ...input, ...patch })).toThrow();
  });
  it("does not silently manufacture a missing amount", () => {
    const changed = [{ ...header, totals: { taxableGains: "0" } }, file];
    expect(() => snapshot({ ...input, root: merkleRoot(changed), document: { version: 1, leaves: changed } })).toThrow();
  });
  it("validates a file proof against the exact evidence root, including odd leaves", () => {
    let hash = leafHash(file);
    for (const step of fileProof(leaves, 2)) hash = step.side === "left" ? nodeHash(step.hash, hash) : nodeHash(hash, step.hash);
    expect(hash).toBe(input.root);
    expect(fileProof(leaves, 2)).toHaveLength(1);
    expect(() => fileProof(leaves, 0)).toThrow();
  });
  it("rejects a copied attempt id or malformed browser secret", () => {
    const secret = "a".repeat(64);
    expect(matchesSecret(secret, secretHash(secret))).toBe(true);
    expect(matchesSecret("b".repeat(64), secretHash(secret))).toBe(false);
    expect(matchesSecret("offer-id", secretHash(secret))).toBe(false);
    expect(matchesSecret(null, secretHash(secret))).toBe(false);
  });
});
