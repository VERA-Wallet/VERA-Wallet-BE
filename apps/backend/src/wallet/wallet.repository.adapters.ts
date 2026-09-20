import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { BindingRecord } from "../shared/repository.types";
import type { WalletBindingRepository, WalletRepository } from "./wallet.repository";

@Injectable()
export class MockWalletRepository implements WalletBindingRepository, WalletRepository {
  private readonly bindings = new Map<string, BindingRecord>();
  async upsert(input: Omit<BindingRecord, "id" | "boundAt" | "initialSyncedAt">) {
    const existing = [...this.bindings.values()].find((item) => item.userId === input.userId && item.walletAddress === input.walletAddress);
    const value: BindingRecord = existing
      ? { ...existing, bindingHash: input.bindingHash, verificationMethod: input.verificationMethod, verifiedAt: input.verifiedAt }
      : { ...input, id: randomUUID(), boundAt: new Date(), initialSyncedAt: null };
    this.bindings.set(value.id, value);
    return value;
  }
  async findByUserAndAddress(userId: string, walletAddress: string) { return [...this.bindings.values()].find((item) => item.userId === userId && item.walletAddress === walletAddress) ?? null; }
  async findLatestByUser(userId: string) { return [...this.bindings.values()].reverse().find((item) => item.userId === userId) ?? null; }
  async findAllByUser(userId: string) { return [...this.bindings.values()].filter((item) => item.userId === userId).sort((a, b) => a.boundAt.getTime() - b.boundAt.getTime()); }
  async markInitialSynced(bindingId: string, at: Date) { const value = this.bindings.get(bindingId); if (value) value.initialSyncedAt = at; }
  async delete(bindingId: string) { this.bindings.delete(bindingId); }
}

@Injectable()
export class PrismaWalletRepository implements WalletBindingRepository, WalletRepository {
  constructor(private readonly prisma: PrismaService) {}
  upsert(input: Omit<BindingRecord, "id" | "boundAt" | "initialSyncedAt">) {
    return this.prisma.walletBinding.upsert({
      where: { userId_walletAddress: { userId: input.userId, walletAddress: input.walletAddress } },
      update: { bindingHash: input.bindingHash, verificationMethod: input.verificationMethod, verifiedAt: input.verifiedAt }, create: input,
    });
  }
  findByUserAndAddress(userId: string, walletAddress: string) { return this.prisma.walletBinding.findUnique({ where: { userId_walletAddress: { userId, walletAddress } } }); }
  findLatestByUser(userId: string) { return this.prisma.walletBinding.findFirst({ where: { userId }, orderBy: { boundAt: "desc" } }); }
  findAllByUser(userId: string) { return this.prisma.walletBinding.findMany({ where: { userId }, orderBy: { boundAt: "asc" } }); }
  async markInitialSynced(bindingId: string, at: Date) { await this.prisma.walletBinding.update({ where: { id: bindingId }, data: { initialSyncedAt: at } }); }
  async delete(bindingId: string) { await this.prisma.walletBinding.delete({ where: { id: bindingId } }); }
}
