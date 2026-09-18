import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
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
import { CostBasisSnapshotService } from "./cost-basis-snapshot.service";
import { EventReclassificationService } from "./event-reclassification.service";
import { AnchorProofService } from "./anchor-proof.service";
import { TransactionService } from "./transaction.service";
import { TransactionAvailabilityService } from "./transaction-availability.service";
import { CachedTransactionRepository, MockTransactionRepository, PrismaTransactionRepository } from "./transaction.repository.adapters";
import { MockSyncCursorRepository, PrismaSyncCursorRepository } from "./sync-cursor.repository.adapters";
import { CoinGeckoSpotPriceOracle, DexScreenerPriceOracle, FallbackPriceOracle, MockPriceOracle } from "./price-oracle";
import { PriceEnrichmentService } from "./price-enrichment.service";
import { CoinGeckoHistoricalPriceOracle, MockHistoricalPriceOracle } from "./historical-price-oracle";
import { MockHistoricalPriceRepository, PrismaHistoricalPriceRepository } from "./historical-price.repository.adapters";
import { HistoricalPriceEnrichmentService } from "./historical-price-enrichment.service";
import { BridgeLinkingService } from "./bridge-linking.service";
import { OwnWalletLinkingService } from "./own-wallet-linking.service";
import { InMemorySyncJobStore } from "./sync-job";
import { SyncJobRunner, SyncJobService } from "./sync-job.service";
import { BullSyncDispatcher, InProcessSyncDispatcher, SyncProcessor } from "./sync.queue";
import { CHAIN_INDEXER, COST_BASIS_SNAPSHOT, HISTORICAL_PRICE_ORACLE, HISTORICAL_PRICE_REPOSITORY, PRICE_ORACLE, SYNC_CURSOR_REPOSITORY, SYNC_DISPATCHER, SYNC_JOB_STORE, TRANSACTION_AVAILABILITY, TRANSACTION_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";

// anchor.module.ts와 같은 스위치: Redis(Bull)는 MOCK_MODE=false에서만 있다.
const mock = process.env.MOCK_MODE !== "false";

@Module({
  imports: [AuthModule, SharedModule, AnchorModule, WalletModule, ...(mock ? [] : [BullModule.registerQueue({ name: "sync" })])],
  controllers: [IndexerController, FrontendEventQueryController, FrontendEventCommandController, FrontendAnchorProofController],
  providers: [
    MockAlchemyAdapter,
    AlchemyAdapter,
    MockTransactionRepository,
    PrismaTransactionRepository,
    { provide: CHAIN_INDEXER, useFactory: (config: ConfigService, mock: MockAlchemyAdapter, real: AlchemyAdapter) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockAlchemyAdapter, AlchemyAdapter] },
    // 읽기 경로는 사용자별 스냅샷 캐시를 지난다. 쓰기(save·updatePayload)도 같은 인스턴스를 지나므로 캐시가 쓰기를 놓치지 않는다.
    { provide: TRANSACTION_REPOSITORY, useFactory: (config: ConfigService, memory: MockTransactionRepository, prisma: PrismaTransactionRepository) => new CachedTransactionRepository(usePrismaPersistence(config) ? prisma : memory), inject: [ConfigService, MockTransactionRepository, PrismaTransactionRepository] },
    { provide: TRANSACTION_SYNC_REPOSITORY, useExisting: TRANSACTION_REPOSITORY },
    MockSyncCursorRepository,
    PrismaSyncCursorRepository,
    { provide: SYNC_CURSOR_REPOSITORY, useFactory: (config: ConfigService, memory: MockSyncCursorRepository, prisma: PrismaSyncCursorRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockSyncCursorRepository, PrismaSyncCursorRepository] },
    MockPriceOracle,
    DexScreenerPriceOracle,
    // 실모드 시세: DexScreener가 답하지 못하면(429·타임아웃) CoinGecko로, 그것도 안 되면 정식 스테이블만 1달러로 둔다.
    {
      provide: PRICE_ORACLE,
      useFactory: (config: ConfigService, mock: MockPriceOracle, real: DexScreenerPriceOracle) =>
        config.get("MOCK_MODE", "true") === "true" ? mock : new FallbackPriceOracle(real, new CoinGeckoSpotPriceOracle(config.get<string>("COINGECKO_API_KEY") || null)),
      inject: [ConfigService, MockPriceOracle, DexScreenerPriceOracle],
    },
    PriceEnrichmentService,
    MockHistoricalPriceOracle,
    {
      provide: CoinGeckoHistoricalPriceOracle,
      useFactory: (config: ConfigService) => {
        // Demo 플랜의 과거 조회 창은 365일(historical-price-oracle.ts DEMO_HISTORY_WINDOW_DAYS). 유료면 0(무제한).
        const raw = config.get<string>("COINGECKO_HISTORY_DAYS");
        const configured = Number(raw);
        const historyWindowDays = raw !== undefined && Number.isFinite(configured) && configured >= 0 ? configured : 365;
        return new CoinGeckoHistoricalPriceOracle(config.get<string>("COINGECKO_API_KEY") || null, historyWindowDays);
      },
      inject: [ConfigService],
    },
    { provide: HISTORICAL_PRICE_ORACLE, useFactory: (config: ConfigService, mock: MockHistoricalPriceOracle, real: CoinGeckoHistoricalPriceOracle) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockHistoricalPriceOracle, CoinGeckoHistoricalPriceOracle] },
    MockHistoricalPriceRepository,
    PrismaHistoricalPriceRepository,
    { provide: HISTORICAL_PRICE_REPOSITORY, useFactory: (config: ConfigService, memory: MockHistoricalPriceRepository, prisma: PrismaHistoricalPriceRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockHistoricalPriceRepository, PrismaHistoricalPriceRepository] },
    HistoricalPriceEnrichmentService,
    BridgeLinkingService,
    OwnWalletLinkingService,
    IndexerService,
    InMemorySyncJobStore,
    { provide: SYNC_JOB_STORE, useExisting: InMemorySyncJobStore },
    SyncJobRunner,
    SyncJobService,
    ...(mock
      ? [{ provide: SYNC_DISPATCHER, useClass: InProcessSyncDispatcher }]
      : [BullSyncDispatcher, SyncProcessor, { provide: SYNC_DISPATCHER, useExisting: BullSyncDispatcher }]),
    TransactionService,
    TransactionAvailabilityService,
    { provide: TRANSACTION_AVAILABILITY, useExisting: TransactionAvailabilityService },
    CostBasisSnapshotService,
    { provide: COST_BASIS_SNAPSHOT, useExisting: CostBasisSnapshotService },
    EventQueryService,
    EventReclassificationService,
    AnchorProofService,
  ],
  exports: [IndexerService, TransactionService, TRANSACTION_REPOSITORY, TRANSACTION_AVAILABILITY, COST_BASIS_SNAPSHOT, PRICE_ORACLE],
})
export class IndexerModule {}
