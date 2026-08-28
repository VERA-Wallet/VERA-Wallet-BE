import { Injectable } from "@nestjs/common";
import type { TransactionAvailabilityPort } from "./transaction.repository";
import { IndexerService } from "./indexer.service";
import { TransactionService } from "./transaction.service";

@Injectable()
export class TransactionAvailabilityService implements TransactionAvailabilityPort {
  constructor(private readonly transactions: TransactionService, private readonly indexer: IndexerService) {}
  async listOrSync(userId: string) {
    // Manual-only: perform ONLY the first sync per binding (gated on the initialSyncedAt marker).
    // Once a binding's first attempt has returned a result it is never re-synced on a read;
    // new transactions arrive via the manual resync endpoint.
    await this.indexer.ensureInitialSync(userId);
    return this.transactions.list(userId);
  }
}
