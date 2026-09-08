import { HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import { IndexerService } from "./indexer.service";
import { SYNC_DISPATCHER, SYNC_JOB_STORE } from "./indexer.tokens";
import type { SyncDispatcher, SyncJobError, SyncJobRecord, SyncJobStore } from "./sync-job";

const sanitize = (message: unknown): string =>
  typeof message === "string" && message.length > 0 ? message.slice(0, 200) : "Sync failed.";

/** 작업 실패를 JSON-safe 오류로 바꾼다. 스택·원문 예외는 밖으로 내보내지 않는다. */
export function toSyncJobError(error: unknown): SyncJobError {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const raw = error.getResponse();
    const code = typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : status >= 500 ? "sync_unavailable" : status === 404 ? "not_found" : "sync_rejected";
    return { code, message: sanitize(error.message) };
  }
  return { code: "sync_failed", message: sanitize(error instanceof Error ? error.message : undefined) };
}

/** 작업 본체. 디스패처(프로세스 내 즉시 실행 / Bull)가 부른다. 상태 전이는 전부 여기서만 일어난다. */
@Injectable()
export class SyncJobRunner {
  private readonly logger = new Logger(SyncJobRunner.name);

  constructor(private readonly indexer: IndexerService, @Inject(SYNC_JOB_STORE) private readonly store: SyncJobStore) {}

  async run(jobId: string, userId: string): Promise<void> {
    if (!this.store.get(jobId)) {
      // 재시작으로 저장소가 비었는데 Redis에 남아 있던 작업이 도착한 경우. 상태를 받을 주체가 없으므로 그냥 끝낸다.
      this.logger.warn(`Sync job ${jobId} has no record; skipping.`);
      return;
    }
    this.store.update(jobId, { status: "running" });
    try {
      const result = await this.indexer.sync(userId);
      this.store.update(jobId, { status: "done", result });
    } catch (error) {
      const failure = toSyncJobError(error);
      this.logger.warn(`Sync job ${jobId} failed: ${failure.code} ${failure.message}`);
      this.store.update(jobId, { status: "failed", error: failure });
    }
  }
}

/** HTTP 경계가 쓰는 유스케이스: 받기(enqueue)와 상태 조회. */
@Injectable()
export class SyncJobService {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(SYNC_JOB_STORE) private readonly store: SyncJobStore,
    @Inject(SYNC_DISPATCHER) private readonly dispatcher: SyncDispatcher,
  ) {}

  /**
   * 바인딩이 없으면 여기서 404를 낸다(동기) — 받아 놓고 나중에 실패시키면 화면이 원인을 모른다.
   * 같은 사용자의 작업이 아직 돌고 있으면 새로 만들지 않고 그것을 돌려준다. 새로고침 연타가 Alchemy 호출을 곱하지 않도록.
   */
  async enqueue(userId: string): Promise<SyncJobRecord> {
    const bindings = await this.wallets.findAllByUser(userId);
    if (bindings.length === 0) throw new NotFoundException("A bound wallet is required before sync.");
    const active = this.store.findActiveForUser(userId);
    if (active) return active;
    const job = this.store.create(userId);
    try {
      await this.dispatcher.enqueue(job.id, userId);
    } catch (error) {
      return this.store.update(job.id, { status: "failed", error: { code: "enqueue_failed", message: sanitize(error instanceof Error ? error.message : undefined) } });
    }
    // 프로세스 내 디스패처는 이미 상태를 바꿨을 수 있다. 최신 레코드를 돌려준다.
    return this.store.get(job.id) ?? job;
  }

  /** 남의 작업은 존재 자체를 말하지 않는다(403이 아니라 404). */
  status(userId: string, jobId: string): SyncJobRecord {
    const job = this.store.get(jobId);
    if (!job || job.userId !== userId) throw new NotFoundException("Sync job not found.");
    return job;
  }
}

/** API 응답 형태. 내부 레코드의 id를 jobId로 내보내고 Date는 RFC3339로 만든다. */
export type SyncJobDto = {
  jobId: string;
  status: SyncJobRecord["status"];
  createdAt: string;
  updatedAt: string;
  result?: SyncJobRecord["result"];
  error?: SyncJobError;
};

export function toSyncJobDto(job: SyncJobRecord): SyncJobDto {
  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}
