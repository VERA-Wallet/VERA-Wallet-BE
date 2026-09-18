import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { ChainCursor, SyncCursorRepository } from "./sync-cursor.repository";

@Injectable()
export class MockSyncCursorRepository implements SyncCursorRepository {
  private readonly cursors = new Map<string, ChainCursor>();
  private key(bindingId: string, chainId: number) { return `${bindingId}:${chainId}`; }

  async listForBinding(bindingId: string): Promise<ChainCursor[]> {
    return [...this.cursors.entries()]
      .filter(([key]) => key.startsWith(`${bindingId}:`))
      .map(([, cursor]) => ({ ...cursor }));
  }

  async advance(bindingId: string, chainId: number, head: bigint, rulesVersion: number): Promise<void> {
    const key = this.key(bindingId, chainId);
    const existing = this.cursors.get(key);
    if (!existing) {
      this.cursors.set(key, { chainId, lastSyncedBlock: head, rulesVersion });
      return;
    }
    // Monotonic on both fields (mirrors the Prisma adapter's GREATEST): never lower a recorded head, never
    // roll a chain back to older rules.
    existing.lastSyncedBlock = head > existing.lastSyncedBlock ? head : existing.lastSyncedBlock;
    existing.rulesVersion = Math.max(existing.rulesVersion, rulesVersion);
  }
}

@Injectable()
export class PrismaSyncCursorRepository implements SyncCursorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForBinding(bindingId: string): Promise<ChainCursor[]> {
    const rows = await this.prisma.bindingChainCursor.findMany({ where: { bindingId } });
    return rows.map((row) => ({ chainId: row.chainId, lastSyncedBlock: row.lastSyncedBlock, rulesVersion: row.rulesVersion }));
  }

  async advance(bindingId: string, chainId: number, head: bigint, rulesVersion: number): Promise<void> {
    // Atomic monotonic upsert: GREATEST guarantees neither the stored block nor the rules version regresses
    // under out-of-order writes.
    await this.prisma.$executeRaw`
      INSERT INTO "BindingChainCursor" ("id", "bindingId", "chainId", "lastSyncedBlock", "lastSyncedAt", "rulesVersion")
      VALUES (${randomUUID()}, ${bindingId}, ${chainId}, ${head}, ${new Date()}, ${rulesVersion})
      ON CONFLICT ("bindingId", "chainId")
      DO UPDATE SET
        "lastSyncedBlock" = GREATEST("BindingChainCursor"."lastSyncedBlock", EXCLUDED."lastSyncedBlock"),
        "rulesVersion" = GREATEST("BindingChainCursor"."rulesVersion", EXCLUDED."rulesVersion"),
        "lastSyncedAt" = EXCLUDED."lastSyncedAt"
    `;
  }
}
