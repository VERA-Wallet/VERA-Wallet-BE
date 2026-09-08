import { Injectable } from "@nestjs/common";
import type { TransactionAvailabilityPort } from "./transaction.repository";
import { IndexerService } from "./indexer.service";
import { TransactionService } from "./transaction.service";

// A read waits at most this long for a binding's first sync. Below the FE's 5s upstream timeout with margin;
// in the mock path the sync is instant so this never triggers.
export const READ_GATE_WAIT_MS = 3_000;

@Injectable()
export class TransactionAvailabilityService implements TransactionAvailabilityPort {
  constructor(private readonly transactions: TransactionService, private readonly indexer: IndexerService) {}
  async listOrSync(userId: string) {
    // Manual-only: perform ONLY the first sync per binding (gated on the initialSyncedAt marker).
    // Once a binding's first attempt has returned a result it is never re-synced on a read;
    // new transactions arrive via the manual resync endpoint. The wait is bounded (see READ_GATE_WAIT_MS):
    // a slow first sync keeps running in the background and the read returns what is stored so far.
    await this.indexer.ensureInitialSync(userId, { waitMs: READ_GATE_WAIT_MS });
    return this.transactions.list(userId);
  }
}
