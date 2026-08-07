import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { TransactionAvailabilityService } from "./transaction-availability.service";
import { TransactionService } from "./transaction.service";
import { eventDetail, eventMutation, publicEvent } from "./event.presenter";

@Injectable()
export class EventQueryService {
  constructor(private readonly available: TransactionAvailabilityService, private readonly transactions: TransactionService) {}

  async list(userId: string, cursor?: string, rawLimit?: string) {
    const all = await this.available.listOrSync(userId);
    const start = cursor ? Math.max(0, all.findIndex((item) => String(item.payload.id) === cursor) + 1) : 0;
    const limit = Math.min(100, Math.max(1, Number(rawLimit) || 20));
    const items = all.slice(start, start + limit);
    return { items: items.map(eventMutation), nextCursor: start + limit < all.length ? String(items.at(-1)?.payload.id) : null };
  }

  async detail(userId: string, eventId: string) {
    const transaction = await this.transactions.get(userId, eventId);
    if (!transaction) throw new NotFoundException("Event not found.");
    return eventDetail(transaction);
  }

  async summary(userId: string, from?: string, to?: string) {
    this.validatePeriod(from, to);
    const transactions = await this.available.listOrSync(userId);
    const events = transactions
      .filter((item) => (!from || item.occurredAt >= new Date(from)) && (!to || item.occurredAt < new Date(to)))
      .map(publicEvent);
    const computable = events.filter((event) => event.price_status !== "UNKNOWN" && event.classification !== "UNKNOWN" && event.classification !== "INTERNAL_TRANSFER");
    const periodPnl = computable.reduce((sum, event) => {
      const amount = new Decimal(String(event.fiat_value));
      return sum.plus(event.direction === "IN" ? amount.negated() : amount);
    }, new Decimal(0));
    return {
      periodPnl: periodPnl.toFixed(),
      computableEventCount: computable.length,
      taxableEventCount: computable.filter((event) => ["RECEIVE", "SEND", "EXCHANGE"].includes(String(event.classification))).length,
      pendingReviewCount: events.filter((event) => event.classification === "UNKNOWN" || event.price_status === "UNKNOWN" || Number(event.confidence) < 0.5).length,
      currency: String(events[0]?.fiat_currency ?? "KRW"),
      period: { from: from ?? String(events[0]?.block_timestamp ?? ""), to: to ?? String(events.at(-1)?.block_timestamp ?? "") },
    };
  }

  private validatePeriod(from?: string, to?: string) {
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to))) || (from && to && Date.parse(from) >= Date.parse(to))) {
      throw new BadRequestException("Period query must be RFC 3339 with from earlier than to.");
    }
  }
}
