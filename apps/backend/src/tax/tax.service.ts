import { BadRequestException, Injectable } from "@nestjs/common";
import { calculateTaxEvents, ESTIMATE_DISCLAIMER, summarize } from "@vera/tax-engine";
import { Inject } from "@nestjs/common";
import type { TransactionRepository } from "../indexer/transaction.repository";
import { TRANSACTION_REPOSITORY } from "../indexer/indexer.tokens";
import type { TaxRepository } from "./tax.repository";
import { TAX_REPOSITORY } from "./tax.tokens";

@Injectable()
export class TaxService {
  constructor(@Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepository, @Inject(TAX_REPOSITORY) private readonly taxes: TaxRepository) {}

  async calculate(userId: string, input: { countryCode: string; period: string; ruleVersion?: string }) {
    const all = await this.transactions.listForUser(userId);
    const year = Number(input.period.slice(0, 4));
    if (!Number.isInteger(year)) throw new BadRequestException("period must begin with a four-digit year.");
    const half = input.period.endsWith("-H1") ? 1 : input.period.endsWith("-H2") ? 2 : null;
    const filtered = all.filter((transaction) => transaction.occurredAt.getUTCFullYear() === year && (half === null || (half === 1 ? transaction.occurredAt.getUTCMonth() < 6 : transaction.occurredAt.getUTCMonth() >= 6)));
    let events;
    try { events = calculateTaxEvents(filtered, input.countryCode, input.ruleVersion); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Unsupported country."); }
    const totals = summarize(events);
    const report = await this.taxes.createReport(userId, input.period, input.countryCode, totals.totalGain, events);
    return { reportId: report.id, period: report.period, countryCode: report.countryCode, ruleVersion: events[0]?.ruleVersion ?? input.ruleVersion, events, ...totals };
  }

  async listEvents(userId: string, countryCode?: string) {
    return { items: await this.taxes.listEvents(userId, countryCode), isEstimate: true as const, disclaimer: ESTIMATE_DISCLAIMER };
  }

}
