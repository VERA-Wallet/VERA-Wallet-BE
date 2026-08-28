import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { SiweMessage } from "siwe";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { BindChallengeDto, BindWalletDto, SiweNonceDto, SiweVerifyDto, WatchWalletDto } from "./wallet.dto";
import { WalletService } from "./wallet.service";

@UseGuards(JwtAuthGuard)
@Controller("wallet")
export class WalletController {
  constructor(private readonly wallets: WalletService) {}
  @Post("bind/challenge") challenge(@CurrentUser() user: AuthenticatedUser, @Body() _body: BindChallengeDto) { return this.wallets.issueBindingChallenge(user); }
  @Post("bind") bind(@CurrentUser() user: AuthenticatedUser, @Body() body: BindWalletDto) { return this.wallets.bind(user, body); }
}

@UseGuards(JwtAuthGuard)
@Controller("api/auth")
export class FrontendWalletController {
  constructor(private readonly wallets: WalletService) {}
  @Post("nonce") nonce(@CurrentUser() user: AuthenticatedUser, @Body() body: SiweNonceDto) { return success(this.wallets.issueSiweChallenge(user, body.chainId)); }
  @Post("verify") async verify(@CurrentUser() user: AuthenticatedUser, @Body() body: SiweVerifyDto) {
    const result = await this.wallets.bindSiwe(user, body);
    return success({ walletAddress: result.walletAddress, chainId: new SiweMessage(body.message).chainId });
  }
  @Post("wallet/watch") async watch(@CurrentUser() user: AuthenticatedUser, @Body() body: WatchWalletDto) {
    return success(await this.wallets.watch(user, body.address));
  }
}
