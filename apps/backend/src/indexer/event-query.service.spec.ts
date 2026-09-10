import { describe, expect, it } from "vitest";
import { EventQueryService } from "./event-query.service";
import { CostBasisSnapshotService } from "./cost-basis-snapshot.service";
import { MockHistoricalPriceRepository } from "./historical-price.repository.adapters";
import { vi } from "vitest";
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

// Real snapshot provider over an empty price cache. Every fixture carries no gas fee, so
// gas is fully known at zero and no gas_unpriced review is raised.
const snapshot = () => new CostBasisSnapshotService(new MockHistoricalPriceRepository());

describe("EventQueryService.list cursor tie-breaker (AC18)", () => {
  it("orders identical-timestamp events deterministically by payload.id across calls", async () => {
    const rows = [record("1:c:0"), record("1:a:0"), record("1:b:0")];
    const available = { listOrSync: async () => rows } as unknown as TransactionAvailabilityService;
    const service = new EventQueryService(available, {} as unknown as TransactionService, snapshot());

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
  const service = () => new EventQueryService({ listOrSync: async () => rows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService, snapshot());

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
  const service = () => new EventQueryService(available, transactions, snapshot());

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

  it("always emits gas_fee_fiat and omits bridge_move / pnl_review on a plain trade", async () => {
    const { items } = await service().list("u1");
    const sell = items.find((i) => i.event.id === "1:sell:0")!.event as Record<string, unknown>;
    expect("gas_fee_fiat" in sell).toBe(true);
    expect("bridge_move" in sell).toBe(false);
    expect("pnl_review" in sell).toBe(false);
  });

  it("exposes the same P&L on the single-event detail view", async () => {
    const detail = await service().detail("u1", "1:sell:0");
    const event = detail.event as Record<string, unknown>;
    expect(event.pnl).toBe("500000");
    expect(event.pnl_ratio).toBe("0.5");
  });

  it("leaves cost_basis / pnl null for an excluded (SPAM) event", async () => {
    const spamRows = [record("1:spam:0", { classification: "SPAM", direction: "IN", price_status: "UNKNOWN", fiat_value: null })];
    const svc = new EventQueryService({ listOrSync: async () => spamRows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService, snapshot());
    const { items } = await svc.list("u1", undefined, undefined, true);
    const spam = items[0].event as Record<string, unknown>;
    expect(spam.cost_basis).toBeNull();
    expect(spam.pnl).toBeNull();
    expect(spam.pnl_ratio).toBeNull();
  });

  it("reports periodPnl as realized P/L rather than cash flow (S2)", async () => {
    const summary = await service().summary("u1");
    expect(summary.periodPnl).toBe("500000");
    expect(summary.periodPnlBasis).toBe("realized_moving_average");
    expect(summary.unresolvedProceeds).toBe("0");
  });
});

describe("EventQueryService.summary realized P/L attribution", () => {
  const erc20 = (extra: Record<string, unknown>) => ({ asset_type: "ERC20", asset_contract: "0xAAA", chain_id: 1, decimals: 18, ...extra });

  it("carries a prior-year acquisition's cost into an in-period disposal (S1)", async () => {
    // 2024-12-01: buy 2 tokens for 2,000,000 total => 1,000,000 average.
    // 2025-01-05: sell 1 for 1,500,000 => +500,000 realized. Cash flow would have said 1,500,000.
    const rows = [
      { ...record("1:buy:0", erc20({ classification: "RECEIVE", direction: "IN", raw_amount: `2${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "2000000", log_index: 0 })), occurredAt: new Date("2024-12-01T00:00:00.000Z") },
      { ...record("1:sell:0", erc20({ classification: "SEND", direction: "OUT", raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1500000", log_index: 0 })), occurredAt: new Date("2025-01-05T00:00:00.000Z") },
    ];
    const service = new EventQueryService({ listOrSync: async () => rows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService, snapshot());

    const summary = await service.summary("u1", "2025-01-01");

    expect(summary.periodPnl).toBe("500000");
    expect(summary.periodPnlBasis).toBe("realized_moving_average");
  });

  it("keeps a cost-unknown disposal out of periodPnl and reports it as unresolvedProceeds", async () => {
    // A disposal with no tracked acquisition: its cost is "unknown", not "zero".
    const rows = [
      { ...record("1:sell:0", erc20({ classification: "SEND", direction: "OUT", raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "900000", log_index: 0 })), occurredAt: new Date("2025-02-01T00:00:00.000Z") },
    ];
    const service = new EventQueryService({ listOrSync: async () => rows } as unknown as TransactionAvailabilityService, {} as unknown as TransactionService, snapshot());

    const summary = await service.summary("u1", "2025-01-01");

    expect(summary.periodPnl).toBe("0");
    expect(summary.unresolvedProceeds).toBe("900000");
    // The fold's review flag now feeds the pending-review counter.
    expect(summary.pendingReviewCount).toBe(1);
  });
});

describe("EventQueryService bridge cost move (B8 / AC3-9)", () => {
  // 1 ETH bridged from chain 1 to chain 8453, arriving as 0.99 after the bridge fee. The
  // destination sale must recognize the cost that travelled, not read as a disposal
  // exceeding holdings on a cell that started at zero.
  const eth = (chainId: number, extra: Record<string, unknown>) => ({ asset_type: "NATIVE", chain_id: chainId, decimals: 18, ...extra });
  const ONE = `1${"0".repeat(18)}`;
  const POINT99 = "990000000000000000";
  const GROUP = "bridge:1:0xabc";

  const rows = [
    { ...record("1:in:0", eth(1, { classification: "RECEIVE", direction: "IN", raw_amount: ONE, price_status: "RESOLVED", fiat_value: "3000000", log_index: 0 })), occurredAt: new Date("2025-01-01T00:00:00.000Z") },
    { ...record("1:bridgeout:0", eth(1, { classification: "INTERNAL_TRANSFER", direction: "OUT", raw_amount: ONE, price_status: "RESOLVED", fiat_value: "3000000", bridge_group_id: GROUP, log_index: 0 })), occurredAt: new Date("2025-01-02T00:00:00.000Z") },
    { ...record("8453:bridgein:0", eth(8453, { classification: "INTERNAL_TRANSFER", direction: "IN", raw_amount: POINT99, price_status: "RESOLVED", fiat_value: "2970000", bridge_group_id: GROUP, log_index: 0 })), occurredAt: new Date("2025-01-02T00:00:10.000Z") },
    { ...record("8453:sell:0", eth(8453, { classification: "SEND", direction: "OUT", raw_amount: POINT99, price_status: "RESOLVED", fiat_value: "3200000", log_index: 0 })), occurredAt: new Date("2025-01-03T00:00:00.000Z") },
  ];
  const available = { listOrSync: async () => rows } as unknown as TransactionAvailabilityService;
  const service = () => new EventQueryService(available, {} as unknown as TransactionService, snapshot());

  it("prices the destination sale against the moved cost, with no review flag", async () => {
    const { items } = await service().list("u1", undefined, "100", true);
    const sale = items.find((i) => i.event.id === "8453:sell:0")!.event as Record<string, unknown>;

    expect(sale.cost_basis).toBe("3000000");
    expect(sale.pnl).toBe("200000");
    expect("pnl_review" in sale).toBe(false);
  });

  it("labels both legs of the pair with bridge_move and taxes neither", async () => {
    const { items } = await service().list("u1", undefined, "100", true);
    const out = items.find((i) => i.event.id === "1:bridgeout:0")!.event as Record<string, unknown>;
    const into = items.find((i) => i.event.id === "8453:bridgein:0")!.event as Record<string, unknown>;

    expect(out.bridge_move).toBe("out");
    expect(into.bridge_move).toBe("in");
    expect(out.pnl).toBeNull();
    expect(into.pnl).toBeNull();
  });

  it("counts only the destination sale's realized P/L in the summary", async () => {
    const summary = await service().summary("u1");
    expect(summary.periodPnl).toBe("200000");
    expect(summary.unresolvedProceeds).toBe("0");
  });
});

describe("EventQueryService survives a price-cache outage", () => {
  // Before gas accounting these paths never read HistoricalPrice, so a probe failure
  // must not turn a cache outage into a 500 on the whole ledger.
  const rows = [
    record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", chain_id: 1, decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", gas_fee_native: "0.0025", log_index: 0 }),
    { ...record("1:sell:0", { classification: "SEND", direction: "OUT", asset_type: "ERC20", asset_contract: "0xAAA", chain_id: 1, decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1500000", gas_fee_native: "0.0025", log_index: 1 }), occurredAt: new Date("2025-01-05T00:00:00.000Z") },
  ];

  const service = () => {
    const repository = new MockHistoricalPriceRepository();
    vi.spyOn(repository, "getMany").mockRejectedValue(new Error("connection terminated"));
    const available = { listOrSync: async () => rows } as unknown as TransactionAvailabilityService;
    return new EventQueryService(available, {} as unknown as TransactionService, new CostBasisSnapshotService(repository));
  };

  it("still serves the list, with the fee left unvalued", async () => {
    const { items } = await service().list("u1");
    const sell = items.find((i) => i.event.id === "1:sell:0")!.event as Record<string, unknown>;

    expect(sell.pnl).toBe("500000");
    expect(sell.gas_fee_fiat).toBeNull();
    expect(sell.pnl_review).toBe("gas_unpriced");
  });

  it("still serves the summary", async () => {
    const summary = await service().summary("u1");

    expect(summary.periodPnl).toBe("500000");
    // The unvalued fee is a review flag, not an unresolved cost.
    expect(summary.unresolvedProceeds).toBe("0");
    expect(summary.pendingReviewCount).toBe(2);
  });
});
