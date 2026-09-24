import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { VerifiedIdentity } from "@vera/interfaces";
import { PrismaService } from "../shared/prisma.service";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { IDENTITY_REPOSITORY } from "../identity/identity.tokens";
import type { VerifiedIdentityRepository } from "../identity/identity.repository";

export interface DidAttempt {
  id: string; offerId: string; secretHash: string; policyId: string; country: string;
  expiresAt: Date; status: string; leaseToken: string | null; leaseUntil: Date | null;
  nextPollAt: Date; consumedAt: Date | null;
}
@Injectable()
export class OpenDidAttemptStore {
  private readonly memory = new Map<string, DidAttempt>();
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: VerifiedIdentityRepository) {}
  private get persistent() { return usePrismaPersistence(this.config); }
  async create(attempt: DidAttempt, previousHash?: string) {
    if (this.persistent) {
      await this.prisma.$transaction(async tx => {
        if (previousHash) await tx.openDidAttempt.updateMany({ where: { secretHash: previousHash, status: { in: ["pending", "processing"] } }, data: { status: "expired", leaseToken: null } });
        await tx.openDidAttempt.create({ data: attempt });
      });
    } else {
      if (previousHash) for (const row of this.memory.values()) if (row.secretHash === previousHash && ["pending", "processing"].includes(row.status)) { row.status = "expired"; row.leaseToken = null; }
      this.memory.set(attempt.offerId, { ...attempt });
    }
  }
  async find(offerId: string): Promise<DidAttempt | null> {
    if (this.persistent) return this.prisma.openDidAttempt.findUnique({ where: { offerId } });
    const row = this.memory.get(offerId);
    return row ? { ...row } : null;
  }
  async acquire(id: string, token: string, now: Date, leaseUntil: Date): Promise<boolean> {
    if (this.persistent) {
      const result = await this.prisma.openDidAttempt.updateMany({
        where: { id, expiresAt: { gt: now }, nextPollAt: { lte: now }, OR: [{ status: "pending" }, { status: "processing", leaseUntil: { lte: now } }] },
        data: { status: "processing", leaseToken: token, leaseUntil },
      });
      return result.count === 1;
    }
    const row = [...this.memory.values()].find(r => r.id === id);
    if (!row || row.expiresAt <= now || row.nextPollAt > now || !(row.status === "pending" || row.status === "processing" && row.leaseUntil && row.leaseUntil <= now)) return false;
    Object.assign(row, { status: "processing", leaseToken: token, leaseUntil });
    return true;
  }
  async release(id: string, token: string, status: string, nextPollAt: Date) {
    if (this.persistent) {
      await this.prisma.openDidAttempt.updateMany({ where: { id, status: "processing", leaseToken: token }, data: { status, nextPollAt, leaseToken: null, leaseUntil: null } });
    } else {
      const row = [...this.memory.values()].find(r => r.id === id && r.leaseToken === token && r.status === "processing");
      if (row) Object.assign(row, { status, nextPollAt, leaseToken: null, leaseUntil: null });
    }
  }
  async complete(id: string, token: string, identity: VerifiedIdentity) {
    const now = new Date();
    if (this.persistent) return this.prisma.$transaction(async tx => {
      const changed = await tx.openDidAttempt.updateMany({ where: { id, leaseToken: token, status: "processing", expiresAt: { gt: now }, leaseUntil: { gt: now } }, data: { status: "consumed", consumedAt: now, leaseToken: null, leaseUntil: null } });
      if (changed.count !== 1) return null;
      const user = await tx.user.upsert({ where: { didHash: identity.didHash }, create: { didHash: identity.didHash }, update: {} });
      await tx.identityVerification.create({ data: { userId: user.id, method: identity.method, verifiedAt: identity.verifiedAt } });
      return user;
    });
    const row = [...this.memory.values()].find(r => r.id === id && r.leaseToken === token && r.status === "processing" && r.expiresAt > now && r.leaseUntil && r.leaseUntil > now);
    if (!row) return null;
    // Claim before awaiting so concurrent callers cannot both upsert.
    row.status = "consumed"; row.consumedAt = now; row.leaseToken = null;
    return this.identities.upsertVerifiedUser(identity.didHash, identity.method, identity.verifiedAt);
  }
  async cleanup(now = new Date()) {
    // Keep terminal records only until expiration; stale cookies fail closed after removal.
    if (this.persistent) await this.prisma.openDidAttempt.deleteMany({ where: { expiresAt: { lte: new Date(now.getTime() - 60_000) } } });
    else for (const [key, row] of this.memory) if (row.expiresAt.getTime() <= now.getTime() - 60_000) this.memory.delete(key);
  }
}
