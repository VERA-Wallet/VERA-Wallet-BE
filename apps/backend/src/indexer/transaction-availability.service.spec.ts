import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionAvailabilityService, READ_GATE_WAIT_MS } from "./transaction-availability.service";
import type { TransactionService } from "./transaction.service";
import type { IndexerService } from "./indexer.service";

const setup = (list: ReturnType<typeof vi.fn>, ensureInitialSync: ReturnType<typeof vi.fn>) =>
  new TransactionAvailabilityService({ list } as unknown as TransactionService, { ensureInitialSync } as unknown as IndexerService);
afterEach(() => vi.restoreAllMocks());
describe("transaction read during initial sync", () => {
  it("returns existing data without waiting for a pending new-wallet import", async () => {
    const rows = [{ id: "stored" }];
    const sync = vi.fn(() => new Promise<void>(() => {}));
    const list = vi.fn().mockResolvedValue(rows);
    expect(await setup(list, sync).listOrSync("user")).toBe(rows);
    expect(sync).toHaveBeenCalledWith("user");
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("keeps the bounded initial wait and re-reads when there is no stored data", async () => {
    const rows = [{ id: "new" }];
    const list = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(rows);
    const sync = vi.fn().mockResolvedValue(undefined);
    expect(await setup(list, sync).listOrSync("user")).toBe(rows);
    expect(sync).toHaveBeenCalledWith("user", { waitMs: READ_GATE_WAIT_MS });
  });
  it("handles background errors without discarding stored data", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const rows = [{ id: "stored" }];
    expect(await setup(vi.fn().mockResolvedValue(rows), vi.fn().mockRejectedValue(new Error("outage"))).listOrSync("user")).toBe(rows);
    expect(warn).toHaveBeenCalledOnce();
  });
  it("still surfaces initial sync failure when the account has no data", async () => {
    await expect(setup(vi.fn().mockResolvedValue([]), vi.fn().mockRejectedValue(new Error("outage"))).listOrSync("user")).rejects.toThrow("outage");
  });
});
