import { Module } from "@nestjs/common";
import { AnchorModule } from "../anchor/anchor.module";
import { AuthModule } from "../auth/auth.module";
import { ReportPersistenceModule } from "./report-persistence.module";
import { ReportController } from "./report.controller";
import { ReportService } from "./report.service";

@Module({ imports: [AuthModule, AnchorModule, ReportPersistenceModule], controllers: [ReportController], providers: [ReportService] })
export class ReportModule {}
