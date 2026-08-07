import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { FrontendWalletController, WalletController } from "./wallet.controller";
import { WalletService } from "./wallet.service";
import { WalletChallengeService } from "./wallet-challenge.service";
import { WalletBindingService } from "./wallet-binding.service";

@Module({ imports: [AuthModule], controllers: [WalletController, FrontendWalletController], providers: [WalletService, WalletChallengeService, WalletBindingService], exports: [WalletService] })
export class WalletModule {}
