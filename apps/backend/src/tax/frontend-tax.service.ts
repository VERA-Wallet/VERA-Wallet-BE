import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { calculateFrontendEstimate, listFrontendRuleSets } from "@vera/tax-engine";
import type { TransactionAvailabilityPort } from "../indexer/transaction.repository";
import { COST_BASIS_SNAPSHOT, TRANSACTION_AVAILABILITY } from "../indexer/indexer.tokens";
import type { CostBasisSnapshotPort } from "../indexer/cost-basis-snapshot.port";

@Injectable()
export class FrontendTaxService {
  constructor(
    @Inject(TRANSACTION_AVAILABILITY) private readonly transactions: TransactionAvailabilityPort,
    @Inject(COST_BASIS_SNAPSHOT) private readonly snapshot: CostBasisSnapshotPort,
  ) {}
  listRuleSets() { return listFrontendRuleSets(); }
  async estimate(userId: string, country: string, taxYear: number, _source: "scenario" | "wallet") {
    // The fold runs over the FULL history and the tax year is applied inside the estimate,
    // so a prior-year acquisition still carries its cost into this year's disposals.
    // Shared provider: the same snapshot the events read path used costs no second fold.
    const rows = await this.transactions.listOrSync(userId);
    const basis = await this.snapshot.snapshotFor(userId, rows);
    try { return calculateFrontendEstimate(rows, country, taxYear, basis); }
    catch (error) { throw new BadRequestException(error instanceof Error ? error.message : "Unsupported country."); }
  }
}
