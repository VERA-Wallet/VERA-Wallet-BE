import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { UserRecord } from "../shared/repository.types";
import type { UserRepository, VerifiedIdentityRepository } from "./identity.repository";

@Injectable()
export class MockIdentityRepository implements VerifiedIdentityRepository, UserRepository {
  private readonly users = new Map<string, UserRecord>();
  private readonly userIdsByDid = new Map<string, string>();
  async upsertVerifiedUser(didHash: string, _method: string, _verifiedAt: Date) {
    const existingId = this.userIdsByDid.get(didHash);
    const user = existingId ? this.users.get(existingId)! : { id: randomUUID(), didHash, createdAt: new Date() };
    this.users.set(user.id, user);
    this.userIdsByDid.set(didHash, user.id);
    return user;
  }
  async getUser(id: string) { return this.users.get(id) ?? null; }
}

@Injectable()
export class PrismaIdentityRepository implements VerifiedIdentityRepository, UserRepository {
  constructor(private readonly prisma: PrismaService) {}
  async upsertVerifiedUser(didHash: string, method: string, verifiedAt: Date) {
    return this.prisma.$transaction(async (transaction) => {
      const user = await transaction.user.upsert({ where: { didHash }, update: {}, create: { didHash } });
      await transaction.identityVerification.create({ data: { userId: user.id, method, verifiedAt } });
      return user;
    });
  }
  getUser(id: string) { return this.prisma.user.findUnique({ where: { id } }); }
}
