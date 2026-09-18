import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { HoldingsService } from "./holdings.service";

/**
 * 지갑 홈의 보유 자산. `wallet`을 주면 그 지갑, 안 주면 가장 최근에 묶은 지갑이다.
 * 어느 쪽이든 호출자에게 묶인 지갑만 읽는다 — 남의 주소는 404다(존재 여부도 알려주지 않는다).
 */
@UseGuards(JwtAuthGuard)
@Controller("api/wallet")
export class FrontendHoldingsController {
  constructor(private readonly holdings: HoldingsService) {}

  @Get("holdings") async list(@CurrentUser() user: AuthenticatedUser, @Query("wallet") wallet?: string) {
    return success(await this.holdings.forUser(user.sub, wallet));
  }
}
