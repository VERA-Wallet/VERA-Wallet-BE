import type { UserRecord } from "../shared/repository.types";
import { identityProviderName } from "../shared/identity-mode";
import { randomUUID } from "node:crypto";
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { IdentityProvider, VerifiedIdentity } from "@vera/interfaces";
import type { VerifiedIdentityRepository } from "../identity/identity.repository";
import { IDENTITY_PROVIDER, IDENTITY_REPOSITORY } from "../identity/identity.tokens";
import type { JwtPayload } from "./auth.types";

@Injectable()
export class AuthService {
  constructor(
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    @Inject(IDENTITY_REPOSITORY) private readonly identities: VerifiedIdentityRepository,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async start(sessionId: string = randomUUID()) {
    this.rejectLegacyOpenDid();
    return this.identity.requestVerification(sessionId);
  }

  async callback(token: string, countryCode: string | null = null) {
    this.rejectLegacyOpenDid();
    if (!token) throw new UnauthorizedException("Verification token is required.");
    const identity = await this.identity.handleCallback(token);
    const user = await this.identities.upsertVerifiedUser(identity.didHash, identity.method, identity.verifiedAt);
    return this.issueSession(user, identity, countryCode);
  }

  private rejectLegacyOpenDid() {
    if (identityProviderName(key => this.config.get<string>(key)) === "opendid") throw new UnauthorizedException("Use browser-bound Open DID endpoints.");
  }

  async issueSession(user: UserRecord, identity: VerifiedIdentity, countryCode: string | null) {
    const payload: JwtPayload = { sub: user.id, didHash: user.didHash, countryCode };
    return {
      accessToken: await this.jwt.signAsync(payload),
      expiresIn: this.config.get<string>("JWT_EXPIRES_IN", "1h"),
      user: { id: user.id, didHash: user.didHash, verifiedAt: identity.verifiedAt, method: identity.method },
    };
  }
}
