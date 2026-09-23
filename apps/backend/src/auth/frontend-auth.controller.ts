import { OpenDidLoginService } from "./opendid-login.service";
import { BadRequestException, Body, Controller, HttpCode, Optional, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { getFrontendRuleSet } from "@vera/tax-engine";
import { success } from "../shared/api";
import { identityProviderName, useMockIdentity } from "../shared/identity-mode";
import { clearAuthCookie, setAuthCookie } from "./auth-cookie";
import { DidOfferDto, PresentDidDto } from "./auth.dto";
import { AuthService } from "./auth.service";

@Controller("api/auth")
export class FrontendAuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService, @Optional() private readonly openDid?: OpenDidLoginService) {}

  @Post("did/offer") async offer(@Body() body: DidOfferDto, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    if (!this.openDid) throw new UnauthorizedException();
    return success(await this.openDid.offer(body.country, request, response), false);
  }

  /**
   * 모바일신분증(OmniOne CX) 제시. FE가 인증창 콜백 토큰을 `cxToken`으로 보내면 그대로 신원 검증에 쓴다.
   *
   * mock 폴백(`mock-did-<country>`)은 인증창이 없는 흐름(e2e·계약 테스트, CX 미설정 FE)용이며
   * mock 신원 공급자일 때만 허용한다. 실제 공급자 앞에서 토큰 없는 제시를 통과시키면 인증창을 건너뛴 로그인이 되므로 401로 끊는다.
   * 모드 판정은 IDENTITY_PROVIDER 바인딩(identity.module.ts)과 같은 함수(useMockIdentity)를 쓴다 — 두 판정이 갈리면 폴백이 실제 어댑터로 샌다.
   */
  @Post("did/present") async present(@Body() body: PresentDidDto, @Res({ passthrough: true }) response: Response, @Req() request?: Request) {
    const provider = identityProviderName(key => this.config.get<string>(key));
    if (provider === "opendid") {
      if (!body.offerId || body.cxToken || !request || !this.openDid) throw new BadRequestException("An offerId is required without cxToken.");
      const result = await this.openDid.present(body.offerId, body.country, request, response);
      if (result.status === "pending") { response.status(202); return success(result, false); }
      response.status(200);
      setAuthCookie(response, result.accessToken);
      const ruleset = getFrontendRuleSet(body.country)!;
      return success({ countryCode: body.country, ruleset: { country: body.country, cost_basis: ruleset.costBasis, badge_label: ruleset.label } }, false);
    }
    if (body.offerId) throw new BadRequestException("offerId requires Open DID.");
    if (!body.cxToken && !useMockIdentity(this.config)) throw new UnauthorizedException("A mobile ID verification token is required.");
    const result = await this.auth.callback(body.cxToken ?? `mock-did-${body.country}`, body.country);
    setAuthCookie(response, result.accessToken);
    const ruleset = getFrontendRuleSet(body.country)!;
    return success({ countryCode: body.country, ruleset: { country: body.country, cost_basis: ruleset.costBasis, badge_label: ruleset.label } });
  }

  @Post("logout") @HttpCode(204) logout(@Res({ passthrough: true }) response: Response) { clearAuthCookie(response); }
}
