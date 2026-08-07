import { BullModule } from "@nestjs/bull";
import { ConfigService } from "@nestjs/config";
import { DynamicModule, Module } from "@nestjs/common";
import { ANCHOR_DISPATCHER, EVIDENCE_ANCHOR } from "../shared/tokens";
import { AnchorController } from "./anchor.controller";
import { MockAnchorAdapter, OmniOneChainAdapter } from "./anchor.adapters";
import { AnchorProcessor, BullAnchorDispatcher, ImmediateAnchorDispatcher } from "./anchor.queue";
import { AnchorService } from "./anchor.service";
import { AnchorSubmissionService } from "./anchor-submission.service";

@Module({})
export class AnchorModule {
  static register(): DynamicModule {
    const mock = process.env.MOCK_MODE !== "false";
    return {
      module: AnchorModule,
      global: true,
      imports: mock ? [] : [BullModule.registerQueue({ name: "anchor" })],
      controllers: [AnchorController],
      providers: [
        MockAnchorAdapter,
        OmniOneChainAdapter,
        { provide: EVIDENCE_ANCHOR, useFactory: (config: ConfigService, mockAdapter: MockAnchorAdapter, realAdapter: OmniOneChainAdapter) => config.get("MOCK_MODE", "true") === "true" ? mockAdapter : realAdapter, inject: [ConfigService, MockAnchorAdapter, OmniOneChainAdapter] },
        AnchorService,
        AnchorSubmissionService,
        ...(mock
          ? [{ provide: ANCHOR_DISPATCHER, useClass: ImmediateAnchorDispatcher }]
          : [BullAnchorDispatcher, AnchorProcessor, { provide: ANCHOR_DISPATCHER, useExisting: BullAnchorDispatcher }]),
      ],
      exports: [AnchorService, AnchorSubmissionService, ANCHOR_DISPATCHER],
    };
  }
}
