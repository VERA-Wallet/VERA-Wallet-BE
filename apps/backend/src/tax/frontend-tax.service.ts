import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { calculateFrontendEstimate, listFrontendRuleSets } from "@vera/tax-engine";
import type { TransactionAvailabilityPort } from "../indexer/transaction.repository";
import { TRANSACTION_AVAILABILITY } from "../indexer/indexer.tokens";

@Injectable()
export class FrontendTaxService {
  constructor(@Inject(TRANSACTION_AVAILABILITY) private readonly transactions: TransactionAvailabilityPort) {}
  listRuleSets() { return listFrontendRuleSets(); }
  async estimate(userId: string, country: string, taxYear: number, _source: "scenario" | "wallet") {
    const transactions = await this.transactions.listOrSync(userId);
    try { return calculateFrontendEstimate(transactions, country, taxYear); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Unsupported country."); }
  }
}
