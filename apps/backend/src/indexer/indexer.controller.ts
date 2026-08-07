import { Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { IndexerService } from "./indexer.service";

@UseGuards(JwtAuthGuard)
@Controller("indexer")
export class IndexerController {
  constructor(private readonly indexer: IndexerService) {}
  @Post("sync") sync(@CurrentUser() user: AuthenticatedUser) { return this.indexer.sync(user.sub); }
}
