import { randomUUID } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { IdentityProvider } from "@vera/interfaces";
import type { VerifiedIdentityRepository } from "../identity/identity.repository";
import { IDENTITY_PROVIDER, IDENTITY_REPOSITORY } from "../shared/tokens";
import type { JwtPayload } from "./auth.types";

@Injectable()
export class AuthService {
  private readonly sessions = new Map<string, number>();
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: VerifiedIdentityRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async start(sessionId: string = randomUUID()) {
    const request = await this.identity.requestVerification(sessionId);
    this.sessions.set(sessionId, request.expiresAt.getTime());
    return request;
  }

  async callback(token: string, countryCode: string | null = null) {
    if (!token) throw new UnauthorizedException("Verification token is required.");
    const identity = await this.identity.handleCallback(token);
    const user = await this.identities.upsertVerifiedUser(identity.didHash, identity.method, identity.verifiedAt);
    const payload: JwtPayload = { sub: user.id, didHash: user.didHash, countryCode };
    return {
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: this.config.get<string>("JWT_EXPIRES_IN", "1h"),
      user: { id: user.id, didHash: user.didHash, verifiedAt: identity.verifiedAt, method: identity.method },
    };
  }
}
