import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser } from "../auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { success } from "../shared/api";
import { CheckReportFileDto, IssueReportVcDto, VerifyReportVcDto } from "./report-vc.dto";
import { ReportVcService } from "./report-vc.service";

@Controller("api/report-vc")
export class ReportVcController {
  constructor(private readonly vc: ReportVcService) {}
  private envelope(data: unknown, response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return success(data, false); // No mock issuer path exists in this module.
  }
  @Get("capabilities") async capabilities(@Res({ passthrough: true }) res: Response) { return this.envelope(await this.vc.capabilities(), res); }
  @UseGuards(JwtAuthGuard) @Get("wallet") async wallet(@CurrentUser() user: AuthenticatedUser, @Res({ passthrough: true }) res: Response) { return this.envelope(await this.vc.wallet(user.sub), res); }
  @UseGuards(JwtAuthGuard) @Post("wallet/link-attempts") async link(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.vc.origin(req); return this.envelope(await this.vc.link(user.sub, res, req), res);
  }
  @UseGuards(JwtAuthGuard) @Get("wallet/link-attempts/:id") async linkStatus(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.envelope(await this.vc.poll(id, "link", user.sub, req, res), res);
  }
  @UseGuards(JwtAuthGuard) @Post("wallet/link-attempts/:id/cancel") @HttpCode(204) async cancelLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request) {
    this.vc.origin(req); await this.vc.cancel(id, "link", user.sub, req);
  }
  @UseGuards(JwtAuthGuard) @Delete("wallet") @HttpCode(204) async unlink(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    this.vc.origin(req); await this.vc.unlink(user.sub);
  }
  @UseGuards(JwtAuthGuard) @Get("evidence/:root/issuance") async eligibility(@CurrentUser() user: AuthenticatedUser, @Param("root") root: string, @Res({ passthrough: true }) res: Response) {
    return this.envelope(await this.vc.eligibility(user.sub, root), res);
  }
  @UseGuards(JwtAuthGuard) @Post("issuances") async issue(@CurrentUser() user: AuthenticatedUser, @Body() body: IssueReportVcDto, @Headers("idempotency-key") key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.vc.origin(req); return this.envelope(await this.vc.issue(user.sub, body.evidenceId, key, res), res);
  }
  @UseGuards(JwtAuthGuard) @Get("issuances/:id") async issueStatus(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.envelope(await this.vc.poll(id, "issue", user.sub, req, res), res);
  }
  @UseGuards(JwtAuthGuard) @Post("issuances/:id/cancel") @HttpCode(204) async cancelIssue(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request) {
    this.vc.origin(req); await this.vc.cancel(id, "issue", user.sub, req);
  }
  @Post("verifications") async verify(@Body() body: VerifyReportVcDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.vc.origin(req); return this.envelope(await this.vc.verify(body.disclosure, res), res);
  }
  @Get("verifications/:id") async verifyStatus(@Param("id") id: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.envelope(await this.vc.poll(id, "verify", null, req, res), res);
  }
  @Post("verifications/:id/cancel") @HttpCode(204) async cancelVerify(@Param("id") id: string, @Req() req: Request) {
    this.vc.origin(req); await this.vc.cancel(id, "verify", null, req);
  }
  @Post("verifications/:id/file-checks") async file(@Param("id") id: string, @Body() body: CheckReportFileDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    this.vc.origin(req); return this.envelope(await this.vc.checkFile(id, req, body), res);
  }
}
