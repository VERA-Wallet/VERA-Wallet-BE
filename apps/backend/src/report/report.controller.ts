import { Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { ReportService } from "./report.service";

@UseGuards(JwtAuthGuard)
@Controller("reports")
export class ReportController {
  constructor(private readonly reports: ReportService) {}
  @Get(":id") get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) { return this.reports.get(user.sub, id); }
  @Post(":id/finalize") finalize(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) { return this.reports.finalize(user.sub, id); }
}
