import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { computeCostBasis } from "@vera/tax-engine";
import { TransactionAvailabilityService } from "./transaction-availability.service";
import { TransactionService } from "./transaction.service";
import type { TransactionRecord } from "../shared/repository.types";
import { eventDetail, eventMutation, publicEvent } from "./event.presenter";

// 페이지 상한. 100이면 실지갑(스팸 제외 1,300건)의 대시보드 한 번에 13번 왕복한다. 응답은 건당 ~1KB라 1,000건도 1MB 안팎이다.
export const MAX_PAGE_LIMIT = 1_000;

@Injectable()
export class EventQueryService {
  // 원가 fold는 사용자 전체 이력에 대한 순서 의존 계산이라 페이지마다 다시 돌리면 13페이지에 13번이다.
  // 저장소 캐시가 같은 배열 인스턴스를 돌려주는 동안은 한 번만 접고 재사용한다(배열이 바뀌면 자연히 다시 계산).
  private readonly basisBySnapshot = new WeakMap<TransactionRecord[], ReturnType<typeof computeCostBasis>>();

  constructor(private readonly available: TransactionAvailabilityService, private readonly transactions: TransactionService) {}

  private basisFor(source: TransactionRecord[]) {
    let basis = this.basisBySnapshot.get(source);
    if (!basis) {
      basis = computeCostBasis(source);
      this.basisBySnapshot.set(source, basis);
    }
    return basis;
  }

  async list(userId: string, cursor?: string, rawLimit?: string, includeSpam = false) {
    // Spam/dust is hidden from the default ledger; a "?includeSpam=true" view exposes
    // it so a false positive can be manually reclassified back to a real category.
    const source = await this.available.listOrSync(userId);
    // Cost basis is order-dependent, so it is folded over the user's FULL history (the
    // engine sorts + excludes spam/unknown itself) and merged onto whichever page is shown.
    // Read-time only: nothing here is persisted.
    const basis = this.basisFor(source);
    const visible = includeSpam ? source : source.filter((item) => item.payload.classification !== "SPAM");
    const all = [...visible].sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || String(a.payload.id).localeCompare(String(b.payload.id)),
    );
    const start = cursor ? Math.max(0, all.findIndex((item) => String(item.payload.id) === cursor) + 1) : 0;
    const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number(rawLimit) || 20));
    const items = all.slice(start, start + limit);
    return {
      items: items.map((item) => eventMutation(item, basis.get(String(item.payload.id)))),
      nextCursor: start + limit < all.length ? String(items.at(-1)?.payload.id) : null,
    };
  }

  async detail(userId: string, eventId: string) {
    const transaction = await this.transactions.get(userId, eventId);
    if (!transaction) throw new NotFoundException("Event not found.");
    // Fold cost basis over the full user history so the target event's running-average
    // cost / realized P/L match the list view exactly.
    const basis = this.basisFor(await this.transactions.list(userId));
    return eventDetail(transaction, basis.get(String(transaction.payload.id)));
  }

  async summary(userId: string, from?: string, to?: string) {
    this.validatePeriod(from, to);
    const transactions = await this.available.listOrSync(userId);
    const events = transactions
      .filter((item) => (!from || item.occurredAt >= new Date(from)) && (!to || item.occurredAt < new Date(to)))
      .map((item) => publicEvent(item));
    const computable = events.filter((event) => event.classification !== "SPAM" && event.price_status !== "UNKNOWN" && event.classification !== "UNKNOWN" && event.classification !== "INTERNAL_TRANSFER");
    const periodPnl = computable.reduce((sum, event) => {
      const amount = new Decimal(String(event.fiat_value));
      return sum.plus(event.direction === "IN" ? amount.negated() : amount);
    }, new Decimal(0));
    const reviewable = events.filter((event) => event.classification !== "SPAM");
    return {
      periodPnl: periodPnl.toFixed(),
      computableEventCount: computable.length,
      taxableEventCount: computable.filter((event) => ["RECEIVE", "SEND", "EXCHANGE"].includes(String(event.classification))).length,
      pendingReviewCount: reviewable.filter((event) => event.classification === "UNKNOWN" || event.price_status === "UNKNOWN" || Number(event.confidence) < 0.5).length,
      spamEventCount: events.length - reviewable.length,
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
