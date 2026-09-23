import { createHash } from "node:crypto";
import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { IdentityProvider, OpenDidOffer, VerifiedIdentity } from "@vera/interfaces";
import { identityProviderName } from "../shared/identity-mode";

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
export type OpenDidResult = { status: "pending" | "expired" | "rejected" } | { status: "verified"; identity: VerifiedIdentity };

/** Contract pinned in docs/opendid-integration.md. No raw upstream response is logged. */
@Injectable()
export class OpenDidVerifierAdapter implements IdentityProvider {
  readonly pollAfterMs = 2000;
  constructor(private readonly config: ConfigService) {
    if (identityProviderName(key => config.get<string>(key)) === "opendid") this.validateConfiguration();
  }
  private required(key: string) {
    const value = this.config.get<string>(key);
    if (!value?.trim()) throw new Error(`${key} is required for Open DID.`);
    return value;
  }
  private integer(key: string, fallback: number, max: number) {
    const value = Number(this.config.get<string>(key) ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${key} is invalid.`);
    return value;
  }
  get timeoutMs() { return this.integer("OPENDID_HTTP_TIMEOUT_MS", 10000, 30000); }
  get ttlMs() { return this.integer("OPENDID_ATTEMPT_TTL_SECONDS", 300, 600) * 1000; }
  get policyId() { return this.required("OPENDID_POLICY_ID"); }
  private get issuerMode() { return this.config.get<string>("OPENDID_ISSUER_BINDING") ?? "response"; }
  private validateConfiguration() {
    const url = new URL(this.required("OPENDID_VERIFIER_URL"));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/verifier") {
      throw new Error("OPENDID_VERIFIER_URL must be an HTTP(S) URL ending in /verifier.");
    }
    this.policyId;
    this.required("OPENDID_SUBJECT_CLAIM_CODE");
    this.required("OPENDID_TRUSTED_ISSUER_ID");
    this.timeoutMs; this.ttlMs;
    if (!["response", "policy"].includes(this.issuerMode)) throw new Error("OPENDID_ISSUER_BINDING must be response or policy.");
    if (this.issuerMode === "policy" && this.config.get<string>("OPENDID_POLICY_ISSUER_RESTRICTION_CONFIRMED") !== "true") {
      throw new Error("Policy issuer binding requires OPENDID_POLICY_ISSUER_RESTRICTION_CONFIRMED=true.");
    }
  }
  private async post(path: string, body: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    try {
      const response = await fetch(`${this.required("OPENDID_VERIFIER_URL").replace(/\/+$/, "")}/api/v1/${path}`, {
        method: "POST", redirect: "error", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
      });
      const payload: unknown = await response.json();
      if (!object(payload)) throw new Error();
      return { ok: response.ok, body: payload };
    } catch { throw new ServiceUnavailableException("Open DID Verifier is unavailable."); }
  }
  async requestVerification(sessionId: string): Promise<OpenDidOffer> {
    const { ok, body } = await this.post("request-offer-qr", { id: sessionId, policyId: this.policyId });
    const p = body.payload;
    if (!ok || !object(p) || !nonempty(body.txId) || !nonempty(p.offerId) || p.type !== "VerifyOffer" ||
        !nonempty(p.mode) || !nonempty(p.device) || !nonempty(p.service) || typeof p.locked !== "boolean" ||
        !Array.isArray(p.endpoints) || !p.endpoints.length || !p.endpoints.every(nonempty) ||
        !nonempty(p.validUntil) || !/(Z|[+-]\d\d:\d\d)$/.test(p.validUntil) || !Number.isFinite(Date.parse(p.validUntil))) {
      throw new ServiceUnavailableException("Open DID returned an invalid offer.");
    }
    const expiresAt = new Date(Math.min(Date.parse(p.validUntil), Date.now() + this.ttlMs));
    if (expiresAt.getTime() <= Date.now()) throw new ServiceUnavailableException("Open DID returned an expired offer.");
    return { provider: "opendid", sessionId, offerId: p.offerId, qrPayload: p, expiresAt };
  }
  // A bare offer ID must never flow through the legacy token callback.
  async handleCallback(_token: string): Promise<VerifiedIdentity> {
    throw new UnauthorizedException("Open DID requires a bound browser verification attempt.");
  }
  async checkVerification(offerId: string): Promise<OpenDidResult> {
    const { ok, body } = await this.post("confirm-verify", { offerId });
    if (!ok) {
      if (body.code === "SSRVVRF00302") return { status: "expired" };
      if (body.code === "SSRVVRF00202") return { status: "rejected" };
      throw new ServiceUnavailableException("Open DID verification is unavailable.");
    }
    if (body.result === false) return { status: "pending" };
    if (body.result !== true || !Array.isArray(body.claims)) throw new ServiceUnavailableException("Open DID returned an invalid verification result.");
    const issuer = this.required("OPENDID_TRUSTED_ISSUER_ID");
    if ((this.issuerMode === "response" && body.issuer !== issuer) || (body.issuer != null && body.issuer !== issuer)) return { status: "rejected" };
    const code = this.required("OPENDID_SUBJECT_CLAIM_CODE");
    const claims = body.claims.filter(c => object(c) && c.code === code);
    if (claims.length !== 1 || !nonempty(claims[0].value) || claims[0].value.length > 1024 || claims[0].type !== "text" || claims[0].format !== "plain" || claims[0].hideValue !== false) return { status: "rejected" };
    const didHash = `0x${createHash("sha256").update(JSON.stringify(["opendid", "v1", issuer, code, claims[0].value])).digest("hex")}`;
    return { status: "verified", identity: { didHash, verifiedAt: new Date(), method: "opendid" } };
  }
}
