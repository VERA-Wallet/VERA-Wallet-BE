import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { IndexedTransaction } from "@vera/interfaces";
import { PrismaService } from "../shared/prisma.service";
import type { TransactionRecord } from "../shared/repository.types";
import type { TransactionRepository, TransactionSyncRepository } from "./transaction.repository";

// Edit-preserving merge: a provider resync updates provider-derived fields but must NOT
// erase user edits. user_override / _version / _overrideHistory always survive; an overridden
// row also keeps its user classification and original anchor hash (so it is never re-anchored).
export function mergeSavedPayload(existing: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const overridden = existing.user_override !== null && existing.user_override !== undefined;
  return {
    ...incoming,
    user_override: existing.user_override ?? null,
    _version: existing._version ?? incoming._version ?? 1,
    _overrideHistory: existing._overrideHistory ?? incoming._overrideHistory ?? [],
    ...(overridden ? { classification: existing.classification, _anchorPayloadHash: existing._anchorPayloadHash } : {}),
  };
}

@Injectable()
export class MockTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  private readonly transactions = new Map<string, TransactionRecord>();
  private readonly bindingOwners = new Map<string, string>();
  async save(bindingId: string, userId: string, sourceItems: IndexedTransaction[]) {
    this.bindingOwners.set(bindingId, userId);
    const stored: TransactionRecord[] = [];
    for (const item of sourceItems) {
      const existing = [...this.transactions.values()].find((tx) => tx.bindingId === bindingId && tx.txHash === item.txHash && tx.eventType === item.eventType);
      if (existing) {
        Object.assign(existing, { payload: mergeSavedPayload(existing.payload, item.payload), occurredAt: item.occurredAt });
        stored.push(existing);
        continue;
      }
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
      const key = { bindingId, txHash: item.txHash, eventType: item.eventType };
      // find+merge+upsert in one interactive transaction to narrow the concurrent-PATCH window.
      // (A fully lost-update-free guarantee needs row-level locking; a simultaneous PATCH-vs-resync
      // race remains a documented single-process phase-1 limitation.)
      const value = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.transactionNormalized.findUnique({ where: { bindingId_txHash_eventType: key } });
        const payload = (existing ? mergeSavedPayload(existing.payload as Record<string, unknown>, item.payload) : item.payload) as Prisma.InputJsonValue;
        return tx.transactionNormalized.upsert({
          where: { bindingId_txHash_eventType: key },
          update: { payload, occurredAt: item.occurredAt },
          create: { bindingId, txHash: item.txHash, eventType: item.eventType, chain: item.chain, payload, occurredAt: item.occurredAt },
        });
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

/**
 * 사용자별 원장 스냅샷 캐시(프로세스 메모리).
 *
 * 읽기 경로는 페이지마다 그 사용자의 전체 이력을 다시 읽고(1만 4천 행) 원가 fold를 통째로 다시 돌렸다 — 13페이지짜리
 * 대시보드 한 번에 같은 일을 13번 했다. 모든 쓰기(save·updatePayload)가 이 데코레이터를 지나므로 쓰기 때 그 사용자의
 * 스냅샷을 비우면 읽기는 항상 최신을 본다. TTL은 안전망이다(놓친 쓰기 경로·다중 프로세스 배포).
 * 같은 배열 인스턴스를 돌려주므로 호출자는 배열 동일성으로 파생 계산(원가 fold)을 메모할 수 있다.
 */
export const LEDGER_SNAPSHOT_TTL_MS = 60_000;

export class CachedTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  private readonly snapshots = new Map<string, { at: number; rows: TransactionRecord[] }>();
  private readonly inflight = new Map<string, Promise<TransactionRecord[]>>();

  constructor(
    private readonly inner: TransactionRepository & TransactionSyncRepository,
    private readonly ttlMs: number = LEDGER_SNAPSHOT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async listForUser(userId: string): Promise<TransactionRecord[]> {
    const hit = this.snapshots.get(userId);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.rows;
    // 동시에 들어온 읽기(대시보드의 목록+요약 병렬 조회)는 한 번의 DB 읽기를 나눠 쓴다.
    const pending = this.inflight.get(userId);
    if (pending) return pending;
    const load = this.inner.listForUser(userId)
      .then((rows) => {
        this.snapshots.set(userId, { at: this.now(), rows });
        return rows;
      })
      .finally(() => {
        if (this.inflight.get(userId) === load) this.inflight.delete(userId);
      });
    this.inflight.set(userId, load);
    return load;
  }

  async findForUser(userId: string, id: string): Promise<TransactionRecord | null> {
    return (await this.listForUser(userId)).find((tx) => tx.id === id || tx.payload.id === id) ?? null;
  }

  async updatePayload(userId: string, id: string, payload: Record<string, unknown>): Promise<TransactionRecord | null> {
    const updated = await this.inner.updatePayload(userId, id, payload);
    this.invalidate(userId);
    return updated;
  }

  async save(bindingId: string, userId: string, sourceItems: IndexedTransaction[]): Promise<TransactionRecord[]> {
    const stored = await this.inner.save(bindingId, userId, sourceItems);
    this.invalidate(userId);
    return stored;
  }

  invalidate(userId?: string): void {
    if (userId === undefined) this.snapshots.clear();
    else this.snapshots.delete(userId);
  }
}
