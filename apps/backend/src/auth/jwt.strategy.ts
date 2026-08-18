import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Inject } from "@nestjs/common";
import type { UserRepository } from "../identity/identity.repository";
import { USER_REPOSITORY } from "../identity/identity.tokens";
import type { JwtPayload } from "./auth.types";

const cookieExtractor = (request: Request) => request?.cookies?.vw_access_token ?? null;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, @Inject(USER_REPOSITORY) private readonly users: UserRepository) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([ExtractJwt.fromAuthHeaderAsBearerToken(), cookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>("JWT_SECRET") ?? "mock-only-verawallet-secret-at-least-32-chars",
    });
  }
  async validate(payload: JwtPayload) {
    if (!payload.sub || !await this.users.getUser(payload.sub)) throw new UnauthorizedException("Invalid session.");
    return payload;
  }
}
