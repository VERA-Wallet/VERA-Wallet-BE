import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { PrismaService } from "../shared/prisma.service";
import type { HistoricalPriceOracle } from "./historical-price-oracle";
import type { HistoricalPriceRepository } from "./historical-price.repository";
import { HISTORICAL_PRICE_ORACLE, HISTORICAL_PRICE_REPOSITORY } from "./indexer.tokens";
import { NativePriceBackfill, PrismaLedgerChainDaySource } from "./native-price-backfill";

// Entry point for `pnpm --filter @vera/backend backfill:native-prices [--dry-run]`.
//
// Kept apart from native-price-backfill.ts so importing the backfill logic (from its spec,
// or anywhere else later) can never boot a Nest context as a side effect.
//
// It boots the real AppModule rather than a hand-rolled module so the backfill writes
// through exactly the repository and oracle the running app reads from; a second wiring
// could silently target a different cache.
async function main(): Promise<void> {
  const logger = new Logger("NativePriceBackfill");
  const dryRun = process.argv.includes("--dry-run");

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });
  try {
    // Without Prisma persistence the ledger scan has no database and the cache it would
    // fill is a per-process Map that dies with this command. Refuse rather than report a
    // successful backfill that repaired nothing.
    if (!usePrismaPersistence(app.get(ConfigService))) {
      logger.error("Refusing to run: PERSISTENCE is not prisma, so there is no stored ledger to scan and no durable cache to fill.");
      process.exitCode = 1;
      return;
    }
    const prisma = app.get(PrismaService);
    const cache = app.get<HistoricalPriceRepository>(HISTORICAL_PRICE_REPOSITORY);
    const oracle = app.get<HistoricalPriceOracle>(HISTORICAL_PRICE_ORACLE);

    const backfill = new NativePriceBackfill(new PrismaLedgerChainDaySource(prisma), cache, oracle, {
      log: (line) => logger.log(line),
    });
    const result = await backfill.run({ dryRun });
    // A dry run is a report, not a change. A real run that resolved nothing while combos
    // were missing deserves a non-zero exit so a deploy step notices.
    if (!dryRun && result.missingCombos > 0 && result.resolvedCombos === 0) {
      logger.error(`No combo resolved out of ${result.missingCombos} missing. Check COINGECKO_API_KEY and COINGECKO_HISTORY_DAYS.`);
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  new Logger("NativePriceBackfill").error((error as Error).stack ?? String(error));
  process.exitCode = 1;
});
