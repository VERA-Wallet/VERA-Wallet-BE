import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { IndexedTransaction } from "@vera/interfaces";
import { PrismaService } from "../shared/prisma.service";
import type { TransactionRecord } from "../shared/repository.types";
import type { EmittedLeg, SupersededPurgeResult, TransactionRepository, TransactionSyncRepository } from "./transaction.repository";

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

// ---------------------------------------------------------------------------
// Superseded-row purge
// ---------------------------------------------------------------------------

/** The subset of a stored row the purge planner reasons about. */
type PurgeRow = { id: string; txHash: string; eventType: string; payload: Record<string, unknown> };

/** Row-level instructions for one purge pass; the adapters just execute them. */
export type SupersededPurgePlan = {
  deleteIds: string[];
  carries: { rowId: string; payload: Record<string, unknown> }[];
  preserved: string[];
};

const EMPTY_PURGE: SupersededPurgePlan = { deleteIds: [], carries: [], preserved: [] };
const isOverridden = (payload: Record<string, unknown>) => payload.user_override !== null && payload.user_override !== undefined;
const versionOf = (payload: Record<string, unknown>) => Number(payload._version ?? 1);

/**
 * Decide which stored rows a fresh normalization has superseded. Pure, so both adapters share one
 * rule set and the rules are testable without a database.
 *
 * Rule A (moved leg): a row whose storage id was re-emitted under a DIFFERENT eventType is stale —
 * the same leg now lives in the newly written row.
 * Rule B (netted leg): a row whose storage id appears in some emitted row's `netted_leg_ids` was
 * folded into that row and no longer owns one.
 * A row that was re-emitted exactly (same id AND same eventType) is always a survivor.
 *
 * User edits are never silently dropped. A Rule-A row carrying `user_override` is merged FORWARD onto
 * its survivor with the same edit-preserving merge a resync uses (`mergeSavedPayload`), so the override,
 * version, history and original anchor hash follow the leg to its new eventType — then the old row goes.
 * Only one override can move per leg (the highest `_version`); any further overridden row, and every
 * overridden Rule-B row (its edit has no home once the leg is absorbed), is left in place and reported.
 */
export function planSupersededPurge(rows: PurgeRow[], emitted: EmittedLeg[]): SupersededPurgePlan {
  if (emitted.length === 0) return EMPTY_PURGE;
  const emittedTypes = new Map<string, Set<string>>();
  const absorbed = new Set<string>();
  for (const leg of emitted) {
    const types = emittedTypes.get(leg.id) ?? new Set<string>();
    types.add(leg.eventType);
    emittedTypes.set(leg.id, types);
    for (const nettedId of leg.nettedLegIds) absorbed.add(nettedId);
  }

  const survivors = new Map<string, PurgeRow>();
  const staleByLeg = new Map<string, PurgeRow[]>();
  const preserved: string[] = [];
  for (const row of rows) {
    const types = emittedTypes.get(row.txHash);
    if (types?.has(row.eventType)) {
      // Deterministic survivor per storage id (an id emitted under two eventTypes is not expected,
      // but the merge target must not depend on row order).
      const current = survivors.get(row.txHash);
      if (!current || row.eventType < current.eventType) survivors.set(row.txHash, row);
      continue;
    }
    if (types === undefined && !absorbed.has(row.txHash)) continue; // untouched by this pass
    staleByLeg.set(row.txHash, [...(staleByLeg.get(row.txHash) ?? []), row]);
  }

  const deleteIds: string[] = [];
  const carries: { rowId: string; payload: Record<string, unknown> }[] = [];
  for (const [storageId, stale] of staleByLeg) {
    const survivor = survivors.get(storageId);
    if (emittedTypes.has(storageId) && !survivor) {
      // Rule A without the row it moved to (the write that should have produced it is missing).
      // Deleting here would drop the leg entirely, so keep everything and let the next pass converge.
      for (const row of stale) preserved.push(`${row.txHash}#${row.eventType}`);
      continue;
    }
    const overridden = stale.filter((row) => isOverridden(row.payload))
      .sort((a, b) => versionOf(b.payload) - versionOf(a.payload) || a.id.localeCompare(b.id));
    const [carrier, ...alsoOverridden] = overridden;
    const kept = new Set(alsoOverridden.map((row) => row.id));
    for (const row of alsoOverridden) preserved.push(`${row.txHash}#${row.eventType}`);
    if (carrier && survivor) {
      carries.push({ rowId: survivor.id, payload: mergeSavedPayload(carrier.payload, survivor.payload) });
    } else if (carrier) {
      kept.add(carrier.id); // absorbed leg (Rule B): the edit has no row to move onto
      preserved.push(`${carrier.txHash}#${carrier.eventType}`);
    }
    for (const row of stale) if (!kept.has(row.id)) deleteIds.push(row.id);
  }
  return { deleteIds, carries, preserved };
}

const purgeResult = (plan: SupersededPurgePlan, logger: Logger, bindingId: string): SupersededPurgeResult => {
  if (plan.preserved.length > 0) {
    // A user-edited row that this normalization no longer produces: kept on purpose, so the FE may
    // still show it next to the new row. Deleting it would silently discard the user's decision.
    logger.warn(`binding ${bindingId}: kept ${plan.preserved.length} user-edited superseded row(s): ${plan.preserved.join(", ")}`);
  }
  return { deleted: plan.deleteIds.length, carriedOverrides: plan.carries.length, preserved: plan.preserved };
};

/** Postgres bind-parameter budget for the `txHash IN (...)` lookup of a heavy full resync. */
const PURGE_LOOKUP_CHUNK = 1_000;

@Injectable()
export class MockTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  private static readonly logger = new Logger(MockTransactionRepository.name);
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
  async deleteSupersededRows(bindingId: string, _userId: string, emitted: EmittedLeg[]) {
    const plan = planSupersededPurge([...this.transactions.values()].filter((row) => row.bindingId === bindingId), emitted);
    for (const carry of plan.carries) {
      const row = this.transactions.get(carry.rowId);
      if (row) row.payload = carry.payload;
    }
    for (const id of plan.deleteIds) this.transactions.delete(id);
    return purgeResult(plan, MockTransactionRepository.logger, bindingId);
  }
  async listForUser(userId: string) { return [...this.transactions.values()].filter((item) => this.bindingOwners.get(item.bindingId) === userId).sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime()); }
  async findForUser(userId: string, id: string) { return (await this.listForUser(userId)).find((tx) => tx.id === id || tx.payload.id === id) ?? null; }
  async updatePayload(userId: string, id: string, payload: Record<string, unknown>) { const existing = await this.findForUser(userId, id); if (!existing) return null; existing.payload = payload; return existing; }
}

@Injectable()
export class PrismaTransactionRepository implements TransactionRepository, TransactionSyncRepository {
  private static readonly logger = new Logger(PrismaTransactionRepository.name);
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

  /**
   * Anchors are NOT touched here. `AnchorRecord` is keyed by `payloadHash` with no relation to
   * `TransactionNormalized` (a deliberate privacy boundary), so nothing blocks the delete, and an
   * anchor stays a valid timestamped proof that the payload existed — it is an append-only log, not
   * a mirror of the current ledger. `TaxEvent.txId` IS a required FK with no cascade, so its children
   * are removed first, in the same transaction. `TransactionRaw` is never touched.
   */
  async deleteSupersededRows(bindingId: string, _userId: string, emitted: EmittedLeg[]) {
    if (emitted.length === 0) return purgeResult(EMPTY_PURGE, PrismaTransactionRepository.logger, bindingId);
    // Only rows that could possibly be superseded are read: a re-emitted leg's own id (Rule A) or an
    // id some emitted row absorbed (Rule B).
    const lookupIds = [...new Set(emitted.flatMap((leg) => [leg.id, ...leg.nettedLegIds]))];
    const rows: PurgeRow[] = [];
    for (let index = 0; index < lookupIds.length; index += PURGE_LOOKUP_CHUNK) {
      const found = await this.prisma.transactionNormalized.findMany({ where: { bindingId, txHash: { in: lookupIds.slice(index, index + PURGE_LOOKUP_CHUNK) } } });
      for (const row of found) rows.push({ id: row.id, txHash: row.txHash, eventType: row.eventType, payload: row.payload as Record<string, unknown> });
    }
    const plan = planSupersededPurge(rows, emitted);
    if (plan.deleteIds.length > 0) {
      // A deleted row takes its TaxEvent children with it (required FK, no cascade). If one of them was
      // already filed into a generated report, that report's stored totalGain now disagrees with its
      // line items — the report is a snapshot and is never recomputed here. Report it loudly; deciding
      // what a re-normalization does to an issued report is a tax-module concern, not a repository one.
      const filed = await this.prisma.taxEvent.count({ where: { txId: { in: plan.deleteIds }, reportId: { not: null } } });
      if (filed > 0) PrismaTransactionRepository.logger.warn(`binding ${bindingId}: purged ${filed} tax event(s) already filed into a report; report totals are now stale.`);
    }
    if (plan.deleteIds.length > 0 || plan.carries.length > 0) {
      await this.prisma.$transaction([
        ...plan.carries.map((carry) => this.prisma.transactionNormalized.update({ where: { id: carry.rowId }, data: { payload: carry.payload as Prisma.InputJsonValue } })),
        this.prisma.taxEvent.deleteMany({ where: { txId: { in: plan.deleteIds } } }),
        this.prisma.transactionNormalized.deleteMany({ where: { id: { in: plan.deleteIds } } }),
      ]);
    }
    return purgeResult(plan, PrismaTransactionRepository.logger, bindingId);
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

  async deleteSupersededRows(bindingId: string, userId: string, emitted: EmittedLeg[]): Promise<SupersededPurgeResult> {
    const result = await this.inner.deleteSupersededRows(bindingId, userId, emitted);
    this.invalidate(userId);
    return result;
  }

  invalidate(userId?: string): void {
    if (userId === undefined) this.snapshots.clear();
    else this.snapshots.delete(userId);
  }
}
