import { describe, expect, it } from "vitest";
import { EventQueryService } from "./event-query.service";
import type { TransactionAvailabilityService } from "./transaction-availability.service";
import type { TransactionService } from "./transaction.service";
import type { TransactionRecord } from "../shared/repository.types";

const record = (id: string, payload: Record<string, unknown> = {}): TransactionRecord => ({
  id,
  bindingId: "b1",
  txHash: id,
  eventType: "transfer_in",
  chain: "1",
  occurredAt: new Date("2025-01-01T00:00:00.000Z"), // identical timestamps
  payload: { id, _version: 1, ...payload },
});

describe("EventQueryService.list cursor tie-breaker (AC18)", () => {
  it("orders identical-timestamp events deterministically by payload.id across calls", async () => {
    const rows = [record("1:c:0"), record("1:a:0"), record("1:b:0")];
    const available = { listOrSync: async () => rows } as unknown as TransactionAvailabilityService;
    const service = new EventQueryService(available, {} as unknown as TransactionService);

    const first = await service.list("u1");
    const second = await service.list("u1");

    const ids = first.items.map((item) => item.event.id);
    expect(ids).toEqual(["1:a:0", "1:b:0", "1:c:0"]);
    expect(second.items.map((item) => item.event.id)).toEqual(ids);
  });
});

describe("EventQueryService SPAM handling", () => {
  const rows = [
    record("1:recv:0", { classification: "RECEIVE", direction: "IN", price_status: "RESOLVED", fiat_value: "100", confidence: 0.9 }),
    record("1:spam:0", { classification: "SPAM", direction: "IN", price_status: "UNKNOWN", fiat_value: null, confidence: 0 }),
    record("1:spam:1", { classification: "SPAM", direction: "IN", price_status: "UNKNOWN", fiat_value: null, confidence: 0 }),
  ];
  const service = () => new EventQueryService({ listOrSync: async () => rows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService);

  it("hides SPAM from the default list but exposes it with includeSpam", async () => {
    const hidden = await service().list("u1");
    expect(hidden.items.map((i) => i.event.id)).toEqual(["1:recv:0"]);
    const shown = await service().list("u1", undefined, undefined, true);
    expect(shown.items.map((i) => i.event.id).sort()).toEqual(["1:recv:0", "1:spam:0", "1:spam:1"]);
  });

  it("excludes SPAM from pendingReview and counts it separately in the summary", async () => {
    const summary = await service().summary("u1");
    expect(summary.spamEventCount).toBe(2);
    expect(summary.pendingReviewCount).toBe(0);
    expect(summary.computableEventCount).toBe(1);
  });
});

describe("EventQueryService cost-basis / P&L merge (read-time)", () => {
  // Buy 1 token @1,000,000 then sell 1 @1,500,000 (18 decimals). Same asset, chronological.
  const rows = [
    record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", chain_id: 1, decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", log_index: 0 }),
    { ...record("1:sell:0", { classification: "SEND", direction: "OUT", asset_type: "ERC20", asset_contract: "0xAAA", chain_id: 1, decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1500000", log_index: 1 }), occurredAt: new Date("2025-01-05T00:00:00.000Z") },
  ];
  const available = { listOrSync: async () => rows } as unknown as TransactionAvailabilityService;
  const transactions = { list: async () => rows, get: async (_u: string, id: string) => rows.find((r) => r.id === id) ?? null } as unknown as TransactionService;
  const service = () => new EventQueryService(available, transactions);

  it("merges cost_basis / pnl / pnl_ratio onto list items via the moving-average engine", async () => {
    const { items } = await service().list("u1");
    const buy = items.find((i) => i.event.id === "1:buy:0")!.event as Record<string, unknown>;
    const sell = items.find((i) => i.event.id === "1:sell:0")!.event as Record<string, unknown>;
    // Acquisition: cost recorded, no realized P/L yet.
    expect(buy.cost_basis).toBe("1000000");
    expect(buy.pnl).toBeNull();
    expect(buy.pnl_ratio).toBeNull();
    // Disposal: +500,000 realized, +50%.
    expect(sell.cost_basis).toBe("1000000");
    expect(sell.pnl).toBe("500000");
    expect(sell.pnl_ratio).toBe("0.5");
  });

  it("exposes the same P&L on the single-event detail view", async () => {
    const detail = await service().detail("u1", "1:sell:0");
    const event = detail.event as Record<string, unknown>;
    expect(event.pnl).toBe("500000");
    expect(event.pnl_ratio).toBe("0.5");
  });

  it("leaves cost_basis / pnl null for an excluded (SPAM) event", async () => {
    const spamRows = [record("1:spam:0", { classification: "SPAM", direction: "IN", price_status: "UNKNOWN", fiat_value: null })];
    const svc = new EventQueryService({ listOrSync: async () => spamRows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService);
    const { items } = await svc.list("u1", undefined, undefined, true);
    const spam = items[0].event as Record<string, unknown>;
    expect(spam.cost_basis).toBeNull();
    expect(spam.pnl).toBeNull();
    expect(spam.pnl_ratio).toBeNull();
  });
});
