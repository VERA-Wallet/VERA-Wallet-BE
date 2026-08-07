import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { IndexedTransaction } from "@vera/interfaces";
import { PrismaService } from "../shared/prisma.service";
import type { TransactionRecord } from "../shared/repository.types";
import type { TransactionRepository, TransactionSyncRepository } from "./transaction.repository";

@Injectable()
export class MockTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly bindingOwners = new Map<string, string>();
  async save(bindingId: string, userId: string, sourceItems: IndexedTransaction[]) {
    this.bindingOwners.set(bindingId, userId);
    const stored: TransactionRecord[] = [];
    for (const item of sourceItems) {
      const existing = [...this.transactions.values()].find((tx) => tx.bindingId === bindingId && tx.txHash === item.txHash && tx.eventType === item.eventType);
      if (existing) { stored.push(existing); continue; }
      const value = { id: randomUUID(), bindingId, txHash: item.txHash, eventType: item.eventType, chain: item.chain, payload: item.payload, occurredAt: item.occurredAt };
      this.transactions.set(value.id, value);
      stored.push(value);
    }
    return stored;
  }
  async listForUser(userId: string) { return [...this.transactions.values()].filter((item) => this.bindingOwners.get(item.bindingId) === userId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()); }
  async findForUser(userId: string, id: string) { return (await this.listForUser(userId)).find((tx) => tx.id === id || tx.payload.id === id) ?? null; }
  async updatePayload(userId: string, id: string, payload: Record<string, unknown>) { const existing = await this.findForUser(userId, id); if (!existing) return null; existing.payload = payload; return existing; }
}

@Injectable()
export class PrismaTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  constructor(private readonly prisma: PrismaService) {}
  async save(bindingId: string, _userId: string, sourceItems: IndexedTransaction[]) {
    await this.prisma.$transaction(sourceItems.map((item) => this.prisma.transactionRaw.create({ data: { source: item.source, payload: item.payload as Prisma.InputJsonValue } })));
    const result: TransactionRecord[] = [];
    for (const item of sourceItems) {
      const value = await this.prisma.transactionNormalized.upsert({
        where: { bindingId_txHash_eventType: { bindingId, txHash: item.txHash, eventType: item.eventType } },
        update: { payload: item.payload as Prisma.InputJsonValue, occurredAt: item.occurredAt },
        create: { bindingId, txHash: item.txHash, eventType: item.eventType, chain: item.chain, payload: item.payload as Prisma.InputJsonValue, occurredAt: item.occurredAt },
      });
      result.push({ ...value, payload: value.payload as Record<string, unknown> });
    }
    return result;
  }
  async listForUser(userId: string) { const values = await this.prisma.transactionNormalized.findMany({ where: { binding: { userId } }, orderBy: { occurredAt: "asc" } }); return values.map((value) => ({ ...value, payload: value.payload as Record<string, unknown> })); }
  async findForUser(userId: string, id: string) { return (await this.listForUser(userId)).find((tx) => tx.id === id || tx.payload.id === id) ?? null; }
  async updatePayload(userId: string, id: string, payload: Record<string, unknown>) {
    const existing = await this.findForUser(userId, id);
    if (!existing) return null;
    const value = await this.prisma.transactionNormalized.update({ where: { id: existing.id }, data: { payload: payload as Prisma.InputJsonValue } });
    return { ...value, payload: value.payload as Record<string, unknown> };
  }
}
