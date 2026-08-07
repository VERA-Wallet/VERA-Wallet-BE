import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { CalculatedTaxEvent } from "@vera/tax-engine";
import { PrismaService } from "../shared/prisma.service";
import type { ReportRecord, TaxEventRecord } from "../shared/repository.types";
import type { ReportRepository, TaxRepository } from "./tax.repository";

@Injectable()
export class MockTaxRepository implements TaxRepository, ReportRepository {
  private readonly events = new Map<string, TaxEventRecord>();
  private readonly reports = new Map<string, ReportRecord>();
  async createReport(userId: string, period: string, countryCode: string, totalGain: string, events: CalculatedTaxEvent[]) {
    const report: ReportRecord = { id: randomUUID(), userId, period, countryCode, totalGain, status: "draft", createdAt: new Date() };
    this.reports.set(report.id, report);
    for (const event of events) {
      const value: TaxEventRecord = { id: randomUUID(), txId: event.transactionId, reportId: report.id, countryCode, ruleVersion: event.ruleVersion, gainLoss: event.gainLoss, isEstimate: true };
      this.events.set(value.id, value);
    }
    return report;
  }
  async listEvents(userId: string, countryCode?: string) { const reportIds = new Set([...this.reports.values()].filter((report) => report.userId === userId).map((report) => report.id)); return [...this.events.values()].filter((event) => event.reportId !== null && reportIds.has(event.reportId) && (!countryCode || event.countryCode === countryCode)); }
  async findReport(userId: string, id: string) { const value = this.reports.get(id); return value?.userId === userId ? value : null; }
  async listReportEvents(userId: string, reportId: string) { return await this.findReport(userId, reportId) ? [...this.events.values()].filter((event) => event.reportId === reportId) : []; }
  async setReportStatus(userId: string, id: string, status: string) { const report = await this.findReport(userId, id); if (!report) return null; report.status = status; return report; }
}

@Injectable()
export class PrismaTaxRepository implements TaxRepository, ReportRepository {
  constructor(private readonly prisma: PrismaService) {}
  async createReport(userId: string, period: string, countryCode: string, totalGain: string, events: CalculatedTaxEvent[]) {
    const report = await this.prisma.taxReport.create({ data: { userId, period, countryCode, totalGain: new Prisma.Decimal(totalGain), status: "draft" } });
    await this.prisma.taxEvent.createMany({ data: events.map((event) => ({ txId: event.transactionId, reportId: report.id, countryCode, ruleVersion: event.ruleVersion, gainLoss: new Prisma.Decimal(event.gainLoss), isEstimate: true })) });
    return { ...report, totalGain: report.totalGain.toFixed() };
  }
  async listEvents(userId: string, countryCode?: string) { const values = await this.prisma.taxEvent.findMany({ where: { report: { userId }, ...(countryCode ? { countryCode } : {}) } }); return values.map((value) => ({ ...value, gainLoss: value.gainLoss.toFixed() })); }
  async findReport(userId: string, id: string) { const value = await this.prisma.taxReport.findFirst({ where: { id, userId } }); return value ? { ...value, totalGain: value.totalGain.toFixed() } : null; }
  async listReportEvents(userId: string, reportId: string) { const values = await this.prisma.taxEvent.findMany({ where: { reportId, report: { userId } }, orderBy: { id: "asc" } }); return values.map((value) => ({ ...value, gainLoss: value.gainLoss.toFixed() })); }
  async setReportStatus(userId: string, id: string, status: string) { if (!await this.findReport(userId, id)) return null; const value = await this.prisma.taxReport.update({ where: { id }, data: { status } }); return { ...value, totalGain: value.totalGain.toFixed() }; }
}
