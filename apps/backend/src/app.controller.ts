import { Controller, Get } from "@nestjs/common";

@Controller()
export class AppController {
  @Get("health") health() { return { status: "ok", service: "VeraWallet-BE", mockMode: process.env.MOCK_MODE !== "false", timestamp: new Date().toISOString() }; }
}
