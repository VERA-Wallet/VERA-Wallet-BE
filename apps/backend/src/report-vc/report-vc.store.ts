import { Injectable } from "@nestjs/common";
import { Prisma, type ReportVcAttempt } from "@prisma/client";
import { PrismaService } from "../shared/prisma.service";
import { reject } from "./report-vc.policy";

export type Attempt = ReportVcAttempt;
export const jsonValue = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
@Injectable()
export class ReportVcStore {
  constructor(private readonly db: PrismaService) {}
  cleanup() {
    return this.db.reportVcAttempt.deleteMany({ where: { expiresAt: { lt: new Date(Date.now() - 86_400_000) } } });
  }
  cx(userId: string) {
    return this.db.identityVerification.findFirst({ where: { userId, method: "omnione_cx" }, orderBy: { verifiedAt: "desc" } });
  }
  wallet(userId: string) { return this.db.reportVcWallet.findUnique({ where: { userId } }); }
  async unlink(userId: string) {
    await this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const active = await tx.reportVcAttempt.count({ where: { userId, status: { in: ["creating", "pending"] }, expiresAt: { gt: new Date() } } });
      if (active) reject("issuance_in_progress");
      await tx.reportVcWallet.deleteMany({ where: { userId } });
    });
  }
  evidence(userId: string, merkleRoot: string) { return this.db.taxEvidence.findUnique({ where: { userId_merkleRoot: { userId, merkleRoot } } }); }
  latestEvidence(userId: string, countryCode: string, taxYear: number) {
    return this.db.taxEvidence.findFirst({ where: { userId, countryCode, taxYear }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  }
  credential(id: string) { return this.db.reportVcCredential.findUnique({ where: { id } }); }
  latestAttempt(userId: string, evidenceRoot: string) {
    return this.db.reportVcAttempt.findFirst({ where: { userId, evidenceRoot, purpose: "issue" }, orderBy: { createdAt: "desc" } });
  }
  attempt(id: string) { return this.db.reportVcAttempt.findUnique({ where: { id } }); }
  async create(data: Prisma.ReportVcAttemptUncheckedCreateInput) {
    return this.db.$transaction(async tx => {
      // Serializes simultaneous link/issue/unlink operations for the account, across BE processes.
      if (data.userId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${data.userId}))`;
      if (data.userId && data.idempotencyKey) {
        const existing = await tx.reportVcAttempt.findUnique({ where: { userId_idempotencyKey: { userId: data.userId, idempotencyKey: data.idempotencyKey } } });
        if (existing) {
          if (existing.requestHash !== data.requestHash) reject("idempotency_conflict");
          return existing;
        }
      }
      if (data.userId) {
        const wallet = await tx.reportVcWallet.findUnique({ where: { userId: data.userId } });
        if (data.purpose === "link" && wallet) reject("wallet_already_linked");
        if (data.purpose === "issue" && (!wallet || wallet.holderDid !== data.holderDid)) reject("wallet_unlinked");
        if (await tx.reportVcAttempt.count({ where: { userId: data.userId, status: { in: ["creating", "pending"] }, expiresAt: { gt: new Date() } } })) reject("issuance_in_progress");
      }
      return tx.reportVcAttempt.create({ data });
    });
  }
  async activate(id: string, upstreamId: string, offer: unknown, expiresAt: Date) {
    await this.db.reportVcAttempt.updateMany({ where: { id, status: "creating" }, data: { status: "pending", upstreamId, offer: jsonValue(offer), expiresAt } });
  }
  async fail(id: string) { await this.db.reportVcAttempt.updateMany({ where: { id, status: "creating" }, data: { status: "failed" } }); }
  async cancel(id: string) {
    await this.db.reportVcAttempt.updateMany({ where: { id, status: { in: ["creating", "pending"] } }, data: { status: "cancelled", leaseToken: null, leaseUntil: null } });
  }
  async acquire(id: string, token: string, now: Date) {
    const changed = await this.db.reportVcAttempt.updateMany({ where: {
      id, status: "pending", expiresAt: { gt: now }, nextPollAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    }, data: { leaseToken: token, leaseUntil: new Date(now.getTime() + 60_000), nextPollAt: new Date(now.getTime() + 2000) } });
    return changed.count === 1;
  }
  async release(id: string, token: string) {
    await this.db.reportVcAttempt.updateMany({ where: { id, leaseToken: token }, data: { leaseToken: null, leaseUntil: null } });
  }
  async complete(row: Attempt, token: string, status: string, result: unknown, detail?: { holder: string; cxVerifiedAt: Date } | { credentialId: string; issuedAt: Date; countryCode: string; taxYear: number }) {
    await this.db.$transaction(async tx => {
      if (row.userId) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${row.userId}))`;
      const changed = await tx.reportVcAttempt.updateMany({ where: { id: row.id, leaseToken: token, leaseUntil: { gt: new Date() }, expiresAt: { gt: new Date() }, status: "pending" }, data: { status, result: jsonValue(result), leaseToken: null, leaseUntil: null } });
      if (!changed.count) reject("attempt_cancelled");
      if (detail && "holder" in detail) {
        if (!row.userId) reject("unauthorized", 401);
        const sameDid = await tx.reportVcWallet.findUnique({ where: { holderDid: detail.holder } });
        if (sameDid && sameDid.userId !== row.userId) reject("did_linked_to_other_account");
        // Unique constraints remain the final guard against concurrent claims by different users.
        try {
          await tx.reportVcWallet.create({ data: { userId: row.userId, holderDid: detail.holder, cxVerifiedAt: detail.cxVerifiedAt } });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") reject("did_linked_to_other_account");
          throw error;
        }
      }
      if (detail && "credentialId" in detail) {
        await tx.reportVcCredential.create({ data: { id: detail.credentialId, issuanceId: row.id, userId: row.userId!, holderDid: row.holderDid!, evidenceRoot: row.evidenceRoot!, countryCode: detail.countryCode, taxYear: detail.taxYear, snapshot: jsonValue(row.snapshot), issuedAt: detail.issuedAt } });
      }
    });
  }
}
