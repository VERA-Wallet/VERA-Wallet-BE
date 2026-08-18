import { BullModule } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { AnchorController } from "./anchor.controller";
import { MockAnchorAdapter, OmniOneChainAdapter } from "./anchor.adapters";
import { AnchorProcessor, BullAnchorDispatcher, ImmediateAnchorDispatcher } from "./anchor.queue";
import { AnchorService } from "./anchor.service";
import { AnchorSubmissionService } from "./anchor-submission.service";
import { MockAnchorRepository, PrismaAnchorRepository } from "./anchor.repository.adapters";
import { ANCHOR_DISPATCHER, ANCHOR_QUERY, ANCHOR_REPOSITORY, ANCHOR_SUBMISSION, EVIDENCE_ANCHOR } from "./anchor.tokens";

const mock = process.env.MOCK_MODE !== "false";

@Module({
  imports: [SharedModule, ...(mock ? [] : [BullModule.registerQueue({ name: "anchor" })])],
  controllers: [AnchorController],
  providers: [
    MockAnchorAdapter,
    OmniOneChainAdapter,
    MockAnchorRepository,
    PrismaAnchorRepository,
    { provide: EVIDENCE_ANCHOR, useFactory: (config: ConfigService, mockAdapter: MockAnchorAdapter, realAdapter: OmniOneChainAdapter) => config.get("MOCK_MODE", "true") === "true" ? mockAdapter : realAdapter, inject: [ConfigService, MockAnchorAdapter, OmniOneChainAdapter] },
    { provide: ANCHOR_REPOSITORY, useFactory: (config: ConfigService, memory: MockAnchorRepository, prisma: PrismaAnchorRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockAnchorRepository, PrismaAnchorRepository] },
    AnchorService,
    AnchorSubmissionService,
    { provide: ANCHOR_QUERY, useExisting: AnchorService },
    { provide: ANCHOR_SUBMISSION, useExisting: AnchorSubmissionService },
    ...(mock
      ? [{ provide: ANCHOR_DISPATCHER, useClass: ImmediateAnchorDispatcher }]
      : [BullAnchorDispatcher, AnchorProcessor, { provide: ANCHOR_DISPATCHER, useExisting: BullAnchorDispatcher }]),
  ],
  exports: [ANCHOR_QUERY, ANCHOR_SUBMISSION],
})
export class AnchorModule {}
