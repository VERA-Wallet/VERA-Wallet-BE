import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import Decimal from "decimal.js";
import { TransactionAvailabilityService } from "./transaction-availability.service";
import { TransactionService } from "./transaction.service";
import { CostBasisSnapshotService } from "./cost-basis-snapshot.service";
import { eventDetail, eventMutation, publicEvent } from "./event.presenter";

// 페이지 상한. 100이면 실지갑(스팸 제외 1,300건)의 대시보드 한 번에 13번 왕복한다. 응답은 건당 ~1KB라 1,000건도 1MB 안팎이다.
export const MAX_PAGE_LIMIT = 1_000;

// summary().periodPnl의 산출 근거. 현금흐름 합계에서 이동평균 실현손익으로 바뀌었으므로
// 필드명을 유지하는 대신 근거를 응답에 명시한다(계획서 D3).
export const PERIOD_PNL_BASIS = "realized_moving_average";

// 취득 원가를 확인할 수 없는 처분. 개별 이벤트에는 아는 값을 그대로 싣되 합계에서는 뺀다.
const REVIEW_UNRESOLVED_COST = "disposal_exceeds_holdings";

@Injectable()
export class EventQueryService {
  // 원가 fold는 사용자 전체 이력에 대한 순서 의존 계산이라 페이지마다 다시 돌리면 13페이지에 13번이다.
  // 스냅샷 provider가 (rows 인스턴스, native 시세 맵 인스턴스) 2단 메모로 요청당 1회를 보장한다.
  constructor(
    private readonly available: TransactionAvailabilityService,
    private readonly transactions: TransactionService,
    private readonly snapshot: CostBasisSnapshotService,
  ) {}

  async list(userId: string, cursor?: string, rawLimit?: string, includeSpam = false) {
    // Spam/dust is hidden from the default ledger; a "?includeSpam=true" view exposes
    // it so a false positive can be manually reclassified back to a real category.
    const source = await this.available.listOrSync(userId);
    // Cost basis is order-dependent, so it is folded over the user's FULL history (the
    // engine sorts + excludes spam/unknown itself) and merged onto whichever page is shown.
    // Read-time only: nothing here is persisted.
    const basis = await this.snapshot.snapshotFor(userId, source);
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
    const basis = await this.snapshot.snapshotFor(userId, await this.transactions.list(userId));
    return eventDetail(transaction, basis.get(String(transaction.payload.id)));
  }

  async summary(userId: string, from?: string, to?: string) {
    this.validatePeriod(from, to);
    const source = await this.available.listOrSync(userId);
    // fold는 기간 필터 이전, 전체 이력에 대해 돈다. 연도를 먼저 자르면 전년도 취득 원가가
    // 사라져 모든 처분이 disposal_exceeds_holdings가 된다(계획서 결정 1).
    const basis = await this.snapshot.snapshotFor(userId, source);
    const scoped = source.filter((item) => (!from || item.occurredAt >= new Date(from)) && (!to || item.occurredAt < new Date(to)));
    const events = scoped.map((item) => publicEvent(item));
    const computable = events.filter((event) => event.classification !== "SPAM" && event.price_status !== "UNKNOWN" && event.classification !== "UNKNOWN" && event.classification !== "INTERNAL_TRANSFER");

    // 실현손익 귀속: 기간 내 처분(OUT)의 realizedPnl만 더한다. 취득은 0 기여이고,
    // 원가 미확인 처분은 원가가 "0"이 아니라 "모름"이라 합계에서 빼고 따로 보고한다.
    let periodPnl = new Decimal(0);
    let unresolvedProceeds = new Decimal(0);
    for (const item of scoped) {
      const entry = basis.get(String(item.payload.id));
      if (!entry || entry.excluded || entry.direction !== "OUT") continue;
      if (entry.review === REVIEW_UNRESOLVED_COST) {
        if (entry.proceeds !== null) unresolvedProceeds = unresolvedProceeds.plus(entry.proceeds);
        continue;
      }
      if (entry.realizedPnl !== null) periodPnl = periodPnl.plus(entry.realizedPnl);
    }

    const reviewable = events.filter((event) => event.classification !== "SPAM");
    return {
      periodPnl: periodPnl.toFixed(),
      periodPnlBasis: PERIOD_PNL_BASIS,
      unresolvedProceeds: unresolvedProceeds.toFixed(),
      computableEventCount: computable.length,
      taxableEventCount: computable.filter((event) => ["RECEIVE", "SEND", "EXCHANGE"].includes(String(event.classification))).length,
      // 기존 세 조건에 더해 fold가 남긴 review 플래그(원가 미확인·브릿지 미매칭·가스 미평가)도 검토 대상이다.
      pendingReviewCount: reviewable.filter((event) => event.classification === "UNKNOWN" || event.price_status === "UNKNOWN" || Number(event.confidence) < 0.5 || basis.get(String(event.id))?.review !== undefined).length,
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
