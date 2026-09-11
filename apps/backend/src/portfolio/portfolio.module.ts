import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { IndexerModule } from "../indexer/indexer.module";
import { SharedModule } from "../shared/shared.module";
import { WalletModule } from "../wallet/wallet.module";
import { AlchemyBalanceReader, MockBalanceReader } from "./balance-reader.adapters";
import { FrontendPortfolioController } from "./frontend-portfolio.controller";
import { PortfolioHoldingsService } from "./holdings.service";
import { BALANCE_READER } from "./portfolio.tokens";

@Module({
  imports: [AuthModule, SharedModule, WalletModule, IndexerModule],
  controllers: [FrontendPortfolioController],
  providers: [
    MockBalanceReader,
    AlchemyBalanceReader,
    // Same switch as CHAIN_INDEXER: the provider adapter follows MOCK_MODE, not PERSISTENCE.
    { provide: BALANCE_READER, useFactory: (config: ConfigService, mock: MockBalanceReader, real: AlchemyBalanceReader) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockBalanceReader, AlchemyBalanceReader] },
    PortfolioHoldingsService,
  ],
})
export class PortfolioModule {}
