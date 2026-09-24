import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { object, reject } from "./report-vc.policy";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (object(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, sorted(v)]));
  return value;
}
export function reportQr(type: "ISSUE_VC" | "SUBMIT_VP", payload: Record<string, unknown>) {
  return { text: JSON.stringify({ payloadType: type, payload: "m" + Buffer.from(JSON.stringify(sorted(payload))).toString("base64").replace(/=+$/, ""), validUntil: payload.validUntil }) };
}
/** Official Verifier + protected, holder-bound extension of the official Issuer. */
@Injectable()
export class ReportVcGateway {
  constructor(private readonly config: ConfigService) {}
  private required(key: string) {
    const value = this.config.get<string>(key);
    if (!value?.trim()) reject("feature_unavailable", 503);
    return value;
  }
  private async post(issuer: boolean, path: string, data: unknown): Promise<Record<string, unknown>> {
    const base = this.required(issuer ? "REPORT_VC_ISSUER_URL" : "OPENDID_VERIFIER_URL");
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) reject("feature_unavailable", 503);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (issuer) {
      const key = this.required("REPORT_VC_ISSUER_SERVICE_KEY");
      if (key.length < 32) reject("feature_unavailable", 503);
      headers["x-verawallet-service-key"] = key;
    }
    let response: Response;
    try { response = await fetch(`${base.replace(/\/$/, "")}/api/v1/${issuer ? "verawallet/report/" : ""}${path}`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers, body: JSON.stringify(data),
    }); } catch { reject(issuer ? "issuer_unavailable" : "verifier_unavailable", 503); }
    let body: unknown;
    try { body = await response.json(); } catch { reject("invalid_provider_response", 502); }
    if (!object(body)) reject("invalid_provider_response", 502);
    if (!response.ok) {
      if (!issuer && ["SSRVVRF00202", "SSRVVRF00302"].includes(String(body.code))) reject("presentation_rejected");
      reject(issuer ? "issuer_unavailable" : "verifier_unavailable", 503);
    }
    return body;
  }
  async call(path: string, input: unknown): Promise<Record<string, unknown>> {
    if (!object(input)) reject("invalid_request", 400);
    if (path === "capabilities") return this.post(true, path, input);
    const [purpose, action] = path.split("/");
    if (!["link", "verify", "issue"].includes(purpose)) reject("invalid_request", 400);
    if (purpose === "issue") {
      const result = await this.post(true, action, input);
      if (action === "offers") {
        if (!object(result.payload) || result.payload.type !== "IssueOffer") reject("invalid_provider_response", 502);
        return { ...result, qr: reportQr("ISSUE_VC", result.payload) };
      }
      return result;
    }
    if (action === "cancel") return { cancelled: true }; // BE attempt invalidation prevents any late VP from being consumed.
    if (action === "offers") {
      const policyId = this.required(purpose === "link" ? "REPORT_VC_LINK_POLICY_ID" : "REPORT_VC_VERIFY_POLICY_ID");
      const result = await this.post(false, "request-offer-qr", { id: input.requestId, policyId });
      if (!object(result.payload) || result.payload.type !== "VerifyOffer" || typeof result.payload.offerId !== "string") reject("invalid_provider_response", 502);
      return { offerId: result.payload.offerId, expiresAt: result.payload.validUntil, qr: reportQr("SUBMIT_VP", result.payload) };
    }
    if (action !== "result") reject("invalid_request", 400);
    const result = await this.post(false, "confirm-verify", { offerId: input.offerId });
    if (result.result === false) return { status: "pending" };
    if (result.result !== true || result.issuer !== this.required("REPORT_VC_ISSUER_DID") || typeof result.holder !== "string" || !Array.isArray(result.claims)) reject("presentation_rejected");
    const base = { status: "verified", signatureVerified: true, holderDid: result.holder, issuerDid: result.issuer };
    if (purpose === "link") return base;
    const roots = result.claims.filter(c => object(c) && c.code === "org.verawallet.report.evidenceRoot");
    if (roots.length !== 1 || !object(roots[0]) || typeof roots[0].value !== "string" || roots[0].hideValue === true || typeof result.credentialId !== "string") reject("presentation_rejected");
    const state = await this.post(true, "credential-status", { credentialId: result.credentialId });
    if (state.holderDid !== result.holder || state.credentialId !== result.credentialId) reject("presentation_rejected");
    return { ...base, credentialId: result.credentialId, evidenceRoot: roots[0].value,
      revocation: state.status === "ACTIVE" ? "active" : ["REVOKED", "INACTIVE"].includes(String(state.status)) ? "revoked" : "unknown" };
  }
  async ready(): Promise<boolean> {
    this.required("REPORT_VC_LINK_POLICY_ID"); this.required("REPORT_VC_VERIFY_POLICY_ID"); this.required("REPORT_VC_ISSUER_DID");
    const result = await this.call("capabilities", {});
    return result.contract === "verawallet-report-vc-v1" && result.holderBound === true && result.immutableClaims === true && result.issuanceReceipt === true;
  }
}
