import "dotenv/config";
import { BullModule } from "@nestjs/bull";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthModule } from "./auth/auth.module";
import { IndexerModule } from "./indexer/indexer.module";
import { ReportModule } from "./report/report.module";
import { TaxModule } from "./tax/tax.module";
import { WalletModule } from "./wallet/wallet.module";
import { HoldingsModule } from "./wallet/holdings.module";
import { AppController } from "./app.controller";
import { AnchorModule } from "./anchor/anchor.module";

const queueImports = process.env.MOCK_MODE === "false"
  ? [BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = new URL(config.get("REDIS_URL", "redis://localhost:6379"));
        return { redis: { host: url.hostname, port: Number(url.port || 6379), ...(url.password ? { password: decodeURIComponent(url.password) } : {}), ...(url.protocol === "rediss:" ? { tls: {} } : {}) } };
      },
    })]
  : [];

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), ...queueImports, AnchorModule, AuthModule, WalletModule, IndexerModule, HoldingsModule, TaxModule, ReportModule],
  controllers: [AppController],
})
export class AppModule {}
