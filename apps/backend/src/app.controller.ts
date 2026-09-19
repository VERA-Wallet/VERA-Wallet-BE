import { Controller, Get } from "@nestjs/common";
import { identityProviderName } from "./shared/identity-mode";

@Controller()
export class AppController {
  @Get("health") health() { return { status: "ok", service: "VeraWallet-BE", mockMode: process.env.MOCK_MODE !== "false", identityProvider: identityProviderName((key) => process.env[key]), timestamp: new Date().toISOString() }; }
}
