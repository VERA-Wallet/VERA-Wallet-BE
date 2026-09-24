import { Module } from "@nestjs/common";
import { SharedModule } from "../shared/shared.module";
import { AnchorModule } from "../anchor/anchor.module";
import { AuthModule } from "../auth/auth.module";
import { ReportVcController } from "./report-vc.controller";
import { ReportVcService } from "./report-vc.service";
import { ReportVcStore } from "./report-vc.store";
import { ReportVcGateway } from "./report-vc.gateway";
@Module({ imports: [SharedModule, AnchorModule, AuthModule], controllers: [ReportVcController], providers: [ReportVcService, ReportVcStore, ReportVcGateway] })
export class ReportVcModule {}
