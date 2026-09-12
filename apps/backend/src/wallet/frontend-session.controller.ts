import { Controller, Get, Inject, Req } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { success } from "../shared/api";
import type { AuthenticatedUser } from "../auth/auth.types";
import type { UserRepository } from "../identity/identity.repository";
import { USER_REPOSITORY } from "../identity/identity.tokens";
import type { WalletRepository } from "./wallet.repository";
import { WALLET_REPOSITORY } from "./wallet.tokens";

@Controller("api/auth")
export class FrontendSessionController {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly jwt: JwtService,
  ) {}

  @Get("session") async session(@Req() request: Request) {
    const user = await this.readSession(request);
    if (!user) return success({ didVerified: false, countryCode: null, walletAddress: null, walletVerification: null });
    const binding = await this.wallets.findLatestByUser(user.sub);
    // No chainId claim: an EVM address is chain-agnostic and the wallet's network at signing time
    // is incidental. Active chains are a fact of indexed data (event chain_id), not of the session.
    return success({ didVerified: true, countryCode: user.countryCode, walletAddress: binding?.walletAddress ?? null, walletVerification: binding?.verificationMethod ?? null });
  }

  // JwtStrategy(가드)와 같은 판정: 서명이 유효해도 사용자가 저장소에 없으면 세션이 아니다. 서명만 보면 DB 초기화나
  // 인메모리 재시작 뒤의 옛 토큰이 "인증됨 + 지갑 없음"으로 읽혀, 같은 토큰으로 보호 API는 401을 내는 모순이 생긴다.
  private async readSession(request: Request) {
    const token = request.cookies?.vw_access_token as string | undefined;
    if (!token) return null;
    let user: AuthenticatedUser;
    try { user = await this.jwt.verifyAsync<AuthenticatedUser>(token); } catch { return null; }
    if (!user.sub || !(await this.users.getUser(user.sub))) return null;
    return user;
  }
}
