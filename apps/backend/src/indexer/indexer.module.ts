import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AnchorModule } from "../anchor/anchor.module";
import { AuthModule } from "../auth/auth.module";
import { SharedModule } from "../shared/shared.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { WalletModule } from "../wallet/wallet.module";
import { AlchemyAdapter, MockAlchemyAdapter } from "./indexer.adapters";
import { IndexerController } from "./indexer.controller";
import { FrontendAnchorProofController, FrontendEventCommandController, FrontendEventQueryController } from "./frontend-events.controller";
import { IndexerService } from "./indexer.service";
import { EventQueryService } from "./event-query.service";
import { EventReclassificationService } from "./event-reclassification.service";
import { AnchorProofService } from "./anchor-proof.service";
import { TransactionService } from "./transaction.service";
import { TransactionAvailabilityService } from "./transaction-availability.service";
import { MockTransactionRepository, PrismaTransactionRepository } from "./transaction.repository.adapters";
import { MockSyncCursorRepository, PrismaSyncCursorRepository } from "./sync-cursor.repository.adapters";
import { DexScreenerPriceOracle, MockPriceOracle } from "./price-oracle";
import { PriceEnrichmentService } from "./price-enrichment.service";
import { CoinGeckoHistoricalPriceOracle, MockHistoricalPriceOracle } from "./historical-price-oracle";
import { MockHistoricalPriceRepository, PrismaHistoricalPriceRepository } from "./historical-price.repository.adapters";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { BridgeLinkingService } from "./bridge-linking.service";
import { CHAIN_INDEXER, HISTORICAL_PRICE_ORACLE, HISTORICAL_PRICE_REPOSITORY, PRICE_ORACLE, SYNC_CURSOR_REPOSITORY, TRANSACTION_AVAILABILITY, TRANSACTION_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";

@Module({
  imports: [AuthModule, SharedModule, AnchorModule, WalletModule],
  controllers: [IndexerController, FrontendEventQueryController, FrontendEventCommandController, FrontendAnchorProofController],
  providers: [
    MockAlchemyAdapter,
    AlchemyAdapter,
    MockTransactionRepository,
    PrismaTransactionRepository,
    { provide: CHAIN_INDEXER, useFactory: (config: ConfigService, mock: MockAlchemyAdapter, real: AlchemyAdapter) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockAlchemyAdapter, AlchemyAdapter] },
    { provide: TRANSACTION_REPOSITORY, useFactory: (config: ConfigService, memory: MockTransactionRepository, prisma: PrismaTransactionRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockTransactionRepository, PrismaTransactionRepository] },
    { provide: TRANSACTION_SYNC_REPOSITORY, useExisting: TRANSACTION_REPOSITORY },
    MockSyncCursorRepository,
    PrismaSyncCursorRepository,
    { provide: SYNC_CURSOR_REPOSITORY, useFactory: (config: ConfigService, memory: MockSyncCursorRepository, prisma: PrismaSyncCursorRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockSyncCursorRepository, PrismaSyncCursorRepository] },
    MockPriceOracle,
    DexScreenerPriceOracle,
    { provide: PRICE_ORACLE, useFactory: (config: ConfigService, mock: MockPriceOracle, real: DexScreenerPriceOracle) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockPriceOracle, DexScreenerPriceOracle] },
    PriceEnrichmentService,
    MockHistoricalPriceOracle,
    { provide: CoinGeckoHistoricalPriceOracle, useFactory: (config: ConfigService) => new CoinGeckoHistoricalPriceOracle(config.get<string>("COINGECKO_API_KEY") || null), inject: [ConfigService] },
    { provide: HISTORICAL_PRICE_ORACLE, useFactory: (config: ConfigService, mock: MockHistoricalPriceOracle, real: CoinGeckoHistoricalPriceOracle) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockHistoricalPriceOracle, CoinGeckoHistoricalPriceOracle] },
    MockHistoricalPriceRepository,
    PrismaHistoricalPriceRepository,
    { provide: HISTORICAL_PRICE_REPOSITORY, useFactory: (config: ConfigService, memory: MockHistoricalPriceRepository, prisma: PrismaHistoricalPriceRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockHistoricalPriceRepository, PrismaHistoricalPriceRepository] },
    HistoricalPriceEnrichmentService,
    BridgeLinkingService,
    IndexerService,
    TransactionService,
    TransactionAvailabilityService,
    { provide: TRANSACTION_AVAILABILITY, useExisting: TransactionAvailabilityService },
    EventQueryService,
    EventReclassificationService,
    AnchorProofService,
  ],
  exports: [IndexerService, TransactionService, TRANSACTION_REPOSITORY, TRANSACTION_AVAILABILITY],
})
export class IndexerModule {}
