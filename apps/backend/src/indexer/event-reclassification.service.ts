import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { TransactionService } from "./transaction.service";
import { eventMutation } from "./event.presenter";
import type { ReclassifyDto } from "./indexer.dto";

@Injectable()
export class EventReclassificationService {
  constructor(private readonly transactions: TransactionService) {}

  async reclassify(userId: string, eventId: string, input: ReclassifyDto) {
    const transaction = await this.transactions.get(userId, eventId);
    if (!transaction) throw new NotFoundException("Event not found.");
    const version = Number(transaction.payload._version ?? 1);
    if (version !== input.expectedVersion) {
      throw new ConflictException({ code: "version_conflict", message: "Event version does not match.", details: { data: eventMutation(transaction) } });
    }
    const overriddenAt = new Date().toISOString();
    const previousOverride = transaction.payload.user_override;
    const from = previousOverride && typeof previousOverride === "object"
      ? (previousOverride as Record<string, unknown>).classification
      : transaction.payload.classification;
    const transition = { from, to: input.classification, reason: input.reason ?? null, overridden_at: overriddenAt };
    const payload = {
      ...transaction.payload,
      classification: input.classification,
      user_override: { classification: input.classification, reason: input.reason ?? null, overridden_at: overriddenAt },
      _version: version + 1,
      _overrideHistory: [...(Array.isArray(transaction.payload._overrideHistory) ? transaction.payload._overrideHistory : []), transition],
    };
    const updated = await this.transactions.update(userId, eventId, payload);
    return eventMutation(updated!);
  }
}
