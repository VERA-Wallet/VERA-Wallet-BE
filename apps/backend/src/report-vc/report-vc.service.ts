import { createHmac, randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import type { AnchorQueryPort } from "../anchor/anchor.port";
import { ANCHOR_QUERY } from "../anchor/anchor.tokens";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { ReportVcStore, jsonValue, type Attempt } from "./report-vc.store";
import { ReportVcGateway } from "./report-vc.gateway";
import { fileProof, matchesSecret, object, reject, secretHash, snapshot } from "./report-vc.policy";
import type { CheckReportFileDto } from "./report-vc.dto";

type Purpose = "link" | "issue" | "verify";
const COOKIES = { link: "vw_vc_link_attempt", issue: "vw_vc_issue_attempt", verify: "vw_vc_verify_attempt" };
const PATHS = { link: "wallet", issue: "issuances", verify: "verifications" };
const TERMINAL = new Set(["linked", "issued", "verified", "rejected", "failed", "cancelled"]);

@Injectable()
export class ReportVcService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer?: ReturnType<typeof setInterval>;
  onModuleInit() {
    if (!this.enabled()) return;
    this.cleanupTimer = setInterval(() => { void this.store.cleanup().catch(() => {}); }, 60_000);
    this.cleanupTimer.unref();
  }
  onModuleDestroy() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }
  private budget = { until: 0, count: 0 };
  constructor(private readonly config: ConfigService, private readonly store: ReportVcStore,
    private readonly gateway: ReportVcGateway, @Inject(ANCHOR_QUERY) private readonly anchors: AnchorQueryPort) {}
  enabled() {
    return this.config.get("REPORT_VC_ENABLED") === "true" && this.config.get("MOCK_MODE") === "false" && usePrismaPersistence(this.config) &&
      (this.config.get<string>("JWT_SECRET") ?? "").length >= 32;
  }
  private requireEnabled() { if (!this.enabled()) reject("feature_unavailable", 503); }
  async capabilities() {
    let ready = false;
    if (this.enabled()) { try { ready = await this.gateway.ready(); } catch { /* unavailable must not look ready */ } }
    return { enabled: ready, walletLink: ready, issuance: ready && this.config.get("ANCHOR_ENABLED") !== "false" && Boolean(this.config.get<string>("OMNIONE_CHAIN_ID", "201210")), verification: ready,
      disclosures: ready ? ["basic"] : [], fileFormats: ready ? ["csv", "xlsx"] : [] };
  }
  origin(request: Request) {
    this.requireEnabled();
    if (!request.headers.origin || request.headers.origin !== this.config.get("FRONTEND_ORIGIN")) reject("origin_rejected", 403);
  }
  private rate() {
    const now = Date.now();
    if (this.budget.until <= now) this.budget = { until: now + 60_000, count: 0 };
    // Hard ceiling bounds new sessions even when the client drops cookies. Never trust X-Forwarded-For.
    if (++this.budget.count > 60) reject("rate_limited", 429);
  }
  async requireCx(userId: string) {
    this.requireEnabled();
    const cx = await this.store.cx(userId);
    if (!cx) reject("cx_verification_required", 403);
    return cx;
  }
  async wallet(userId: string) {
    await this.requireCx(userId);
    const wallet = await this.store.wallet(userId);
    return wallet ? { status: "linked", did: wallet.holderDid, linkedAt: wallet.linkedAt.toISOString() } : { status: "unlinked" };
  }
  async unlink(userId: string) { await this.requireCx(userId); await this.store.unlink(userId); }
  private cookie(row: Attempt, response: Response) {
    const purpose = row.purpose as Purpose;
    // Deterministic server HMAC permits idempotent replay without storing a plaintext browser secret.
    const secret = createHmac("sha256", this.config.getOrThrow<string>("JWT_SECRET")).update(`report-vc:${row.id}:${row.userId ?? "public"}`).digest("hex");
    response.cookie(COOKIES[purpose], secret, { httpOnly: true, sameSite: "lax", secure: this.config.get("NODE_ENV") === "production",
      path: `/api/report-vc/${PATHS[purpose]}`, maxAge: Math.max(1000, row.expiresAt.getTime() - Date.now() + (purpose === "verify" ? 600_000 : 0)) });
  }
  private async newAttempt(purpose: Purpose, userId: string | null, extras: Record<string, unknown> = {}) {
    this.requireEnabled(); this.rate();
    const id = randomUUID(), now = new Date();
    const secret = createHmac("sha256", this.config.getOrThrow<string>("JWT_SECRET")).update(`report-vc:${id}:${userId ?? "public"}`).digest("hex");
    return this.store.create({ id, purpose, userId, secretHash: secretHash(secret), status: "creating", expiresAt: new Date(now.getTime() + 180_000), nextPollAt: now, ...extras });
  }
  private async offer(row: Attempt, request: unknown, response: Response) {
    if (row.status === "creating") {
      try {
        const offer = await this.gateway.call(`${row.purpose}/offers`, { requestId: row.id, ...object(request) ? request : {} });
        if (typeof offer.offerId !== "string" || !object(offer.qr) || typeof offer.qr.text !== "string" ||
            typeof offer.expiresAt !== "string" || !Number.isFinite(Date.parse(offer.expiresAt))) reject("invalid_provider_response", 502);
        const expiresAt = new Date(Math.min(row.expiresAt.getTime(), Date.parse(offer.expiresAt)));
        if (expiresAt.getTime() <= Date.now()) reject("attempt_expired", 410);
        await this.store.activate(row.id, offer.offerId, offer, expiresAt);
        row = (await this.store.attempt(row.id))!;
      } catch (error) {
        // Do not repeat a potentially successful upstream creation with new claims after an ambiguous response.
        await this.store.fail(row.id); throw error;
      }
    }
    this.cookie(row, response);
    if (row.expiresAt <= new Date()) reject("attempt_expired", 410);
    if (TERMINAL.has(row.status)) return row.result ?? { ...this.view(row), status: row.status };
    if (!object(row.offer)) reject("issuer_unavailable", 503);
    return { ...(row.purpose === "link" ? { attemptId: row.id } : row.purpose === "verify" ? { verificationId: row.id, disclosure: row.disclosure } : this.view(row)),
      qr: row.offer.qr, expiresAt: row.expiresAt.toISOString(), pollAfterMs: 2000 };
  }
  async link(userId: string, response: Response, request?: Request) {
    const cx = await this.requireCx(userId);
    // Linking credentials changes account ownership context; require a recent real CX authentication.
    if (Date.now() - cx.verifiedAt.getTime() > 15 * 60_000) reject("cx_reauthentication_required", 403);
    const active = await this.store.activeLink(userId);
    if (active) {
      // Resume only the originating browser. Returning a QR must not grant a different
      // browser the polling/cancellation capability merely because it knows the account.
      if (!matchesSecret(request?.cookies?.[COOKIES.link], active.secretHash)) reject("link_in_progress", 409);
      if (active.status !== "pending" || !object(active.offer)) reject("link_in_progress", 409);
      // offer() reuses the persisted QR and original expiresAt; no upstream call or timer reset.
      return this.offer(active, {}, response);
    }
    const row = await this.newAttempt("link", userId, { snapshot: jsonValue({ cxVerifiedAt: cx.verifiedAt.toISOString() }) });
    return this.offer(row, {}, response);
  }
  private view(row: Attempt) {
    return { issuanceId: row.id, status: !TERMINAL.has(row.status) && row.expiresAt <= new Date() ? "expired" : row.status === "pending" ? "offer_ready" : row.status === "creating" ? "issuing" : row.status,
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), ...(object(row.result) ? row.result : {}) };
  }
  async eligibility(userId: string, root: string) {
    await this.requireCx(userId);
    const evidence = await this.store.evidence(userId, root);
    const wallet = await this.store.wallet(userId);
    const anchor = evidence ? await this.anchors.get(root) : null;
    const latest = await this.store.latestAttempt(userId, root);
    const eligibility = !evidence ? "anchor_missing" : !wallet ? "wallet_unlinked" :
      anchor?.status === "anchored" ? "ready" : anchor?.status === "failed" ? "anchor_failed" : "anchor_pending";
    return { evidenceId: root, eligibility, evidence: evidence ? { merkleRoot: root, countryCode: evidence.countryCode, taxYear: evidence.taxYear, anchorStatus: anchor?.status ?? "pending" } : null,
      latest: latest ? this.view(latest) : null };
  }
  async issue(userId: string, root: string, key: string | undefined, response: Response) {
    await this.requireCx(userId);
    if (!key || !/^[0-9a-f-]{36}$/i.test(key)) reject("invalid_idempotency_key", 400);
    const wallet = await this.store.wallet(userId);
    if (!wallet) reject("wallet_unlinked");
    const evidence = await this.store.evidence(userId, root);
    if (!evidence) reject("evidence_not_found", 404);
    const anchor = await this.anchors.get(root);
    if (anchor?.status !== "anchored" || !anchor.chainTxHash || anchor.blockNumber == null) reject("evidence_not_anchored");
    const check = await this.anchors.inspect(anchor.chainTxHash);
    if (!check?.success || check.anchoredPayloadHash?.toLowerCase() !== root.toLowerCase()) reject("anchor_mismatch");
    const data = snapshot({ root, countryCode: evidence.countryCode, taxYear: evidence.taxYear, holderDid: wallet.holderDid,
      cxVerifiedAt: wallet.cxVerifiedAt, document: evidence.document, anchor: { chain: this.config.get<string>("OMNIONE_CHAIN_ID", "201210"), txHash: anchor.chainTxHash, blockNumber: String(anchor.blockNumber) } });
    const row = await this.newAttempt("issue", userId, { holderDid: wallet.holderDid, evidenceRoot: root,
      idempotencyKey: key, requestHash: secretHash(root), snapshot: jsonValue(data) });
    return this.offer(row, { holderDid: row.holderDid, snapshot: row.snapshot }, response);
  }
  async verify(disclosure: string, response: Response) {
    if (disclosure !== "basic") reject("disclosure_unsupported", 400);
    const row = await this.newAttempt("verify", null, { disclosure });
    return this.offer(row, { disclosure }, response);
  }
  async bound(id: string, purpose: Purpose, userId: string | null, request: Request, allowCompleted = false, allowCancelled = false) {
    this.requireEnabled();
    if (userId) await this.requireCx(userId);
    const row = await this.store.attempt(id);
    if (!row || row.purpose !== purpose || row.userId !== userId) reject("attempt_not_found", 404);
    if (!matchesSecret(request.cookies?.[COOKIES[purpose]], row.secretHash)) reject("attempt_not_bound", 403);
    const grace = allowCompleted && row.status === "verified" ? 600_000 : 0;
    if (row.expiresAt.getTime() + grace <= Date.now()) reject("attempt_expired", 410);
    if (row.status === "cancelled" && !allowCancelled) reject("attempt_cancelled");
    return row;
  }
  async cancel(id: string, purpose: Purpose, userId: string | null, request: Request) {
    const row = await this.bound(id, purpose, userId, request, true, true);
    if (TERMINAL.has(row.status)) return;
    // Issuer must invalidate the offer, not just stop the browser's spinner.
    if (row.upstreamId) {
      const result = await this.gateway.call(`${purpose}/cancel`, { offerId: row.upstreamId, requestId: row.id });
      if (result.cancelled !== true) reject("issuer_unavailable", 503);
    }
    await this.store.cancel(id);
  }
  async poll(id: string, purpose: Purpose, userId: string | null, request: Request, response: Response) {
    const row = await this.bound(id, purpose, userId, request, true);
    if (TERMINAL.has(row.status)) {
      if (object(row.result)) { const { _credentialId, ...publicResult } = row.result; return publicResult; }
      return this.view(row);
    }
    const token = randomUUID();
    if (!await this.store.acquire(id, token, new Date())) {
      response.status(202); return { status: purpose === "issue" ? "offer_ready" : "pending", retryAfterMs: 2000 };
    }
    try {
      const result = await this.gateway.call(`${purpose}/result`, { offerId: row.upstreamId, requestId: row.id });
      if (result.status === "pending") { response.status(202); return { status: purpose === "issue" ? "issuing" : "pending", retryAfterMs: 2000 }; }
      if (purpose === "link") {
        if (result.status !== "verified" || result.signatureVerified !== true || typeof result.holderDid !== "string" || !/^did:[a-z0-9]+:.+$/.test(result.holderDid)) reject("presentation_rejected");
        const state = row.snapshot;
        if (!object(state) || typeof state.cxVerifiedAt !== "string") reject("invalid_attempt");
        const answer = { status: "linked", did: result.holderDid, linkedAt: new Date().toISOString() };
        await this.store.complete(row, token, "linked", answer, { holder: result.holderDid, cxVerifiedAt: new Date(state.cxVerifiedAt) }); return answer;
      }
      if (purpose === "issue") {
        if (result.status !== "issued" || result.holderDid !== row.holderDid || result.evidenceRoot !== row.evidenceRoot || result.requestId !== row.id ||
            typeof result.credentialId !== "string" || !result.credentialId || typeof result.issuedAt !== "string" || !Number.isFinite(Date.parse(result.issuedAt))) reject("invalid_issuance_receipt", 502);
        const state = row.snapshot;
        if (!object(state)) reject("invalid_attempt");
        const answer = { ...this.view(row), status: "issued", credentialId: result.credentialId, issuedAt: result.issuedAt };
        await this.store.complete(row, token, "issued", answer, { credentialId: result.credentialId, issuedAt: new Date(result.issuedAt), countryCode: String(state.countryCode), taxYear: Number(state.taxYear) }); return answer;
      }
      return await this.finishVerification(row, token, result);
    } finally { await this.store.release(id, token); }
  }
  private async finishVerification(row: Attempt, token: string, result: Record<string, unknown>) {
    if (result.status !== "verified" || result.signatureVerified !== true || typeof result.credentialId !== "string" ||
        typeof result.holderDid !== "string" || result.issuerDid !== this.config.get("REPORT_VC_ISSUER_DID")) reject("presentation_rejected");
    const credential = await this.store.credential(result.credentialId);
    if (!credential || credential.holderDid !== result.holderDid || !object(credential.snapshot)) reject("presentation_rejected");
    const state = credential.snapshot;
    if (result.evidenceRoot !== credential.evidenceRoot || !object(state.anchor)) reject("presentation_rejected");
    const anchor = state.anchor;
    const inspection = typeof anchor.txHash === "string" ? await this.anchors.inspect(anchor.txHash) : null;
    const chainPass = inspection?.success === true && inspection.anchoredPayloadHash?.toLowerCase() === credential.evidenceRoot.toLowerCase();
    const latest = await this.store.latestEvidence(credential.userId, credential.countryCode, credential.taxYear);
    const revocation = result.revocation === "active" || result.revocation === "revoked" ? result.revocation : "unknown";
    const status = revocation === "active" && chainPass ? "verified" : "rejected";
    const answer = { verificationId: row.id, disclosure: "basic", status, checkedAt: new Date().toISOString(),
      checks: { issuerAndPresentation: "passed", revocation, version: latest ? latest.merkleRoot === credential.evidenceRoot ? "latest" : "superseded" : "unknown", chainAnchor: inspection ? chainPass ? "passed" : "failed" : "unknown" },
      claims: { reportId: credential.issuanceId, version: 1, countryCode: credential.countryCode, taxYear: credential.taxYear,
        evidenceRoot: credential.evidenceRoot, issuedAt: credential.issuedAt.toISOString(), anchor, totals: null },
      accountLink: typeof state.cxVerifiedAt === "string" ? "verified" : "not_provided" };
    await this.store.complete(row, token, status, { ...answer, _credentialId: credential.id });
    return answer;
  }
  async checkFile(id: string, request: Request, input: CheckReportFileDto) {
    const row = await this.bound(id, "verify", null, request, true);
    if (row.status !== "verified" || !object(row.result) || typeof row.result._credentialId !== "string") reject("verification_not_completed");
    const credential = await this.store.credential(row.result._credentialId);
    if (!credential) reject("verification_not_completed");
    const evidence = await this.store.evidence(credential.userId, credential.evidenceRoot);
    const base = { format: input.format, hash: input.hash, evidenceRoot: credential.evidenceRoot };
    if (!evidence || !object(evidence.document) || !Array.isArray(evidence.document.leaves) || !evidence.document.leaves.every(object)) return { ...base, status: "unavailable" };
    const leaves = evidence.document.leaves.filter(object) as Record<string, unknown>[];
    const index = leaves.findIndex(leaf => leaf.kind === "file" && leaf.file === input.format && leaf.algorithm === input.algorithm &&
      typeof leaf.hash === "string" && leaf.hash.toLowerCase() === input.hash.toLowerCase() && leaf.byteLength === input.byteLength);
    if (index < 0) return { ...base, status: "not_included" };
    return { ...base, status: "included", leaf: leaves[index], proof: fileProof(leaves, index) };
  }
}
