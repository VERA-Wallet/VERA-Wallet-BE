import type { ReportRecord, TaxEventRecord } from "../shared/repository.types";

export interface ReportRepository {
  findReport(userId: string, id: string): Promise<ReportRecord | null>;
  listReportEvents(userId: string, reportId: string): Promise<TaxEventRecord[]>;
  setReportStatus(userId: string, id: string, status: string): Promise<ReportRecord | null>;
}
