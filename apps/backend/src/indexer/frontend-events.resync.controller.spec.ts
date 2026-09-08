import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FrontendEventCommandController } from "./frontend-events.controller";
import type { EventReclassificationService } from "./event-reclassification.service";
import type { SyncJobService } from "./sync-job.service";
import type { SyncJobRecord } from "./sync-job";

const user = { sub: "u1", didHash: "0x", countryCode: "KR" } as never;
const at = new Date("2026-09-08T07:00:00.000Z");

describe("FrontendEventCommandController.resync (POST /api/events/resync)", () => {
  it("accepts the sync as a background job and returns its id — the response is a receipt, not a result", async () => {
    const queued: SyncJobRecord = { id: "sync-1", userId: "u1", status: "queued", createdAt: at, updatedAt: at };
    const jobs = { enqueue: vi.fn().mockResolvedValue(queued), status: vi.fn() } as unknown as SyncJobService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, jobs);

    const response = await controller.resync(user);

    expect(jobs.enqueue).toHaveBeenCalledWith("u1");
    expect(response.data).toEqual({ jobId: "sync-1", status: "queued", createdAt: at.toISOString(), updatedAt: at.toISOString() });
    expect(response.meta.provenance).toBeDefined();
  });

  it("keeps the unbound-wallet 404 synchronous (FE contract probes pin it)", async () => {
    const jobs = { enqueue: vi.fn().mockRejectedValue(new NotFoundException("A bound wallet is required before sync.")), status: vi.fn() } as unknown as SyncJobService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, jobs);
    await expect(controller.resync(user)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("FrontendEventCommandController.resyncStatus (GET /api/events/resync/:jobId)", () => {
  it("returns the job with its JSON-safe result once done", async () => {
    const result = {
      bindings: 2, fetched: 5, normalized: 5,
      chains: [{ chainId: 1, fetched: 5 }, { chainId: 10, fetched: 0 }],
      skipped: [{ bindingId: "b1", chainId: 10, code: "chain_incomplete" }, { bindingId: "b2", code: "binding_unavailable" }],
    };
    const done: SyncJobRecord = { id: "sync-1", userId: "u1", status: "done", createdAt: at, updatedAt: at, result };
    const jobs = { enqueue: vi.fn(), status: vi.fn().mockReturnValue(done) } as unknown as SyncJobService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, jobs);

    const response = await controller.resyncStatus(user, "sync-1");

    expect(jobs.status).toHaveBeenCalledWith("u1", "sync-1");
    expect(response.data.status).toBe("done");
    expect(response.data.result).toEqual(result);
    // The skipped diagnostics must survive JSON serialization untouched (no raw Error -> {}).
    expect(JSON.parse(JSON.stringify(response.data.result?.skipped))).toEqual(result.skipped);
  });

  it("carries a failed job's error code and message", async () => {
    const failed: SyncJobRecord = { id: "sync-2", userId: "u1", status: "failed", createdAt: at, updatedAt: at, error: { code: "sync_unavailable", message: "outage" } };
    const jobs = { enqueue: vi.fn(), status: vi.fn().mockReturnValue(failed) } as unknown as SyncJobService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, jobs);
    const response = await controller.resyncStatus(user, "sync-2");
    expect(response.data).toMatchObject({ status: "failed", error: { code: "sync_unavailable", message: "outage" } });
    expect(response.data.result).toBeUndefined();
  });
});
