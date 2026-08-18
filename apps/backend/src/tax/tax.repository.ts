import type { CalculatedTaxEvent } from "@vera/tax-engine";
import type { ReportRecord, TaxEventRecord } from "../shared/repository.types";

export interface TaxRepository {
  createReport(userId: string, period: string, countryCode: string, totalGain: string, events: CalculatedTaxEvent[]): Promise<ReportRecord>;
  listEvents(userId: string, countryCode?: string): Promise<TaxEventRecord[]>;
}
