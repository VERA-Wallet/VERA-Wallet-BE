import { BadRequestException, Controller, Get, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { PortfolioHoldingsService } from "./holdings.service";

// Live balances joined with ledger cost basis. Proxied by the FE under the same path
// (`/api/portfolio/*` must be added to the FE proxy's backend-owned list).
@UseGuards(JwtAuthGuard)
@Controller("api/portfolio")
export class FrontendPortfolioController {
  constructor(private readonly holdings: PortfolioHoldingsService) {}
  // `?address=0x…`로 등록한 지갑 하나만 본다(지갑 상세). 없으면 전부 합산(지갑 목록의 총액).
  @Get("holdings") async holdingsOf(@CurrentUser() user: AuthenticatedUser, @Query("address") address?: string) {
    if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new BadRequestException("address must be a 0x-prefixed 40-hex EVM address.");
    return success(await this.holdings.holdings(user.sub, address));
  }
}
