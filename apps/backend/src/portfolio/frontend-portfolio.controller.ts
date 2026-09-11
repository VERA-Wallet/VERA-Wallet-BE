import { Controller, Get, UseGuards } from "@nestjs/common";
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
  @Get("holdings") async holdingsOf(@CurrentUser() user: AuthenticatedUser) { return success(await this.holdings.holdings(user.sub)); }
}
