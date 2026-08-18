import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SharedModule } from "../shared/shared.module";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { TAX_REPOSITORY } from "../tax/tax.tokens";
import { REPORT_REPOSITORY } from "./report.tokens";
import { MockTaxReportRepository, PrismaTaxReportRepository } from "./tax-report.repository.adapters";

@Module({
  imports: [SharedModule],
  providers: [
    MockTaxReportRepository,
    PrismaTaxReportRepository,
    { provide: TAX_REPOSITORY, useFactory: (config: ConfigService, memory: MockTaxReportRepository, prisma: PrismaTaxReportRepository) => usePrismaPersistence(config) ? prisma : memory, inject: [ConfigService, MockTaxReportRepository, PrismaTaxReportRepository] },
    { provide: REPORT_REPOSITORY, useExisting: TAX_REPOSITORY },
  ],
  exports: [TAX_REPOSITORY, REPORT_REPOSITORY],
})
export class ReportPersistenceModule {}
