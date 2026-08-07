import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { CalculateTaxDto, FrontendEstimateDto } from "./tax.dto";
import { TaxService } from "./tax.service";
import { FrontendTaxService } from "./frontend-tax.service";

@UseGuards(JwtAuthGuard)
@Controller("tax")
export class TaxController {
  constructor(private readonly tax: TaxService) {}
  @Get("events") events(@CurrentUser() user: AuthenticatedUser, @Query("country") country?: string) { return this.tax.listEvents(user.sub, country); }
  @Post("calculate") calculate(@CurrentUser() user: AuthenticatedUser, @Body() body: CalculateTaxDto) { return this.tax.calculate(user.sub, body); }
}

@UseGuards(JwtAuthGuard)
@Controller("api/tax")
export class FrontendTaxController {
  constructor(private readonly tax: FrontendTaxService) {}
  @Get("rulesets") rulesets() { return success(this.tax.listRuleSets()); }
  @Post("estimate") async estimate(@CurrentUser() user: AuthenticatedUser, @Body() body: FrontendEstimateDto) { return success(await this.tax.estimate(user.sub, body.country, body.taxYear, body.source)); }
}

@UseGuards(JwtAuthGuard)
@Controller("api/rulesets")
export class LegacyRulesetController {
  constructor(private readonly tax: FrontendTaxService) {}
  @Get() rulesets() { return success(this.tax.listRuleSets()); }
}
