import { Controller, Get, Inject, Req } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { success } from "../shared/api";
import type { AuthenticatedUser } from "../auth/auth.types";
import type { WalletRepository } from "./wallet.repository";
import { WALLET_REPOSITORY } from "./wallet.tokens";

@Controller("api/auth")
export class FrontendSessionController {
  constructor(@Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository, private readonly jwt: JwtService) {}

  @Get("session") async session(@Req() request: Request) {
    const user = await this.readSession(request);
    if (!user) return success({ didVerified: false, countryCode: null, walletAddress: null, chainId: null });
    const binding = await this.wallets.findLatestByUser(user.sub);
    return success({ didVerified: true, countryCode: user.countryCode, walletAddress: binding?.walletAddress ?? null, chainId: binding ? 1 : null });
  }

  private async readSession(request: Request) {
    const token = request.cookies?.vw_access_token as string | undefined;
    if (!token) return null;
    try { return await this.jwt.verifyAsync<AuthenticatedUser>(token); } catch { return null; }
  }
}
