import { Body, Controller, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import { setAuthCookie } from "./auth-cookie";
import { StartVerificationDto, VerificationCallbackDto } from "./auth.dto";
import { AuthService } from "./auth.service";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post("verify/start") start(@Body() body?: StartVerificationDto) { return this.auth.start(body?.sessionId); }
  @Post("verify/callback") async callback(@Body() body: VerificationCallbackDto, @Res({ passthrough: true }) response: Response) {
    const result = await this.auth.callback(body.token, body.country ?? null);
    setAuthCookie(response, result.accessToken);
    return result;
  }
}
