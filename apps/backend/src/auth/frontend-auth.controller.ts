import { Body, Controller, HttpCode, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { getFrontendRuleSet } from "@vera/tax-engine";
import { success } from "../shared/api";
import { clearAuthCookie, setAuthCookie } from "./auth-cookie";
import { PresentDidDto } from "./auth.dto";
import { AuthService } from "./auth.service";

@Controller("api/auth")
export class FrontendAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("did/present") async present(@Body() body: PresentDidDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.callback(`mock-did-${body.country}`, body.country);
    setAuthCookie(response, result.accessToken);
    const ruleset = getFrontendRuleSet(body.country)!;
    return success({ countryCode: body.country, ruleset: { country: body.country, cost_basis: ruleset.costBasis, badge_label: ruleset.label } });
  }

  @Post("logout") @HttpCode(204) logout(@Res({ passthrough: true }) response: Response) { clearAuthCookie(response); }
}
