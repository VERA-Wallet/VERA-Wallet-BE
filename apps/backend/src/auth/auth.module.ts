import { SharedModule } from "../shared/shared.module";
import { OpenDidAttemptStore } from "./opendid-attempt.store";
import { OpenDidLoginService } from "./opendid-login.service";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { IdentityModule } from "../identity/identity.module";
import { AuthController } from "./auth.controller";
import { FrontendAuthController } from "./frontend-auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [
    IdentityModule,
    SharedModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: config.get<string>("JWT_SECRET") ?? "mock-only-verawallet-secret-at-least-32-chars", signOptions: { expiresIn: config.get("JWT_EXPIRES_IN", "1h") } }),
    }),
  ],
  controllers: [AuthController, FrontendAuthController],
  providers: [OpenDidAttemptStore, OpenDidLoginService, AuthService, JwtStrategy, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard, JwtModule],
})
export class AuthModule {}
