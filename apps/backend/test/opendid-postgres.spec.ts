import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/shared/prisma.service";
import { OpenDidAttemptStore, type DidAttempt } from "../src/auth/opendid-attempt.store";
import { PrismaIdentityRepository } from "../src/identity/identity.repository.adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Only opt into an explicitly isolated DB; never use the developer's DATABASE_URL.
const url = process.env.OPENDID_TEST_DATABASE_URL;
describe.skipIf(!url)("Open DID Postgres atomicity", () => {
  let a: PrismaService; let b: PrismaService;
  let first: OpenDidAttemptStore; let second: OpenDidAttemptStore;
  const ids: string[] = []; const hashes: string[] = [];
  const config = new ConfigService({ PERSISTENCE: "prisma" });
  beforeAll(async () => {
    if (!url || !new URL(url).pathname.endsWith("/vera_opendid_test")) throw new Error("Expected isolated vera_opendid_test database.");
    // PrismaService's default datasource reads env; save and restore after constructing each client.
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    a = new PrismaService(config); b = new PrismaService(config);
    await Promise.all([a.$connect(), b.$connect()]);
    if (previous === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previous;
    first = new OpenDidAttemptStore(config, a, new PrismaIdentityRepository(a));
    second = new OpenDidAttemptStore(config, b, new PrismaIdentityRepository(b));
  });
  afterAll(async () => {
    if (a) {
      await a.openDidAttempt.deleteMany({ where: { id: { in: ids } } });
      await a.identityVerification.deleteMany({ where: { user: { didHash: { in: hashes } } } });
      await a.user.deleteMany({ where: { didHash: { in: hashes } } });
      await a.$disconnect();
    }
    if (b) await b.$disconnect();
  });
  function attempt(): DidAttempt {
    const id = randomUUID(); ids.push(id);
    return { id, offerId: id, secretHash: "hash", policyId: "policy", country: "KR", expiresAt: new Date(Date.now() + 60000), status: "pending", leaseToken: null, leaseUntil: null, nextPollAt: new Date(0), consumedAt: null };
  }
  it("allows only one lease and one user verification commit across two clients", async () => {
    const row = attempt(); await first.create(row);
    const now = new Date(), until = new Date(Date.now() + 30000);
    const acquired = await Promise.all([first.acquire(row.id, "a", now, until), second.acquire(row.id, "b", now, until)]);
    expect(acquired.filter(Boolean)).toHaveLength(1);
    const token = acquired[0] ? "a" : "b";
    const didHash = `test-${randomUUID()}`; hashes.push(didHash);
    const identity = { didHash, method: "opendid" as const, verifiedAt: now };
    const completed = await Promise.all([first.complete(row.id, token, identity), second.complete(row.id, token, identity)]);
    expect(completed.filter(Boolean)).toHaveLength(1);
    expect(await a.identityVerification.count({ where: { user: { didHash } } })).toBe(1);
    expect((await second.find(row.offerId))?.status).toBe("consumed");
  });
  it("fences a stale worker after lease recovery and invalidates an old browser attempt", async () => {
    const row = attempt(); await first.create(row);
    await first.acquire(row.id, "stale", new Date(), new Date(Date.now() - 1));
    expect(await second.acquire(row.id, "new", new Date(), new Date(Date.now() + 10000))).toBe(true);
    const didHash = `test-${randomUUID()}`; hashes.push(didHash);
    expect(await first.complete(row.id, "stale", { didHash, method: "opendid", verifiedAt: new Date() })).toBeNull();
    const replacement = attempt(); await second.create(replacement, row.secretHash);
    expect((await first.find(row.offerId))?.status).toBe("expired");
    expect(await second.complete(row.id, "new", { didHash, method: "opendid", verifiedAt: new Date() })).toBeNull();
  });
  it("rolls back consumption if the user transaction fails", async () => {
    const row = attempt(); await first.create(row); await first.acquire(row.id, "lease", new Date(), new Date(Date.now() + 10000));
    await expect(first.complete(row.id, "lease", { didHash: "never-written", method: "opendid", verifiedAt: new Date("invalid") })).rejects.toThrow();
    expect((await second.find(row.offerId))?.status).toBe("processing");
  });
});
