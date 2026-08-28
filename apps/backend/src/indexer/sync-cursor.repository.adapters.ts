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

  async advance(bindingId: string, chainId: number, head: bigint): Promise<void> {
    const key = this.key(bindingId, chainId);
    const existing = this.cursors.get(key);
    // Monotonic: never lower an already-recorded head.
    if (!existing || head > existing.lastSyncedBlock) this.cursors.set(key, { chainId, lastSyncedBlock: head });
  }
}

@Injectable()
export class PrismaSyncCursorRepository implements SyncCursorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listForBinding(bindingId: string): Promise<ChainCursor[]> {
    const rows = await this.prisma.bindingChainCursor.findMany({ where: { bindingId } });
    return rows.map((row) => ({ chainId: row.chainId, lastSyncedBlock: row.lastSyncedBlock }));
  }

  async advance(bindingId: string, chainId: number, head: bigint): Promise<void> {
    // Atomic monotonic upsert: GREATEST guarantees the stored block never regresses under out-of-order writes.
    await this.prisma.$executeRaw`
      INSERT INTO "BindingChainCursor" ("id", "bindingId", "chainId", "lastSyncedBlock", "lastSyncedAt")
      VALUES (${randomUUID()}, ${bindingId}, ${chainId}, ${head}, ${new Date()})
      ON CONFLICT ("bindingId", "chainId")
      DO UPDATE SET
        "lastSyncedBlock" = GREATEST("BindingChainCursor"."lastSyncedBlock", EXCLUDED."lastSyncedBlock"),
        "lastSyncedAt" = EXCLUDED."lastSyncedAt"
    `;
  }
}
