import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import request from "supertest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SiweMessage } from "siwe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { HttpExceptionEnvelopeFilter } from "../src/shared/http-exception.filter";
import type { INestApplication } from "@nestjs/common";

describe("VERA Wallet mock journey", () => {
  let app: INestApplication;
  // Each test gets a fresh app + in-memory store: the fixed mock DID yields one shared user, so
  // sharing the app would let one test's bound+synced wallet leak into the next (multi-wallet sync
  // would then double the fixtures). Isolation keeps each contract assertion single-wallet.
  beforeEach(async () => {
    process.env.MOCK_MODE = "true";
    // PERSISTENCE는 MOCK_MODE보다 우선한다. 로컬 .env가 prisma로 켜져 있으면 이 테스트가 개발용 DB에
    // 붙어 버려서, 이전 실행이 남긴 행까지 세느라 건수 단언이 깨진다. 여기서 인메모리로 못박는다.
    process.env.PERSISTENCE = "memory";
    process.env.JWT_SECRET = "test-only-verawallet-secret-at-least-32-chars";
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
    await app.init();
  });
  afterEach(async () => app.close());

  it("completes identity → bind → sync → tax → report → anchor", async () => {
    const callback = await request(app.getHttpServer()).post("/auth/verify/callback").send({ token: "demo-token", country: "KR" }).expect(201);
    const authorization = `Bearer ${callback.body.accessToken}`;
    expect(callback.body.user.didHash).toMatch(/^0x[0-9a-f]{64}$/);

    const challenge = await request(app.getHttpServer()).post("/wallet/bind/challenge").set("Authorization", authorization).send({}).expect(201);
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: challenge.body.message });
    const binding = await request(app.getHttpServer()).post("/wallet/bind").set("Authorization", authorization).send({ address: account.address, message: challenge.body.message, nonce: challenge.body.nonce, signature }).expect(201);
    expect(binding.body.anchorStatus).toBe("anchored");
    expect(binding.body.bindingHash).toMatch(/^0x[0-9a-f]{64}$/);
    const replay = await request(app.getHttpServer()).post("/wallet/bind").set("Authorization", authorization).send({ address: account.address, message: challenge.body.message, nonce: challenge.body.nonce, signature }).expect(409);
    expect(replay.body.error.code).toBe("already-consumed");

    const sync = await request(app.getHttpServer()).post("/indexer/sync").set("Authorization", authorization).send({}).expect(201);
    expect(sync.body.normalized).toBe(25);

    const calculation = await request(app.getHttpServer()).post("/tax/calculate").set("Authorization", authorization).send({ period: "2025", countryCode: "KR" }).expect(201);
    expect(calculation.body).toMatchObject({ isEstimate: true, countryCode: "KR" });
    expect(calculation.body.disclaimer).toContain("추정치");

    const report = await request(app.getHttpServer()).get(`/reports/${calculation.body.reportId}`).set("Authorization", authorization).expect(200);
    expect(report.body.events.length).toBeGreaterThan(0);
    expect(report.body.events.every((event: { isEstimate: boolean }) => event.isEstimate)).toBe(true);

    const finalized = await request(app.getHttpServer()).post(`/reports/${calculation.body.reportId}/finalize`).set("Authorization", authorization).expect(201);
    expect(finalized.body).toMatchObject({ status: "anchored", anchorStatus: "anchored", isEstimate: true });
    const anchor = await request(app.getHttpServer()).get(`/anchors/${finalized.body.auditHash}`).expect(200);
    expect(anchor.body).toMatchObject({ status: "anchored", anchorType: "audit" });
    expect(anchor.body).not.toHaveProperty("userId");
  });

  it("serves the VeraWallet-FE cookie, envelope, SIWE, event and tax contracts", async () => {
    const browser = request.agent(app.getHttpServer());
    await browser.post("/api/auth/did/present").send({ country: "US" }).expect(201);
    const nonce = await browser.post("/api/auth/nonce").send({ chainId: 1 }).expect(201);
    expect(nonce.body.meta.provenance).toBe("mock");
    const account = privateKeyToAccount(generatePrivateKey());
    const message = new SiweMessage({ domain: nonce.body.data.domain, address: account.address, statement: "Sign in to VERA Wallet", uri: nonce.body.data.uri, version: "1", chainId: 1, nonce: nonce.body.data.nonce, issuedAt: nonce.body.data.issuedAt }).prepareMessage();
    const signature = await account.signMessage({ message });
    await browser.post("/api/auth/verify").send({ message, signature }).expect(201);

    const session = await browser.get("/api/auth/session").expect(200);
    expect(session.body.data).toMatchObject({ didVerified: true, countryCode: "US", walletAddress: account.address, walletVerification: "siwe" });
    expect(session.body.data).not.toHaveProperty("chainId"); // chain facts come from indexed events, not the session
    const list = await browser.get("/api/events?limit=5").expect(200);
    expect(list.body.data.items).toHaveLength(5);
    expect(list.body.data.items[0]).toMatchObject({ version: 1, event: { id: "event-01", price_status: "ESTIMATED" } });
    const summary = await browser.get("/api/events/summary").expect(200);
    expect(summary.body.data).toMatchObject({ currency: "KRW", computableEventCount: 14 });
    const rulesets = await browser.get("/api/tax/rulesets").expect(200);
    expect(rulesets.body.data).toHaveLength(12);
    const estimate = await browser.post("/api/tax/estimate").send({ country: "US", taxYear: 2025, source: "wallet" }).expect(201);
    expect(estimate.body.data).toMatchObject({ country: "US", provenance: "mock", isEstimate: true });
    expect(estimate.body.data.disclaimer).toContain("추정치");
    const proof = await browser.get("/api/anchor-proof?eventId=event-01").expect(200);
    expect(proof.body.data.merkle_root).toMatch(/^0x[0-9a-f]{64}$/);
    // Live balances (mock reader) joined with the mock ledger's cost fold: value in USD, cost in KRW.
    const holdings = await browser.get("/api/portfolio/holdings").expect(200);
    expect(holdings.body.meta.provenance).toBe("mock");
    expect(holdings.body.data).toMatchObject({ walletAddresses: [account.address.toLowerCase()], skippedChainIds: [], truncatedChainIds: [], unpricedCount: 0 });
    expect(holdings.body.data.holdings.map((h: { symbol: string; chainId: number; amount: string; valueUsd: string }) => [h.symbol, h.chainId, h.amount, h.valueUsd])).toEqual([
      ["ETH", 1, "0.75", "2400"],
      ["USDT", 137, "850", "850"],
      ["USDC", 8453, "500", "500"],
    ]);
    expect(holdings.body.data.totalValueUsd).toBe("3750");
    // The mock ledger holds native ETH on chain 1, so ETH carries a KRW cost cell; the stables were never indexed.
    expect(holdings.body.data.holdings[0].costBasis).toMatchObject({ currency: "KRW" });
    expect(holdings.body.data.holdings[1].costBasis).toBeNull();
  });

  it("binds a watch-only wallet: 401 unauth, 400 invalid, 201 + checksum, session marks watch_only", async () => {
    const server = app.getHttpServer();
    const checksummed = "0x8A361b90E7F153eEdEb91ef2b2c7Fa4Dd68ceeee";
    await request(server).post("/api/auth/wallet/watch").send({ address: checksummed }).expect(401);

    const browser = request.agent(server);
    await browser.post("/api/auth/did/present").send({ country: "KR" }).expect(201);
    await browser.post("/api/auth/wallet/watch").send({ address: "0xnothex" }).expect(400);
    const watch = await browser.post("/api/auth/wallet/watch").send({ address: checksummed.toLowerCase() }).expect(201);
    expect(watch.body.data).toEqual({ walletAddress: checksummed });

    const session = await browser.get("/api/auth/session").expect(200);
    expect(session.body.data).toMatchObject({ walletAddress: checksummed, walletVerification: "watch_only" });
  });
});
