import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import { historicalPriceKey, type HistoricalPriceKey, type HistoricalPriceRecord, type HistoricalPriceRepository } from "./historical-price.repository";

// Prisma caps a statement's parameter count and an OR of key triples costs three
// parameters each. Chunking keeps a 10k-key backfill probe inside that budget.
const GET_MANY_CHUNK = 200;

@Injectable()
export class MockHistoricalPriceRepository implements HistoricalPriceRepository {
  private readonly cache = new Map<string, string>();
  private key(chainId: number, assetKey: string, date: string) { return `${chainId}:${assetKey}:${date}`; }

  async get(chainId: number, assetKey: string, date: string): Promise<string | null> {
    return this.cache.get(this.key(chainId, assetKey, date)) ?? null;
  }

  async getMany(keys: readonly HistoricalPriceKey[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    for (const key of keys) {
      const mapKey = historicalPriceKey(key);
      const hit = this.cache.get(mapKey);
      if (hit !== undefined) found.set(mapKey, hit);
    }
    return found;
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

  async getMany(keys: readonly HistoricalPriceKey[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    // De-duplicate first: the backfill probes one key per (chain, day) but callers are
    // not required to, and a repeated key would otherwise cost extra OR branches.
    const unique = new Map<string, HistoricalPriceKey>();
    for (const key of keys) unique.set(historicalPriceKey(key), key);
    const pending = [...unique.values()];
    for (let offset = 0; offset < pending.length; offset += GET_MANY_CHUNK) {
      const chunk = pending.slice(offset, offset + GET_MANY_CHUNK);
      const rows = await this.prisma.historicalPrice.findMany({
        where: { OR: chunk.map(({ chainId, assetKey, date }) => ({ chainId, assetKey, date })) },
        select: { chainId: true, assetKey: true, date: true, krw: true },
      });
      for (const row of rows) found.set(historicalPriceKey(row), row.krw.toString());
    }
    return found;
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
