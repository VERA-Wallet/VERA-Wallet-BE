import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { ReportVcService } from "./report-vc.service";
import type { ReportVcStore } from "./report-vc.store";
import type { ReportVcGateway } from "./report-vc.gateway";
import type { AnchorQueryPort } from "../anchor/anchor.port";
import { secretHash } from "./report-vc.policy";
const secret = "a".repeat(64);
const configuration = { REPORT_VC_ENABLED: "true", MOCK_MODE: "false", PERSISTENCE: "prisma", JWT_SECRET: "k".repeat(40), FRONTEND_ORIGIN: "https://vera.test", REPORT_VC_ISSUER_DID: "did:omn:issuer" };
const store = { cx: vi.fn(), wallet: vi.fn(), attempt: vi.fn(), acquire: vi.fn(), release: vi.fn(), complete: vi.fn(), cancel: vi.fn(), credential: vi.fn(), evidence: vi.fn(), latestEvidence: vi.fn() };
const gateway = { ready: vi.fn(), call: vi.fn() };
const anchors = { inspect: vi.fn() };
const req = (cookie = secret) => ({ cookies: { vw_vc_link_attempt: cookie, vw_vc_issue_attempt: cookie, vw_vc_verify_attempt: cookie }, headers: { origin: "https://vera.test" } }) as unknown as Request;
const res = () => ({ status: vi.fn().mockReturnThis(), cookie: vi.fn() }) as unknown as Response;
let service: ReportVcService;
function attempt(purpose = "link") {
  return { id: "attempt", purpose, userId: purpose === "verify" ? null : "user", status: "pending", expiresAt: new Date(Date.now() + 60000), upstreamId: "offer",
    secretHash: secretHash(secret), snapshot: { cxVerifiedAt: new Date().toISOString(), countryCode: "KR", taxYear: 2027 }, holderDid: "did:omn:holder", evidenceRoot: "root", createdAt: new Date() };
}
beforeEach(() => {
  vi.resetAllMocks(); service = new ReportVcService(new ConfigService(configuration), store as unknown as ReportVcStore, gateway as unknown as ReportVcGateway, anchors as unknown as AnchorQueryPort);
  store.cx.mockResolvedValue({ verifiedAt: new Date() }); store.acquire.mockResolvedValue(true); store.attempt.mockResolvedValue(attempt());
});
describe("report VC account and browser boundaries", () => {
  it("does not advertise a missing protected issuer", async () => {
    gateway.ready.mockRejectedValue(new Error("offline")); expect((await service.capabilities()).enabled).toBe(false);
  });
  it("does not accept a mock or DID-only account as CX verified", async () => {
    store.cx.mockResolvedValue(null); await expect(service.wallet("user")).rejects.toThrow("cx_verification_required");
  });
  it("requires recent CX authentication before linking", async () => {
    store.cx.mockResolvedValue({ verifiedAt: new Date(0) }); await expect(service.link("user", res())).rejects.toThrow("cx_reauthentication_required");
  });
  it("rejects a foreign origin", () => {
    expect(() => service.origin({ headers: { origin: "https://foreign.test" } } as Request)).toThrow("origin_rejected");
  });
  it("rejects a different browser even with the same attempt id", async () => {
    await expect(service.poll("attempt", "link", "user", req("b".repeat(64)), res())).rejects.toThrow("attempt_not_bound"); expect(gateway.call).not.toHaveBeenCalled();
  });
  it("rejects a different account or operation purpose", async () => {
    await expect(service.bound("attempt", "link", "other", req())).rejects.toThrow("attempt_not_found");
    await expect(service.bound("attempt", "issue", "user", req())).rejects.toThrow("attempt_not_found");
  });
  it("expires attempts without calling the upstream", async () => {
    store.attempt.mockResolvedValue({ ...attempt(), expiresAt: new Date(0) });
    await expect(service.poll("attempt", "link", "user", req(), res())).rejects.toThrow("attempt_expired"); expect(gateway.call).not.toHaveBeenCalled();
  });
  it("returns 202 pending without linking or creating a login session", async () => {
    gateway.call.mockResolvedValue({ status: "pending" }); const response = res();
    expect(await service.poll("attempt", "link", "user", req(), response)).toEqual({ status: "pending", retryAfterMs: 2000 });
    expect(response.status).toHaveBeenCalledWith(202); expect(store.complete).not.toHaveBeenCalled();
  });
  it("binds only a cryptographically verified holder", async () => {
    gateway.call.mockResolvedValue({ status: "verified", signatureVerified: true, holderDid: "did:omn:holder" });
    const result = await service.poll("attempt", "link", "user", req(), res());
    expect(result).toMatchObject({ status: "linked", did: "did:omn:holder" }); expect(result).not.toHaveProperty("accessToken");
  });
  it.each([{ holderDid: "did:omn:other" }, { evidenceRoot: "other" }, { requestId: "other" }, { credentialId: undefined }])("rejects an issuance receipt that does not match its snapshot %j", async patch => {
    store.attempt.mockResolvedValue(attempt("issue")); gateway.call.mockResolvedValue({ status: "issued", holderDid: "did:omn:holder", evidenceRoot: "root", requestId: "attempt", credentialId: "credential", issuedAt: new Date().toISOString(), ...patch });
    await expect(service.poll("attempt", "issue", "user", req(), res())).rejects.toThrow("invalid_issuance_receipt"); expect(store.complete).not.toHaveBeenCalled();
  });
  it("does not advertise unsupported amount disclosure", async () => {
    await expect(service.verify("with_amounts", res())).rejects.toThrow("disclosure_unsupported");
  });
  it("removes the internal credential lookup key on repeated public polling", async () => {
    store.attempt.mockResolvedValue({ ...attempt("verify"), status: "verified", result: { status: "verified", _credentialId: "secret-ref" } });
    expect(await service.poll("attempt", "verify", null, req(), res())).toEqual({ status: "verified" });
  });
});

it("allows repeated cancellation without a second provider call", async () => {
  store.attempt.mockResolvedValue({ ...attempt(), status: "cancelled" });
  await service.cancel("attempt", "link", "user", req());
  expect(gateway.call).not.toHaveBeenCalled();
});
it("requires explicitly disabled mock mode", () => {
  const config = { ...configuration, MOCK_MODE: undefined };
  const disabled = new ReportVcService(new ConfigService(config), store as unknown as ReportVcStore, gateway as unknown as ReportVcGateway, anchors as unknown as AnchorQueryPort);
  expect(disabled.enabled()).toBe(false);
});
