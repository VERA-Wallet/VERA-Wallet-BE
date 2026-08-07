import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { CHAIN_INDEXER } from "../shared/tokens";
import { AlchemyAdapter, MockAlchemyAdapter } from "./indexer.adapters";
import { IndexerController } from "./indexer.controller";
import { FrontendAnchorProofController, FrontendEventCommandController, FrontendEventQueryController } from "./frontend-events.controller";
import { IndexerService } from "./indexer.service";
import { EventQueryService } from "./event-query.service";
import { EventReclassificationService } from "./event-reclassification.service";
import { AnchorProofService } from "./anchor-proof.service";
import { TransactionService } from "./transaction.service";
import { TransactionAvailabilityService } from "./transaction-availability.service";

@Module({
  imports: [AuthModule],
  controllers: [IndexerController, FrontendEventQueryController, FrontendEventCommandController, FrontendAnchorProofController],
  providers: [MockAlchemyAdapter, AlchemyAdapter, { provide: CHAIN_INDEXER, useFactory: (config: ConfigService, mock: MockAlchemyAdapter, real: AlchemyAdapter) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockAlchemyAdapter, AlchemyAdapter] }, IndexerService, TransactionService, TransactionAvailabilityService, EventQueryService, EventReclassificationService, AnchorProofService],
  exports: [IndexerService, TransactionService, TransactionAvailabilityService],
})
export class IndexerModule {}
