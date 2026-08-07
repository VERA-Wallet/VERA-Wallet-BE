import { randomBytes } from "node:crypto";
import { BadRequestException, ConflictException, GoneException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuthenticatedUser } from "../auth/auth.types";

export type WalletChallenge = { nonce: string; userId: string; message?: string; domain?: string; uri?: string; chainId?: number; issuedAt: string; expiresAtMs: number; consumed: boolean };

@Injectable()
export class WalletChallengeService {
  private readonly challenges = new Map<string, WalletChallenge>();
  constructor(private readonly config: ConfigService) {}

  issueBinding(user: AuthenticatedUser) {
    const challenge = this.create(user.sub);
    challenge.message = `VERA Wallet address binding\nNonce: ${challenge.nonce}\nIssued At: ${challenge.issuedAt}`;
    this.challenges.set(challenge.nonce, challenge);
    return { nonce: challenge.nonce, message: challenge.message, issuedAt: challenge.issuedAt, expiresAt: new Date(challenge.expiresAtMs).toISOString() };
  }

  issueSiwe(user: AuthenticatedUser, chainId: number) {
    const challenge = this.create(user.sub);
    const origin = new URL(this.config.get("SIWE_TRUSTED_ORIGIN", this.config.get("FRONTEND_ORIGIN", "http://localhost:3100")));
    Object.assign(challenge, { domain: origin.host, uri: `${origin.origin}/connect-wallet`, chainId });
    this.challenges.set(challenge.nonce, challenge);
    return { nonce: challenge.nonce, domain: challenge.domain!, uri: challenge.uri!, chainId, issuedAt: challenge.issuedAt, expiresAtMs: challenge.expiresAtMs };
  }

  consume(nonce: string, userId: string) {
    const challenge = this.challenges.get(nonce);
    if (!challenge || challenge.userId !== userId) throw new BadRequestException({ code: "challenge_not_found", message: "Challenge not found." });
    if (challenge.expiresAtMs <= Date.now()) throw new GoneException({ code: "challenge_expired", message: "Challenge expired." });
    if (challenge.consumed) throw new ConflictException({ code: "already-consumed", message: "Challenge already consumed." });
    challenge.consumed = true;
    return challenge;
  }

  private create(userId: string): WalletChallenge {
    return { nonce: randomBytes(16).toString("hex"), userId, issuedAt: new Date().toISOString(), expiresAtMs: Date.now() + 5 * 60_000, consumed: false };
  }
}
