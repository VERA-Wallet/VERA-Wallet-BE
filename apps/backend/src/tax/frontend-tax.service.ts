import { BadRequestException, Injectable } from "@nestjs/common";
import { calculateFrontendEstimate, listFrontendRuleSets } from "@vera/tax-engine";
import { TransactionAvailabilityService } from "../indexer/transaction-availability.service";

@Injectable()
export class FrontendTaxService {
  constructor(private readonly transactions: TransactionAvailabilityService) {}
  listRuleSets() { return listFrontendRuleSets(); }
  async estimate(userId: string, country: string, taxYear: number, _source: "scenario" | "wallet") {
    const transactions = await this.transactions.listOrSync(userId);
    try { return calculateFrontendEstimate(transactions, country, taxYear); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Unsupported country."); }
  }
}
