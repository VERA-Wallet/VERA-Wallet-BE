import { Inject, Injectable } from "@nestjs/common";
import { TRANSACTION_REPOSITORY } from "./indexer.tokens";
import type { TransactionRepository } from "./transaction.repository";

@Injectable()
export class TransactionService {
  constructor(@Inject(TRANSACTION_REPOSITORY) private readonly transactions: TransactionRepository) {}
  list(userId: string) { return this.transactions.listForUser(userId); }
  get(userId: string, eventId: string) { return this.transactions.findForUser(userId, eventId); }
  update(userId: string, eventId: string, payload: Record<string, unknown>) { return this.transactions.updatePayload(userId, eventId, payload); }
}
