import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { AnchorProofService } from "./anchor-proof.service";
import { EventQueryService } from "./event-query.service";
import { EventReclassificationService } from "./event-reclassification.service";
import { SyncJobService, toSyncJobDto } from "./sync-job.service";
import { ReclassifyDto } from "./indexer.dto";

@UseGuards(JwtAuthGuard)
@Controller("api/events")
export class FrontendEventQueryController {
  constructor(private readonly queries: EventQueryService) {}
  @Get() async list(@CurrentUser() user: AuthenticatedUser, @Query("cursor") cursor?: string, @Query("limit") limit?: string, @Query("includeSpam") includeSpam?: string) { return success(await this.queries.list(user.sub, cursor, limit, includeSpam === "true")); }
  @Get("summary") async summary(@CurrentUser() user: AuthenticatedUser, @Query("from") from?: string, @Query("to") to?: string) { return success(await this.queries.summary(user.sub, from, to)); }
  @Get(":id") async detail(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) { return success(await this.queries.detail(user.sub, id)); }
}

@UseGuards(JwtAuthGuard)
@Controller("api/events")
export class FrontendEventCommandController {
  constructor(private readonly commands: EventReclassificationService, private readonly syncJobs: SyncJobService) {}
  // Sole user-visible incremental trigger. Forced all-binding refresh, run as a background job; reachable via the /api/events/* proxy wildcard.
  // 202: the sync is accepted, not finished. Progress/result come from GET resync/:jobId. Unbound wallet still fails here (404) — synchronously.
  @Post("resync") @HttpCode(202) async resync(@CurrentUser() user: AuthenticatedUser) { return success(toSyncJobDto(await this.syncJobs.enqueue(user.sub))); }
  // Two path segments, so the query controller's GET ":id" cannot swallow it. Scoped to the caller: another user's job is a 404, not a 403.
  @Get("resync/:jobId") async resyncStatus(@CurrentUser() user: AuthenticatedUser, @Param("jobId") jobId: string) { return success(toSyncJobDto(this.syncJobs.status(user.sub, jobId))); }
  @Patch(":id") async update(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: ReclassifyDto) { return success(await this.commands.reclassify(user.sub, id, body)); }
}

@UseGuards(JwtAuthGuard)
@Controller("api/anchor-proof")
export class FrontendAnchorProofController {
  constructor(private readonly proofs: AnchorProofService) {}
  @Get() async proof(@CurrentUser() user: AuthenticatedUser, @Query("eventId") eventId?: string) { return success(await this.proofs.get(user.sub, eventId)); }
}
