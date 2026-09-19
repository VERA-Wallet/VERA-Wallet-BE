import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { WalletRepository } from "../wallet/wallet.repository";
import type { IndexerService, SyncResult } from "./indexer.service";
import { InMemorySyncJobStore, type SyncDispatcher } from "./sync-job";
import { SyncJobRunner, SyncJobService, toSyncJobDto, toSyncJobError } from "./sync-job.service";

const result: SyncResult = { bindings: 1, fetched: 0, normalized: 0, chains: [], skipped: [] };
const walletsWith = (count: number) => ({ findAllByUser: vi.fn().mockResolvedValue(Array.from({ length: count }, (_, i) => ({ id: `b${i}` }))) }) as unknown as WalletRepository;

describe("SyncJobService.enqueue", () => {
  it("rejects an unbound wallet synchronously with 404 — nothing is queued", async () => {
    const store = new InMemorySyncJobStore();
    const dispatcher: SyncDispatcher = { enqueue: vi.fn() };
    const service = new SyncJobService(walletsWith(0), store, dispatcher);
    await expect(service.enqueue("u1")).rejects.toBeInstanceOf(NotFoundException);
    expect(dispatcher.enqueue).not.toHaveBeenCalled();
  });

  it("creates a queued job and hands it to the dispatcher", async () => {
    const store = new InMemorySyncJobStore();
    const dispatcher: SyncDispatcher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = new SyncJobService(walletsWith(1), store, dispatcher);
    const job = await service.enqueue("u1");
    expect(job.status).toBe("queued");
    expect(dispatcher.enqueue).toHaveBeenCalledWith(job.id, "u1");
    expect(store.get(job.id)).toEqual(job);
  });

  it("returns the in-flight job instead of starting a second one for the same user", async () => {
    const store = new InMemorySyncJobStore();
    const dispatcher: SyncDispatcher = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = new SyncJobService(walletsWith(1), store, dispatcher);
    const first = await service.enqueue("u1");
    const second = await service.enqueue("u1");
    expect(second.id).toBe(first.id);
    expect(dispatcher.enqueue).toHaveBeenCalledTimes(1);
    // A finished job no longer blocks a new one.
    store.update(first.id, { status: "done", result });
    const third = await service.enqueue("u1");
    expect(third.id).not.toBe(first.id);
  });

  it("marks the job failed when the dispatcher cannot accept it", async () => {
    const store = new InMemorySyncJobStore();
    const dispatcher: SyncDispatcher = { enqueue: vi.fn().mockRejectedValue(new Error("redis down")) };
    const service = new SyncJobService(walletsWith(1), store, dispatcher);
    const job = await service.enqueue("u1");
    expect(job.status).toBe("failed");
    expect(job.error).toEqual({ code: "enqueue_failed", message: "redis down" });
  });
});

describe("SyncJobService.status", () => {
  it("hides other users' jobs behind a 404 rather than a 403", () => {
    const store = new InMemorySyncJobStore();
    const mine = store.create("u1");
    const service = new SyncJobService(walletsWith(1), store, { enqueue: vi.fn() });
    expect(service.status("u1", mine.id)).toEqual(mine);
    expect(() => service.status("u2", mine.id)).toThrow(NotFoundException);
    expect(() => service.status("u1", "nope")).toThrow(NotFoundException);
  });
});

describe("SyncJobRunner.run", () => {
  it("moves queued -> running -> done with the sync result", async () => {
    const store = new InMemorySyncJobStore();
    const job = store.create("u1");
    const transitions: string[] = [];
    const indexer = { sync: vi.fn(async () => { transitions.push(store.get(job.id)!.status); return result; }) } as unknown as IndexerService;
    await new SyncJobRunner(indexer, store).run(job.id, "u1");
    expect(transitions).toEqual(["running"]);
    expect(store.get(job.id)).toMatchObject({ status: "done", result });
  });

  it("records a failed sync as a JSON-safe error instead of throwing", async () => {
    const store = new InMemorySyncJobStore();
    const job = store.create("u1");
    const indexer = { sync: vi.fn().mockRejectedValue(new ServiceUnavailableException("Sync failed for all 1 wallet(s).")) } as unknown as IndexerService;
    await expect(new SyncJobRunner(indexer, store).run(job.id, "u1")).resolves.toBeUndefined();
    expect(store.get(job.id)).toMatchObject({ status: "failed", error: { code: "sync_unavailable", message: "Sync failed for all 1 wallet(s)." } });
  });

  it("forwards progress snapshots into the job record while the sync runs, and the DTO carries them", async () => {
    const store = new InMemorySyncJobStore();
    const job = store.create("u1");
    const progress = { bindings: [{ bindingId: "b1", walletAddress: "0xW1", chains: [{ chainId: 1, phase: "fetching" as const, fetched: 3, saved: 0 }] }], updatedAt: "2026-09-19T00:00:00.000Z" };
    const seenDuringRun: unknown[] = [];
    const indexer = {
      sync: vi.fn(async (_userId: string, options?: { onProgress?: (p: typeof progress) => void }) => {
        options?.onProgress?.(progress);
        seenDuringRun.push(store.get(job.id)?.progress);
        return result;
      }),
    } as unknown as IndexerService;
    await new SyncJobRunner(indexer, store).run(job.id, "u1");
    expect(seenDuringRun).toEqual([progress]);
    expect(toSyncJobDto(store.get(job.id)!)).toMatchObject({ status: "done", result, progress });
  });

  it("ignores a job the store no longer knows (queue survived a restart, record did not)", async () => {
    const store = new InMemorySyncJobStore();
    const indexer = { sync: vi.fn() } as unknown as IndexerService;
    await new SyncJobRunner(indexer, store).run("ghost", "u1");
    expect(indexer.sync).not.toHaveBeenCalled();
  });
});

describe("toSyncJobError", () => {
  it("maps HTTP exceptions by status and everything else to sync_failed", () => {
    expect(toSyncJobError(new ServiceUnavailableException("x")).code).toBe("sync_unavailable");
    expect(toSyncJobError(new NotFoundException("x")).code).toBe("not_found");
    expect(toSyncJobError(new Error("boom"))).toEqual({ code: "sync_failed", message: "boom" });
    expect(toSyncJobError("weird")).toEqual({ code: "sync_failed", message: "Sync failed." });
  });
});

describe("InMemorySyncJobStore", () => {
  it("forgets finished jobs after the TTL but keeps active ones", () => {
    let now = new Date("2026-09-08T00:00:00.000Z");
    const store = new InMemorySyncJobStore(() => now);
    const finished = store.create("u1");
    store.update(finished.id, { status: "done", result });
    const active = store.create("u2");
    now = new Date("2026-09-08T02:00:00.000Z");
    store.create("u3"); // triggers prune
    expect(store.get(finished.id)).toBeUndefined();
    expect(store.get(active.id)).toBeDefined();
  });
});
