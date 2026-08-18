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
import { CHAIN_INDEXER, TRANSACTION_AVAILABILITY, TRANSACTION_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";

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
