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
    if (!user) return success({ didVerified: false, countryCode: null, walletAddress: null, walletVerification: null });
    const binding = await this.wallets.findLatestByUser(user.sub);
    // No chainId claim: an EVM address is chain-agnostic and the wallet's network at signing time
    // is incidental. Active chains are a fact of indexed data (event chain_id), not of the session.
    return success({ didVerified: true, countryCode: user.countryCode, walletAddress: binding?.walletAddress ?? null, walletVerification: binding?.verificationMethod ?? null });
  }

  private async readSession(request: Request) {
    const token = request.cookies?.vw_access_token as string | undefined;
    if (!token) return null;
    try { return await this.jwt.verifyAsync<AuthenticatedUser>(token); } catch { return null; }
  }
}
