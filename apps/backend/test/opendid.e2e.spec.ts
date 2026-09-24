import "reflect-metadata";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { AuthService } from "../src/auth/auth.service";
import { OpenDidAttemptStore } from "../src/auth/opendid-attempt.store";
import { HttpExceptionEnvelopeFilter } from "../src/shared/http-exception.filter";

const origin = "http://localhost:3101";
const claims = [{ code: "subjectId", value: "opaque-user", type: "text", format: "plain", hideValue: false }];
const success = { result: true, holder: "did:omn:holder", issuer: "did:issuer", claims };
const config = { MOCK_MODE: "true", PERSISTENCE: "memory", IDENTITY_PROVIDER: "opendid", OPENDID_SUBJECT_BINDINGS: JSON.stringify({ "opaque-user": "did:omn:holder" }), JWT_SECRET: "test-opendid-secret-with-at-least-32-characters", FRONTEND_ORIGIN: origin, OPENDID_VERIFIER_URL: "http://verifier:8092/verifier", OPENDID_POLICY_ID: "policy", OPENDID_SUBJECT_CLAIM_CODE: "subjectId", OPENDID_TRUSTED_ISSUER_ID: "did:issuer", NODE_ENV: "test" };

describe("Open DID browser authentication", () => {
  let app: INestApplication;
  let confirm: ReturnType<typeof vi.fn>;
  let serial: number;
  beforeEach(async () => {
    vi.stubEnv("IDENTITY_PROVIDER", "opendid");
    serial = 0;
    confirm = vi.fn().mockResolvedValue(success);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("request-offer-qr")) return new Response(JSON.stringify({ txId: "tx", payload: { offerId: `offer-${++serial}`, type: "VerifyOffer", mode: "Direct", device: "PC", service: "login", endpoints: ["http://lan:8092/verifier"], locked: false, validUntil: new Date(Date.now() + 60000).toISOString() } }));
      return new Response(JSON.stringify(await confirm()));
    }));
    const module = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(ConfigService).useValue(new ConfigService(config)).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
    await app.init();
  });
  afterEach(async () => { if (app) await app.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  const offer = (browser: ReturnType<typeof request.agent>) => browser.post("/api/auth/did/offer").set("Origin", origin).send({ country: "KR" }).expect(201);
  const present = (browser: ReturnType<typeof request.agent>, offerId: string) => browser.post("/api/auth/did/present").set("Origin", origin).send({ country: "KR", offerId });

  it("issues a browser cookie and completes a real adapter → user → JWT → session flow", async () => {
    const browser = request.agent(app.getHttpServer());
    const issued = await offer(browser);
    expect(issued.body.meta.provenance).toBe("live");
    expect(issued.headers["cache-control"]).toBe("no-store");
    expect(issued.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(issued.body.data).not.toHaveProperty("secret");
    const result = await present(browser, issued.body.data.offerId).expect(200);
    expect(result.body.data).toMatchObject({ countryCode: "KR" });
    expect(JSON.stringify(result.body)).not.toContain("opaque-user");
    expect(String(result.headers["set-cookie"])).toContain("vw_access_token=");
    const session = await browser.get("/api/auth/session").expect(200);
    expect(session.body.data).toMatchObject({ didVerified: true, countryCode: "KR" });
    await browser.post("/api/auth/wallet/watch").send({ address: "0x9999999999999999999999999999999999999999" }).expect(201);
    const health = await browser.get("/health").expect(200);
    expect(health.body.identityProvider).toBe("opendid");
  });
  it("returns pending without minting a JWT, then completes after the polling interval", async () => {
    const browser = request.agent(app.getHttpServer()); const issued = await offer(browser);
    const mint = vi.spyOn(app.get(AuthService), "issueSession");
    confirm.mockResolvedValueOnce({ result: false });
    const result = await present(browser, issued.body.data.offerId).expect(202);
    expect(result.body.data.status).toBe("pending");
    expect(result.headers["set-cookie"]).toBeUndefined(); expect(mint).not.toHaveBeenCalled();
    await present(browser, issued.body.data.offerId).expect(429);
    await new Promise(resolve => setTimeout(resolve, 2050));
    await present(browser, issued.body.data.offerId).expect(200);
    expect(mint).toHaveBeenCalledTimes(1);
  });
  it("rejects missing or foreign cookies and untrusted origins before calling the verifier", async () => {
    const a = request.agent(app.getHttpServer()); const b = request.agent(app.getHttpServer());
    const one = await offer(a); await offer(b);
    await present(b, one.body.data.offerId).expect(401);
    await request(app.getHttpServer()).post("/api/auth/did/present").set("Origin", origin).send({ country: "KR", offerId: one.body.data.offerId }).expect(401);
    await a.post("/api/auth/did/present").set("Origin", "https://attacker.example").send({ country: "KR", offerId: one.body.data.offerId }).expect(403);
    await a.post("/api/auth/did/offer").send({ country: "KR" }).expect(403);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("validates DTOs, country binding and legacy route exclusion", async () => {
    const browser = request.agent(app.getHttpServer()); const issued = await offer(browser);
    await browser.post("/api/auth/did/present").set("Origin", origin).send({ country: "US", offerId: issued.body.data.offerId }).expect(400);
    await browser.post("/api/auth/did/present").set("Origin", origin).send({ country: "KR", offerId: issued.body.data.offerId, cxToken: "cx" }).expect(400);
    await browser.post("/api/auth/did/offer").set("Origin", origin).send({ country: "XX" }).expect(400);
    await browser.post("/auth/verify/start").send({}).expect(401);
    await browser.post("/auth/verify/callback").send({ token: issued.body.data.offerId }).expect(401);
    expect(confirm).not.toHaveBeenCalled();
  });
  it("rejects consumed offers even if the original secret cookie is replayed", async () => {
    const browser = request.agent(app.getHttpServer()); const issued = await offer(browser);
    const cookie = issued.headers["set-cookie"][0].split(";")[0];
    await present(browser, issued.body.data.offerId).expect(200);
    await request(app.getHttpServer()).post("/api/auth/did/present").set("Origin", origin).set("Cookie", cookie).send({ country: "KR", offerId: issued.body.data.offerId }).expect(409);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
  it("serializes concurrent completion and rejects rotated offers", async () => {
    const browser = request.agent(app.getHttpServer()); const old = await offer(browser); const current = await offer(browser);
    await present(browser, old.body.data.offerId).expect(401);
    let finish!: (value: unknown) => void;
    confirm.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = present(browser, current.body.data.offerId).then(r => r);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await present(browser, current.body.data.offerId).expect(409);
    finish(success); expect((await first).status).toBe(200);
  });
  it("fails on expiry and malformed upstream responses without a session", async () => {
    const browser = request.agent(app.getHttpServer()); const issued = await offer(browser);
    const store = app.get(OpenDidAttemptStore); const row = (await store.find(issued.body.data.offerId))!;
    await store.create({ ...row, expiresAt: new Date(0) });
    await present(browser, row.offerId).expect(410); expect(confirm).not.toHaveBeenCalled();
    const next = await offer(browser); confirm.mockResolvedValue({ result: "true" });
    const response = await present(browser, next.body.data.offerId).expect(503);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
  it("caps issuance per signed browser without blocking another browser behind the proxy", async () => {
    const browser = request.agent(app.getHttpServer());
    for (let i = 0; i < 10; i++) await offer(browser);
    await browser.post("/api/auth/did/offer").set("Origin", origin).send({ country: "KR" }).expect(429);
    await offer(request.agent(app.getHttpServer()));
  });
  it("caps cookie-discarding callers with an independent global budget", async () => {
    for (let i = 0; i < 100; i++) await offer(request.agent(app.getHttpServer()));
    await request(app.getHttpServer()).post("/api/auth/did/offer").set("Origin", origin)
      .set("Cookie", "vw_did_client=" + "a".repeat(32) + "." + "b".repeat(64))
      .send({ country: "KR" }).expect(429);
  });
});
