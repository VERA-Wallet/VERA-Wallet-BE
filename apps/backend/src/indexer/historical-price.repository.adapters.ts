import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { HistoricalPriceRecord, HistoricalPriceRepository } from "./historical-price.repository";

@Injectable()
export class MockHistoricalPriceRepository implements HistoricalPriceRepository {
  private readonly cache = new Map<string, string>();
  private key(chainId: number, assetKey: string, date: string) { return `${chainId}:${assetKey}:${date}`; }

  async get(chainId: number, assetKey: string, date: string): Promise<string | null> {
    return this.cache.get(this.key(chainId, assetKey, date)) ?? null;
  }

  async put(record: HistoricalPriceRecord): Promise<void> {
    this.cache.set(this.key(record.chainId, record.assetKey, record.date), record.krw);
  }
}

@Injectable()
export class PrismaHistoricalPriceRepository implements HistoricalPriceRepository {
  constructor(private readonly prisma: PrismaService) {}

  async get(chainId: number, assetKey: string, date: string): Promise<string | null> {
    const row = await this.prisma.historicalPrice.findUnique({
      where: { chainId_assetKey_date: { chainId, assetKey, date } },
    });
    return row ? row.krw.toString() : null;
  }

  async put(record: HistoricalPriceRecord): Promise<void> {
    // Idempotent: a concurrent resync of the same (asset, day) must not throw.
    await this.prisma.$executeRaw`
      INSERT INTO "HistoricalPrice" ("id", "chainId", "assetKey", "date", "krw", "fetchedAt")
      VALUES (${randomUUID()}, ${record.chainId}, ${record.assetKey}, ${record.date}, ${record.krw}::decimal, ${new Date()})
      ON CONFLICT ("chainId", "assetKey", "date") DO NOTHING
    `;
  }
}
