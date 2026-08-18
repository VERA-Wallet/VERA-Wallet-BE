import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AnchorModule } from "../anchor/anchor.module";
import { AuthModule } from "../auth/auth.module";
import { SharedModule } from "../shared/shared.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { FrontendSessionController } from "./frontend-session.controller";
import { FrontendWalletController, WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";
import { WalletChallengeService } from "./wallet-challenge.service";
import { WalletBindingService } from "./wallet-binding.service";
import { MockWalletRepository, PrismaWalletRepository } from "./wallet.repository.adapters";
import { WALLET_BINDING_REPOSITORY, WALLET_REPOSITORY } from "./wallet.tokens";

@Module({
  imports: [AuthModule, SharedModule, AnchorModule],
  controllers: [WalletController, FrontendWalletController, FrontendSessionController],
  providers: [
    WalletService,
    WalletChallengeService,
    WalletBindingService,
    MockWalletRepository,
    PrismaWalletRepository,
    { provide: WALLET_REPOSITORY, useFactory: (config: ConfigService, memory: MockWalletRepository, prisma: PrismaWalletRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockWalletRepository, PrismaWalletRepository] },
    { provide: WALLET_BINDING_REPOSITORY, useExisting: WALLET_REPOSITORY },
  ],
  exports: [WalletService, WALLET_REPOSITORY],
})
export class WalletModule {}
