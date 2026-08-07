import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { BindingRecord } from "../shared/repository.types";
import type { WalletBindingRepository, WalletRepository } from "./wallet.repository";

@Injectable()
export class MockWalletRepository implements WalletBindingRepository, WalletRepository {
  private readonly bindings = new Map<string, BindingRecord>();
  async upsert(input: Omit<BindingRecord, "id" | "boundAt">) {
    const existing = [...this.bindings.values()].find((item) => item.userId === input.userId && item.walletAddress === input.walletAddress);
    const value = existing ? { ...existing, bindingHash: input.bindingHash } : { ...input, id: randomUUID(), boundAt: new Date() };
    this.bindings.set(value.id, value);
    return value;
  }
  async findLatestByUser(userId: string) { return [...this.bindings.values()].reverse().find((item) => item.userId === userId) ?? null; }
}

@Injectable()
export class PrismaWalletRepository implements WalletBindingRepository, WalletRepository {
  constructor(private readonly prisma: PrismaService) {}
  upsert(input: Omit<BindingRecord, "id" | "boundAt">) {
    return this.prisma.walletBinding.upsert({
      where: { userId_walletAddress: { userId: input.userId, walletAddress: input.walletAddress } },
      update: { bindingHash: input.bindingHash }, create: input,
    });
  }
  findLatestByUser(userId: string) { return this.prisma.walletBinding.findFirst({ where: { userId }, orderBy: { boundAt: "desc" } }); }
}
