import { ConfigService } from "@nestjs/config";
import { Module } from "@nestjs/common";
import { AnchorModule } from "../anchor/anchor.module";
import { SharedModule } from "../shared/shared.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { TaxEvidenceController } from "./evidence.controller";
import { MockTaxEvidenceRepository, PrismaTaxEvidenceRepository } from "./evidence.repository.adapters";
import { TaxEvidenceService } from "./evidence.service";
import { TAX_EVIDENCE_REPOSITORY } from "./evidence.tokens";

@Module({
  imports: [SharedModule, AnchorModule],
  controllers: [TaxEvidenceController],
  providers: [
    MockTaxEvidenceRepository,
    PrismaTaxEvidenceRepository,
    {
      provide: TAX_EVIDENCE_REPOSITORY,
      useFactory: (config: ConfigService, memory: MockTaxEvidenceRepository, prisma: PrismaTaxEvidenceRepository) =>
        usePrismaPersistence(config) ? prisma : memory,
      inject: [ConfigService, MockTaxEvidenceRepository, PrismaTaxEvidenceRepository],
    },
    TaxEvidenceService,
  ],
})
export class TaxEvidenceModule {}
