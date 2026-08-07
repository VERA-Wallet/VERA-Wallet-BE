import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request, Response } from "express";
import type { WalletRepository } from "../wallet/wallet.repository";
import { success } from "../shared/api";
import { WALLET_REPOSITORY } from "../shared/tokens";
import { clearAuthCookie, setAuthCookie } from "./auth-cookie";
import { PresentDidDto } from "./auth.dto";
import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./auth.types";

@Controller("api/auth")
export class FrontendAuthController {
  constructor(private readonly auth: AuthService, @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository, private readonly jwt: JwtService) {}

  @Post("did/present") async present(@Body() body: PresentDidDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.callback(`mock-did-${body.country}`, body.country);
    setAuthCookie(response, result.accessToken);
    const labels = { KR: "대한민국", DE: "독일", US: "미국", UK: "영국" } as const;
    return success({ countryCode: body.country, ruleset: { country: body.country, cost_basis: ["US", "UK"].includes(body.country) ? "FIFO" : "이동평균법", badge_label: labels[body.country] } });
  }

  @Get("session") async session(@Req() request: Request) {
    const user = await this.readSession(request);
    if (!user) return success({ didVerified: false, countryCode: null, walletAddress: null, chainId: null });
    const binding = await this.wallets.findLatestByUser(user.sub);
    return success({ didVerified: true, countryCode: user.countryCode, walletAddress: binding?.walletAddress ?? null, chainId: binding ? 1 : null });
  }

  @Post("logout") @HttpCode(204) logout(@Res({ passthrough: true }) response: Response) { clearAuthCookie(response); }

  private async readSession(request: Request) {
    const token = request.cookies?.vw_access_token as string | undefined;
    if (!token) return null;
    try { return await this.jwt.verifyAsync<AuthenticatedUser>(token); } catch { return null; }
  }
}
