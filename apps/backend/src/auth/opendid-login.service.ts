import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { OpenDidVerifierAdapter } from "../identity/opendid-verifier.adapter";
import { identityProviderName } from "../shared/identity-mode";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { OpenDidAttemptStore } from "./opendid-attempt.store";
import { AuthService } from "./auth.service";

const COOKIE = "vw_did_attempt";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fail(status: number, code: string): never { throw new HttpException({ code, message: code }, status); }

@Injectable()
export class OpenDidLoginService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OpenDidLoginService.name);
  private timer?: ReturnType<typeof setInterval>;
  private readonly issuance = new Map<string, { count: number; until: number }>();
  constructor(private readonly config: ConfigService, private readonly verifier: OpenDidVerifierAdapter,
    private readonly store: OpenDidAttemptStore, private readonly auth: AuthService) {}
  onModuleInit() {
    if (identityProviderName(key => this.config.get<string>(key)) !== "opendid") return;
    if ((this.config.get<string>("JWT_SECRET") ?? "").length < 32) throw new Error("Open DID requires JWT_SECRET with at least 32 characters.");
    if (this.config.get<string>("NODE_ENV") === "production" && !usePrismaPersistence(this.config)) throw new Error("Open DID production requires Prisma persistence.");
    const origin = this.config.get<string>("FRONTEND_ORIGIN");
    if (!origin || new URL(origin).origin !== origin) throw new Error("Open DID requires an exact FRONTEND_ORIGIN.");
    this.timer = setInterval(() => { void this.store.cleanup().catch(() => this.logger.warn("Open DID attempt cleanup failed.")); }, 60_000);
    this.timer.unref();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  private authorize(request: Request) {
    if (identityProviderName(key => this.config.get<string>(key)) !== "opendid") fail(404, "opendid_not_enabled");
    if (!request || request.headers.origin !== this.config.get<string>("FRONTEND_ORIGIN")) fail(403, "untrusted_origin");
  }
  private secret(request: Request) {
    const value: unknown = request.cookies?.[COOKIE];
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }
  private cookieOptions() {
    return { httpOnly: true, sameSite: "lax" as const, secure: this.config.get<string>("NODE_ENV") === "production", path: "/api/auth/did" };
  }
  async offer(country: string, request: Request, response: Response) {
    this.authorize(request);
    response.setHeader("Cache-Control", "no-store");
    const now = Date.now();
    for (const [key, row] of this.issuance) if (row.until <= now) this.issuance.delete(key);
    // Direct peer address only: do not trust attacker-supplied forwarding headers.
    const key = request.ip ?? request.socket?.remoteAddress ?? "unknown";
    const budget = this.issuance.get(key) ?? { count: 0, until: now + 60_000 };
    if (budget.count >= 10 || this.issuance.size >= 10000 && !this.issuance.has(key)) {
      response.setHeader("Retry-After", String(Math.max(1, Math.ceil((budget.until - now) / 1000))));
      fail(429, "verification_rate_limited");
    }
    budget.count++; this.issuance.set(key, budget);
    const id = randomUUID();
    const offer = await this.verifier.requestVerification(id);
    const secret = randomBytes(32).toString("hex");
    const previous = this.secret(request);
    await this.store.create({ id, offerId: offer.offerId, secretHash: hash(secret), policyId: this.verifier.policyId,
      country, expiresAt: offer.expiresAt, status: "pending", nextPollAt: new Date(), leaseToken: null, leaseUntil: null, consumedAt: null }, previous ? hash(previous) : undefined);
    response.cookie(COOKIE, secret, { ...this.cookieOptions(), maxAge: offer.expiresAt.getTime() - Date.now() });
    return { offerId: offer.offerId, qrPayload: offer.qrPayload, expiresAt: offer.expiresAt.toISOString(), pollAfterMs: this.verifier.pollAfterMs };
  }
  async present(offerId: string, country: string, request: Request, response: Response) {
    this.authorize(request);
    response.setHeader("Cache-Control", "no-store");
    const secret = this.secret(request);
    if (!secret) fail(401, "invalid_verification_attempt");
    const row = await this.store.find(offerId);
    if (!row || row.secretHash !== hash(secret) || row.policyId !== this.verifier.policyId) fail(401, "invalid_verification_attempt");
    if (row.country !== country) fail(400, "invalid_verification_request");
    if (row.expiresAt.getTime() <= Date.now() || row.status === "expired") fail(410, "verification_expired");
    if (row.status === "consumed") fail(409, "verification_consumed");
    if (row.status === "rejected") fail(401, "identity_verification_failed");
    if (row.nextPollAt.getTime() > Date.now()) { response.setHeader("Retry-After", "2"); fail(429, "verification_rate_limited"); }
    const token = randomUUID();
    if (!await this.store.acquire(row.id, token, new Date(), new Date(Date.now() + this.verifier.timeoutMs + 5000))) fail(409, "verification_in_progress");
    try {
      const result = await this.verifier.checkVerification(offerId);
      if (result.status !== "verified") {
        await this.store.release(row.id, token, result.status === "pending" ? "pending" : result.status, new Date(Date.now() + this.verifier.pollAfterMs));
        if (result.status === "expired") fail(410, "verification_expired");
        if (result.status === "rejected") fail(401, "identity_verification_failed");
        if (row.expiresAt.getTime() <= Date.now()) fail(410, "verification_expired");
        return { status: "pending" as const, retryAfterMs: this.verifier.pollAfterMs };
      }
      const user = await this.store.complete(row.id, token, result.identity);
      if (!user) fail(409, "verification_in_progress");
      const session = await this.auth.issueSession(user, result.identity, row.country);
      response.clearCookie(COOKIE, this.cookieOptions());
      return { status: "verified" as const, accessToken: session.accessToken };
    } catch (error) {
      await this.store.release(row.id, token, "pending", new Date(Date.now() + this.verifier.pollAfterMs));
      throw error;
    }
  }
}
