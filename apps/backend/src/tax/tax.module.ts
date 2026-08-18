import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IndexerModule } from "../indexer/indexer.module";
import { ReportPersistenceModule } from "../report/report-persistence.module";
import { FrontendTaxController, LegacyRulesetController, TaxController } from "./tax.controller";
import { TaxService } from "./tax.service";
import { FrontendTaxService } from "./frontend-tax.service";

@Module({ imports: [AuthModule, IndexerModule, ReportPersistenceModule], controllers: [TaxController, FrontendTaxController, LegacyRulesetController], providers: [TaxService, FrontendTaxService], exports: [TaxService] })
export class TaxModule {}
