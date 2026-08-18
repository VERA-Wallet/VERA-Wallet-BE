import { Injectable } from "@nestjs/common";
import type { TransactionAvailabilityPort } from "./transaction.repository";
import { IndexerService } from "./indexer.service";
import { TransactionService } from "./transaction.service";

@Injectable()
export class TransactionAvailabilityService implements TransactionAvailabilityPort {
  constructor(private readonly transactions: TransactionService, private readonly indexer: IndexerService) {}
  async listOrSync(userId: string) {
    let values = await this.transactions.list(userId);
    if (values.length === 0) {
      await this.indexer.sync(userId);
      values = await this.transactions.list(userId);
    }
    return values;
  }
}
