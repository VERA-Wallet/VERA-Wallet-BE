import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { ESTIMATE_DISCLAIMER } from "@vera/tax-engine";
import { keccak256, toBytes } from "viem";
import type { ReportRepository } from "../tax/tax.repository";
import { AnchorSubmissionService } from "../anchor/anchor-submission.service";
import { REPORT_REPOSITORY } from "../shared/tokens";

@Injectable()
export class ReportService {
  constructor(@Inject(REPORT_REPOSITORY) private readonly reports: ReportRepository, private readonly anchors: AnchorSubmissionService) {}

  async get(userId: string, reportId: string) {
    const report = await this.reports.findReport(userId, reportId);
    if (!report) throw new NotFoundException("Report not found.");
    const events = await this.reports.listReportEvents(userId, reportId);
    return { ...report, events, isEstimate: true as const, disclaimer: ESTIMATE_DISCLAIMER };
  }

  async finalize(userId: string, reportId: string) {
    const report = await this.reports.findReport(userId, reportId);
    if (!report) throw new NotFoundException("Report not found.");
    const events = await this.reports.listReportEvents(userId, reportId);
    const auditHash = keccak256(toBytes(JSON.stringify({ reportId: report.id, period: report.period, countryCode: report.countryCode, totalGain: report.totalGain, ruleVersions: [...new Set(events.map((event) => event.ruleVersion))].sort() })));
    await this.reports.setReportStatus(userId, reportId, "finalized");
    const anchor = await this.anchors.submit(auditHash, "audit");
    if (anchor?.status === "anchored") await this.reports.setReportStatus(userId, reportId, "anchored");
    return { reportId, status: anchor?.status === "anchored" ? "anchored" : "finalized", auditHash, anchorStatus: anchor?.status ?? "pending", isEstimate: true as const, disclaimer: ESTIMATE_DISCLAIMER };
  }
}
