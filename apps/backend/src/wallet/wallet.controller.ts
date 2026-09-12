import { Body, Controller, Get, Inject, Post, UseGuards } from "@nestjs/common";
import { SiweMessage } from "siwe";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { BindChallengeDto, BindWalletDto, SiweNonceDto, SiweVerifyDto, WatchWalletDto } from "./wallet.dto";
import { WalletService } from "./wallet.service";
import type { WalletRepository } from "./wallet.repository";
import { WALLET_REPOSITORY } from "./wallet.tokens";

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
  constructor(private readonly wallets: WalletService, @Inject(WALLET_REPOSITORY) private readonly bindings: WalletRepository) {}
  // 등록한 지갑 전부. 세션은 최신 지갑 하나만 말하므로 지갑 탭 목록은 여기서 읽는다. 잔액 조회와 분리된 이유:
  // 잔액 서버가 죽어도 "무엇을 등록했는가"는 저장소가 아는 사실이라 목록은 그려져야 한다.
  @Get("wallets") async list(@CurrentUser() user: AuthenticatedUser) {
    const all = await this.bindings.findAllByUser(user.sub);
    return success({ wallets: all.map((binding) => ({ walletAddress: binding.walletAddress, verificationMethod: binding.verificationMethod, boundAt: binding.boundAt.toISOString() })) });
  }
  @Post("nonce") nonce(@CurrentUser() user: AuthenticatedUser, @Body() body: SiweNonceDto) { return success(this.wallets.issueSiweChallenge(user, body.chainId)); }
  @Post("verify") async verify(@CurrentUser() user: AuthenticatedUser, @Body() body: SiweVerifyDto) {
    const result = await this.wallets.bindSiwe(user, body);
    return success({ walletAddress: result.walletAddress, chainId: new SiweMessage(body.message).chainId });
  }
  @Post("wallet/watch") async watch(@CurrentUser() user: AuthenticatedUser, @Body() body: WatchWalletDto) {
    return success(await this.wallets.watch(user, body.address));
  }
}
