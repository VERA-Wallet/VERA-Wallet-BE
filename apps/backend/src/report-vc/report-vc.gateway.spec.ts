import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportVcGateway, reportQr } from "./report-vc.gateway";
const values = { REPORT_VC_ISSUER_URL: "http://issuer.test/issuer", REPORT_VC_ISSUER_SERVICE_KEY: "k".repeat(64), OPENDID_VERIFIER_URL: "http://verifier.test/verifier", REPORT_VC_LINK_POLICY_ID: "link-policy", REPORT_VC_VERIFY_POLICY_ID: "report-policy", REPORT_VC_ISSUER_DID: "did:omn:issuer" };
const gateway = () => new ReportVcGateway(new ConfigService(values));
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());
describe("native report credential gateway", () => {
  it("encodes the official QR envelope with canonical multibase payload", () => {
    const qr = JSON.parse(reportQr("ISSUE_VC", { type: "IssueOffer", offerId: "id", validUntil: "expiry" }).text);
    expect(qr.payloadType).toBe("ISSUE_VC");
    expect(qr.payload[0]).toBe("m");
    expect(JSON.parse(Buffer.from(qr.payload.slice(1), "base64").toString())).toEqual({ offerId: "id", type: "IssueOffer", validUntil: "expiry" });
  });
  it("uses a separate report verification policy and never sends issuer keys to verifier", async () => {
    const fetch = vi.fn().mockResolvedValue(reply({ payload: { type: "VerifyOffer", offerId: "id", validUntil: "expiry" } })); vi.stubGlobal("fetch", fetch);
    await gateway().call("verify/offers", { requestId: "request" });
    expect(JSON.parse(fetch.mock.calls[0][1].body).policyId).toBe("report-policy");
    expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("x-verawallet-service-key");
    expect(fetch.mock.calls[0][1].redirect).toBe("error");
  });
  it("does not accept a different issuer even after upstream success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ result: true, issuer: "did:omn:other", holder: "did:omn:holder", claims: [] })));
    await expect(gateway().call("link/result", { offerId: "id" })).rejects.toThrow("presentation_rejected");
  });
  it("checks current issuer status and binds it to the signed credential holder", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(reply({ result: true, issuer: values.REPORT_VC_ISSUER_DID, holder: "did:omn:holder", credentialId: "vc", claims: [{ code: "org.verawallet.report.evidenceRoot", value: "root" }] })).mockResolvedValueOnce(reply({ credentialId: "vc", holderDid: "did:omn:other", status: "ACTIVE" })); vi.stubGlobal("fetch", fetch);
    await expect(gateway().call("verify/result", { offerId: "id" })).rejects.toThrow("presentation_rejected");
  });
  it("fails closed when the provider returns malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>failure</html>")));
    await expect(gateway().call("issue/offers", {})).rejects.toThrow("invalid_provider_response");
  });
});
