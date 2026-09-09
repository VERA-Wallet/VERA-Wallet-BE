import { describe, expect, it, vi } from "vitest";
import { CostBasisSnapshotService, type CostBasisFold } from "./cost-basis-snapshot.service";
import { MockHistoricalPriceRepository } from "./historical-price.repository.adapters";
import type { HistoricalPriceRepository } from "./historical-price.repository";
import type { TransactionRecord } from "../shared/repository.types";

const record = (id: string, payload: Record<string, unknown> = {}, occurredAt = "2025-01-05T00:00:00.000Z"): TransactionRecord => ({
  id,
  bindingId: "b1",
  txHash: id,
  eventType: "transfer_in",
  chain: "1",
  occurredAt: new Date(occurredAt),
  payload: { id, _version: 1, chain_id: 1, ...payload },
});

// Counts folds and records the options each one received, so the cache contract is
// observable without reaching into the service's WeakMaps.
function spyFold() {
  const calls: (ReadonlyMap<string, string> | undefined)[] = [];
  const spy = vi.fn((_rows: TransactionRecord[], options?: { nativePrices?: ReadonlyMap<string, string> }) => {
    calls.push(options?.nativePrices);
    return new Map();
  });
  return { fold: spy as unknown as CostBasisFold, spy, calls };
}

function service(repository: HistoricalPriceRepository, fold?: CostBasisFold) {
  return new CostBasisSnapshotService(repository, fold);
}

describe("CostBasisSnapshotService fold memoization (AC1-10 / AC2-6)", () => {
  const rows = [record("1:buy:0"), record("1:sell:0")];

  it("joins concurrent list + summary reads into ONE fold (S3)", async () => {
    const { fold, spy } = spyFold();
    const svc = service(new MockHistoricalPriceRepository(), fold);

    const [first, second] = await Promise.all([svc.snapshotFor("u1", rows), svc.snapshotFor("u1", rows)]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });

  it("reuses the memoized nativePrices Map for a repeated read of the same rows instance", async () => {
    const { fold, spy, calls } = spyFold();
    const svc = service(new MockHistoricalPriceRepository(), fold);

    await svc.snapshotFor("u1", rows);
    await svc.snapshotFor("u1", rows);

    expect(spy).toHaveBeenCalledTimes(1);
    // Instance identity is the whole cache contract: there is no content hash anywhere.
    expect(calls[0]).toBeInstanceOf(Map);
  });

  it("folds again for a new rows instance", async () => {
    const { fold, spy, calls } = spyFold();
    const svc = service(new MockHistoricalPriceRepository(), fold);

    await svc.snapshotFor("u1", rows);
    await svc.snapshotFor("u1", [...rows]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls[0]).not.toBe(calls[1]);
  });

  it("takes the NO_GAS sentinel path without touching the price repository when gas is off", async () => {
    const { fold, calls } = spyFold();
    const repository = new MockHistoricalPriceRepository();
    const getMany = vi.spyOn(repository, "getMany");
    const svc = service(repository, fold);

    await svc.snapshotFor("u1", rows, { gas: false });

    expect(getMany).not.toHaveBeenCalled();
    expect(calls[0]).toBeUndefined();
  });

  it("keys the gas-off and gas-on results separately", async () => {
    const { fold, spy } = spyFold();
    const svc = service(new MockHistoricalPriceRepository(), fold);

    await svc.snapshotFor("u1", rows, { gas: false });
    await svc.snapshotFor("u1", rows);

    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("CostBasisSnapshotService native price map", () => {
  it("probes each distinct (chain, day) once and keys the map the way the engine reads it", async () => {
    const repository = new MockHistoricalPriceRepository();
    await repository.put({ chainId: 1, assetKey: "native", date: "2025-01-05", krw: "4000000" });
    const getMany = vi.spyOn(repository, "getMany");
    const { fold, calls } = spyFold();
    // Two rows share a chain+day; the third is a different day.
    const rows = [
      record("1:a:0", { block_timestamp: "2025-01-05T01:00:00Z" }),
      record("1:b:0", { block_timestamp: "2025-01-05T09:00:00Z" }),
      record("1:c:0", { block_timestamp: "2025-01-06T00:00:00Z" }),
    ];

    await service(repository, fold).snapshotFor("u1", rows);

    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany.mock.calls[0][0]).toHaveLength(2);
    // Engine key drops the asset axis: `${chainId}:${YYYY-MM-DD}`.
    expect(calls[0]?.get("1:2025-01-05")).toBe("4000000");
    // A cache miss stays absent, so the engine reports gas_unpriced instead of valuing at zero.
    expect(calls[0]?.has("1:2025-01-06")).toBe(false);
  });

  it("falls back to occurredAt when block_timestamp is unusable", async () => {
    const repository = new MockHistoricalPriceRepository();
    await repository.put({ chainId: 1, assetKey: "native", date: "2025-03-09", krw: "4000000" });
    const { fold, calls } = spyFold();
    const rows = [record("1:a:0", { block_timestamp: "not-a-date" }, "2025-03-09T00:00:00.000Z")];

    await service(repository, fold).snapshotFor("u1", rows);

    expect(calls[0]?.get("1:2025-03-09")).toBe("4000000");
  });

  it("skips rows with no usable chain id and makes no probe when nothing is addressable", async () => {
    const repository = new MockHistoricalPriceRepository();
    const getMany = vi.spyOn(repository, "getMany");
    const { fold, calls } = spyFold();
    const rows = [{ ...record("1:a:0"), payload: { id: "1:a:0", chain_id: "nope" } }];

    await service(repository, fold).snapshotFor("u1", rows);

    expect(getMany).not.toHaveBeenCalled();
    expect(calls[0]?.size).toBe(0);
  });
});

describe("CostBasisSnapshotService price-cache failure (availability)", () => {
  const gasRow = () => [
    record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", block_timestamp: "2025-01-05T00:00:00Z", gas_fee_native: "0.0025" }),
  ];

  it("degrades to an empty price map instead of failing the read", async () => {
    const repository = new MockHistoricalPriceRepository();
    vi.spyOn(repository, "getMany").mockRejectedValue(new Error("connection terminated"));
    const rows = gasRow();

    const basis = await service(repository).snapshotFor("u1", rows);

    // The read survives; the fee is simply left unvalued, exactly as a cache miss would.
    expect(basis.get("1:buy:0")?.gasFiat).toBeNull();
    expect(basis.get("1:buy:0")?.review).toBe("gas_unpriced");
    expect(basis.get("1:buy:0")?.costBasis).toBe("1000000");
  });

  it("leaves a zero-gas event unflagged when the probe fails", async () => {
    const repository = new MockHistoricalPriceRepository();
    vi.spyOn(repository, "getMany").mockRejectedValue(new Error("connection terminated"));
    const rows = [
      record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", gas_fee_native: "0" }),
    ];

    const basis = await service(repository).snapshotFor("u1", rows);

    // A zero fee is fully known, so there is nothing to review.
    expect(basis.get("1:buy:0")?.review).toBeUndefined();
  });

  it("does not memoize the failure: the next read probes again and recovers", async () => {
    const repository = new MockHistoricalPriceRepository();
    await repository.put({ chainId: 1, assetKey: "native", date: "2025-01-05", krw: "4000000" });
    const getMany = vi.spyOn(repository, "getMany");
    getMany.mockRejectedValueOnce(new Error("connection terminated"));
    const svc = service(repository);
    const rows = gasRow();

    const degraded = await svc.snapshotFor("u1", rows);
    const recovered = await svc.snapshotFor("u1", rows);

    expect(getMany).toHaveBeenCalledTimes(2);
    expect(degraded.get("1:buy:0")?.review).toBe("gas_unpriced");
    // Second read gets real prices, so the fee is capitalized and the flag is gone.
    expect(recovered.get("1:buy:0")?.gasFiat).toBe("10000");
    expect(recovered.get("1:buy:0")?.review).toBeUndefined();
  });

  it("does not memoize a rejected fold", async () => {
    const spy = vi.fn(() => { throw new Error("malformed ledger"); });
    const svc = service(new MockHistoricalPriceRepository(), spy as unknown as CostBasisFold);
    const rows = gasRow();

    await expect(svc.snapshotFor("u1", rows)).rejects.toThrow("malformed ledger");
    await expect(svc.snapshotFor("u1", rows)).rejects.toThrow("malformed ledger");

    // A pinned rejection would have replayed without re-running the fold.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("CostBasisSnapshotService default fold", () => {
  it("uses the real engine when no fold is injected", async () => {
    const rows = [
      record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", gas_fee_native: "0" }, "2025-01-01T00:00:00.000Z"),
      record("1:sell:0", { classification: "SEND", direction: "OUT", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1500000", gas_fee_native: "0" }),
    ];

    const basis = await service(new MockHistoricalPriceRepository()).snapshotFor("u1", rows);

    expect(basis.get("1:sell:0")?.realizedPnl).toBe("500000");
    // Zero gas is fully known, so no review is raised even against an empty price cache.
    expect(basis.get("1:sell:0")?.review).toBeUndefined();
  });

  // The map this service builds is only useful if the engine looks the SAME key up.
  // A drift in either half turns every priced fee into gas_unpriced silently, so pin
  // the round trip rather than the string format on one side.
  it("hands the engine keys it actually reads: a warmed close capitalizes the fee", async () => {
    const repository = new MockHistoricalPriceRepository();
    await repository.put({ chainId: 1, assetKey: "native", date: "2025-01-05", krw: "4000000" });
    const rows = [
      record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", block_timestamp: "2025-01-05T00:00:00Z", gas_fee_native: "0.0025" }),
    ];

    const basis = await service(repository).snapshotFor("u1", rows);

    // 0.0025 ETH x 4,000,000 KRW = 10,000 capitalized into the acquisition cost.
    expect(basis.get("1:buy:0")?.gasFiat).toBe("10000");
    expect(basis.get("1:buy:0")?.costBasis).toBe("1010000");
    expect(basis.get("1:buy:0")?.review).toBeUndefined();
  });

  it("reports gas_unpriced when the close for that (chain, day) was never warmed", async () => {
    const rows = [
      record("1:buy:0", { classification: "RECEIVE", direction: "IN", asset_type: "ERC20", asset_contract: "0xAAA", decimals: 18, raw_amount: `1${"0".repeat(18)}`, price_status: "RESOLVED", fiat_value: "1000000", block_timestamp: "2025-01-05T00:00:00Z", gas_fee_native: "0.001" }),
    ];

    const basis = await service(new MockHistoricalPriceRepository()).snapshotFor("u1", rows);

    expect(basis.get("1:buy:0")?.gasFiat).toBeNull();
    expect(basis.get("1:buy:0")?.costBasis).toBe("1000000");
    expect(basis.get("1:buy:0")?.review).toBe("gas_unpriced");
  });
});
