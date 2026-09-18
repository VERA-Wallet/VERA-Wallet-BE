import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "../auth/auth.module";
import { IndexerModule } from "../indexer/indexer.module";
import { WalletModule } from "./wallet.module";
import { AlchemyBalanceReader, MockBalanceReader } from "./balance.adapters";
import { FrontendHoldingsController } from "./frontend-holdings.controller";
import { HoldingsService } from "./holdings.service";
import { BALANCE_READER } from "./wallet.tokens";

/**
 * 지갑 홈의 보유 자산.
 *
 * WalletModule이 아니라 별도 모듈인 이유는 방향 때문이다 — IndexerModule이 이미 WalletModule을 import하므로,
 * 시세 오라클을 쓰려고 WalletModule이 IndexerModule을 import하면 순환이 된다. 여기서 둘 다 import하면
 * 순환 없이 지갑 바인딩(WalletModule)과 PRICE_ORACLE(IndexerModule)을 한자리에서 쓸 수 있다.
 */
@Module({
  imports: [AuthModule, WalletModule, IndexerModule],
  controllers: [FrontendHoldingsController],
  providers: [
    HoldingsService,
    AlchemyBalanceReader,
    MockBalanceReader,
    { provide: BALANCE_READER, useFactory: (config: ConfigService, mock: MockBalanceReader, real: AlchemyBalanceReader) => config.get("MOCK_MODE", "true") === "true" ? mock : real, inject: [ConfigService, MockBalanceReader, AlchemyBalanceReader] },
  ],
})
export class HoldingsModule {}
