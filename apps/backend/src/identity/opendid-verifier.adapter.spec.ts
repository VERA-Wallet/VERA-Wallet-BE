import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenDidVerifierAdapter } from "./opendid-verifier.adapter";

const settings = { IDENTITY_PROVIDER: "opendid", OPENDID_SUBJECT_BINDINGS: JSON.stringify({ "opaque-person-1": "did:omn:holder" }), OPENDID_VERIFIER_URL: "http://verifier:8092/verifier/", OPENDID_POLICY_ID: "policy", OPENDID_SUBJECT_CLAIM_CODE: "subjectId", OPENDID_TRUSTED_ISSUER_ID: "did:issuer" };
const claim = { code: "subjectId", value: "opaque-person-1", type: "text", format: "plain", hideValue: false };
const verified = { holder: "did:omn:holder", result: true, issuer: "did:issuer", claims: [claim] };
const adapter = (extra = {}) => new OpenDidVerifierAdapter(new ConfigService({ ...settings, ...extra }));
function reply(body: unknown, status = 200) { const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })); vi.stubGlobal("fetch", fetch); return fetch; }
afterEach(() => vi.unstubAllGlobals());

describe("OpenDidVerifierAdapter", () => {
  it("uses exactly one context prefix and passes the payload through", async () => {
    const payload = { offerId: "offer", type: "VerifyOffer", mode: "Direct", device: "PC", service: "login", endpoints: ["http://lan:8092/verifier"], locked: false, validUntil: new Date(Date.now() + 60000).toISOString() };
    const fetch = reply({ txId: "transaction", payload });
    const result = await adapter().requestVerification("message");
    expect(fetch).toHaveBeenCalledWith("http://verifier:8092/verifier/api/v1/request-offer-qr", expect.objectContaining({ body: JSON.stringify({ id: "message", policyId: "policy" }), redirect: "error" }));
    expect(result.qrPayload).toEqual(payload);
    expect(result.offerId).toBe("offer");
  });
  it("recognizes the pinned upstream's no-submission response as pending", async () => {
    reply({ result: false, vc: null, issuer: null, claims: null });
    expect(await adapter().checkVerification("offer")).toEqual({ status: "pending" });
  });
  it("uses the stable subject rather than changing credential IDs", async () => {
    reply({ ...verified, vc: "first" }); const first = await adapter().checkVerification("a");
    reply({ ...verified, vc: "reissued" }); const second = await adapter().checkVerification("b");
    expect(first).toMatchObject({ status: "verified", identity: { method: "opendid", didHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) } });
    if (first.status === "verified" && second.status === "verified") expect(first.identity.didHash).toBe(second.identity.didHash);
    reply({ ...verified, claims: [{ ...claim, value: "another-person" }] });
    const other = await adapter().checkVerification("c");
    if (first.status === "verified" && other.status === "verified") expect(other.identity.didHash).not.toBe(first.identity.didHash);
  });
  it.each([
    { result: true, claims: [claim] },
    { ...verified, issuer: "did:untrusted" },
    { ...verified, claims: [] },
    { ...verified, claims: [claim, claim] },
    { ...verified, claims: [{ ...claim, value: 123 }] },
    { ...verified, claims: [{ ...claim, hideValue: true }] },
  ])("rejects invalid identity evidence: %j", async body => {
    reply(body); expect(await adapter().checkVerification("offer")).toEqual({ status: "rejected" });
  });
  it("requires explicit policy trust for upstream servers that omit issuer", async () => {
    expect(() => adapter({ OPENDID_ISSUER_BINDING: "policy" })).toThrow(/CONFIRMED/);
    const a = adapter({ OPENDID_ISSUER_BINDING: "policy", OPENDID_POLICY_ISSUER_RESTRICTION_CONFIRMED: "true" });
    reply({ result: true, holder: "did:omn:holder", claims: [claim] }); expect(await a.checkVerification("offer")).toMatchObject({ status: "verified" });
    reply({ ...verified, issuer: "did:wrong" }); expect(await a.checkVerification("offer")).toEqual({ status: "rejected" });
  });
  it.each([null, {}, { result: "true", claims: [] }, { result: true }])("fails closed on malformed results: %j", async body => {
    reply(body); await expect(adapter().checkVerification("offer")).rejects.toMatchObject({ status: 503 });
  });
  it("distinguishes upstream expiry and errors without leaking response text", async () => {
    reply({ code: "SSRVVRF00302" }, 400); expect(await adapter().checkVerification("offer")).toEqual({ status: "expired" });
    reply({ code: "SSRVVRF00202" }, 500); expect(await adapter().checkVerification("offer")).toEqual({ status: "rejected" });
    reply({ code: "unknown", message: "sensitive" }, 500); await expect(adapter().checkVerification("offer")).rejects.toMatchObject({ status: 503, message: "Open DID verification is unavailable." });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret"))); await expect(adapter().checkVerification("offer")).rejects.toMatchObject({ status: 503 });
  });
  it("rejects token callback and invalid configuration", async () => {
    await expect(adapter().handleCallback("offer")).rejects.toMatchObject({ status: 401 });
    for (const url of ["http://host:8092", "http://host/verifier/verifier", "ftp://host/verifier", "http://host/verifier?secret=x"]) expect(() => adapter({ OPENDID_VERIFIER_URL: url })).toThrow();
    expect(() => adapter({ OPENDID_POLICY_ID: "" })).toThrow();
  });
  it("rejects a copied subject issued to another holder", async () => {
    reply({ ...verified, holder: "did:attacker" });
    expect(await adapter().checkVerification("offer")).toEqual({ status: "rejected" });
    reply({ ...verified, holder: undefined });
    expect(await adapter().checkVerification("offer")).toEqual({ status: "rejected" });
    reply({ ...verified, claims: [{ ...claim, value: "unregistered" }] });
    expect(await adapter().checkVerification("offer")).toEqual({ status: "rejected" });
  });
});
