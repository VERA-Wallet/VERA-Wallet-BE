import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { AnchorRecordView } from "../shared/repository.types";
import type { AnchorRepository } from "./anchor.repository";

@Injectable()
export class MockAnchorRepository implements AnchorRepository {
  private readonly anchors = new Map<string, AnchorRecordView>();
  async create(payloadHash: string, anchorType: string) {
    const existing = this.anchors.get(payloadHash);
    if (existing) return existing;
    const value: AnchorRecordView = { id: randomUUID(), payloadHash, anchorType, chainTxHash: null, blockNumber: null, status: "pending", attempts: 0, anchoredAt: null, createdAt: new Date() };
    this.anchors.set(payloadHash, value);
    return value;
  }
  async findByHash(payloadHash: string) { return this.anchors.get(payloadHash) ?? null; }
  async incrementAttempts(payloadHash: string) { const value = this.anchors.get(payloadHash); if (value) value.attempts += 1; }
  async markAnchored(payloadHash: string, txHash: string, blockNumber: bigint, anchoredAt: Date) { const value = this.anchors.get(payloadHash); if (value) Object.assign(value, { status: "anchored", chainTxHash: txHash, blockNumber, anchoredAt }); }
  async markFailed(payloadHash: string) { const value = this.anchors.get(payloadHash); if (value) value.status = "failed"; }
}

@Injectable()
export class PrismaAnchorRepository implements AnchorRepository {
  constructor(private readonly prisma: PrismaService) {}
  create(payloadHash: string, anchorType: string) { return this.prisma.anchorRecord.upsert({ where: { payloadHash }, update: {}, create: { payloadHash, anchorType } }); }
  findByHash(payloadHash: string) { return this.prisma.anchorRecord.findUnique({ where: { payloadHash } }); }
  async incrementAttempts(payloadHash: string) { await this.prisma.anchorRecord.update({ where: { payloadHash }, data: { attempts: { increment: 1 } } }); }
  async markAnchored(payloadHash: string, txHash: string, blockNumber: bigint, anchoredAt: Date) { await this.prisma.anchorRecord.update({ where: { payloadHash }, data: { status: "anchored", chainTxHash: txHash, blockNumber, anchoredAt } }); }
  async markFailed(payloadHash: string) { await this.prisma.anchorRecord.update({ where: { payloadHash }, data: { status: "failed" } }); }
}
