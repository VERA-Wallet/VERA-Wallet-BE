import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/shared/prisma.service";
import { ReportVcStore } from "../src/report-vc/report-vc.store";
const url = process.env.OPENDID_TEST_DATABASE_URL;
describe.skipIf(!url)("report VC durable concurrency", () => {
  let a: PrismaService; let b: PrismaService; let first: ReportVcStore; let second: ReportVcStore;
  const userId = randomUUID(); const ids: string[] = [];
  beforeAll(async () => {
    if (!url || new URL(url).pathname !== "/vera_opendid_test") throw new Error("Use isolated vera_opendid_test only");
    const old = process.env.DATABASE_URL; process.env.DATABASE_URL = url;
    a = new PrismaService(new ConfigService({ PERSISTENCE: "prisma" })); b = new PrismaService(new ConfigService({ PERSISTENCE: "prisma" }));
    await Promise.all([a.$connect(), b.$connect()]);
    if (old === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = old;
    first = new ReportVcStore(a); second = new ReportVcStore(b);
  });
  afterAll(async () => {
    if (a) { await a.reportVcAttempt.deleteMany({ where: { id: { in: ids } } }); await a.reportVcWallet.deleteMany({ where: { userId } }); await a.$disconnect(); }
    if (b) await b.$disconnect();
  });
  function row() {
    const id = randomUUID(); ids.push(id);
    return { id, userId, purpose: "link", secretHash: "hash", status: "pending", expiresAt: new Date(Date.now() + 60_000), nextPollAt: new Date(0) };
  }
  it("allows one active operation per account across two connections", async () => {
    const results = await Promise.allSettled([first.create(row()), second.create(row())]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    await a.reportVcAttempt.updateMany({ where: { userId }, data: { status: "cancelled" } });
  });
  it("fences completion after cancellation", async () => {
    const input = row(); const attempt = await first.create(input);
    expect(await first.acquire(attempt.id, "lease", new Date())).toBe(true);
    await second.cancel(attempt.id);
    await expect(first.complete(attempt, "lease", "linked", {}, { holder: "did:omn:cancelled", cxVerifiedAt: new Date() })).rejects.toThrow("attempt_cancelled");
    expect(await first.wallet(userId)).toBeNull();
  });
  it("only one polling process owns a lease", async () => {
    const attempt = await first.create(row());
    const result = await Promise.all([first.acquire(attempt.id, "a", new Date()), second.acquire(attempt.id, "b", new Date())]);
    expect(result.filter(Boolean)).toHaveLength(1);
  });
});
