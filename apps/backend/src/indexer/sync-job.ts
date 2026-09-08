import type { SyncResult } from "./indexer.service";

/**
 * 비동기 동기화 작업.
 *
 * `POST /api/events/resync`는 지갑 하나의 최초 동기화만 해도 체인 5개 수집과 CoinGecko 과거 시세 조회를 끝내야 하므로
 * 수십 초가 걸린다. 그 시간을 HTTP 응답 하나에 묶어 두면 프록시·브라우저 타임아웃(Next 외부 rewrite 30초)이 먼저 끊고,
 * BE는 뒤에서 정상 완료하는데 화면만 "다 불러오지 못했습니다"가 된다(2026-09-08 실지갑 검증에서 35초 동기화가 그렇게 보였다).
 * 그래서 요청은 작업을 받았다는 사실(job id)만 돌려주고, 진행·완료·실패는 상태 조회로 말한다.
 */
export type SyncJobStatus = "queued" | "running" | "done" | "failed";
export type SyncJobError = { code: string; message: string };
export type SyncJobRecord = {
  id: string;
  userId: string;
  status: SyncJobStatus;
  createdAt: Date;
  updatedAt: Date;
  result?: SyncResult;
  error?: SyncJobError;
};

export interface SyncJobStore {
  create(userId: string): SyncJobRecord;
  get(id: string): SyncJobRecord | undefined;
  /** 아직 끝나지 않은(queued/running) 같은 사용자의 작업. 중복 실행을 막는 근거. */
  findActiveForUser(userId: string): SyncJobRecord | undefined;
  update(id: string, patch: Partial<Pick<SyncJobRecord, "status" | "result" | "error">>): SyncJobRecord;
}

export interface SyncDispatcher {
  enqueue(jobId: string, userId: string): Promise<void>;
}

const FINISHED: ReadonlySet<SyncJobStatus> = new Set(["done", "failed"]);
/** 끝난 작업을 이만큼 지나면 잊는다. 폴링하던 화면이 이미 결과를 받았을 시간이다. */
const FINISHED_TTL_MS = 60 * 60 * 1_000;
const MAX_RECORDS = 1_000;

/**
 * 프로세스 메모리 저장소. Prisma에 두지 않는 이유: 작업 실행 자체가 이 프로세스 안에서 일어나므로 프로세스가 죽으면
 * 작업도 같이 죽는다. 그때 상태 행만 살아남으면 "running"인 채 영원히 남는 유령이 된다. 재시작 뒤 폴링은 404를 받고
 * 화면은 실패로 처리해 재시도 버튼을 준다 — 그것이 정직한 답이다.
 */
export class InMemorySyncJobStore implements SyncJobStore {
  private readonly jobs = new Map<string, SyncJobRecord>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(userId: string): SyncJobRecord {
    this.prune();
    const at = this.now();
    this.counter += 1;
    const record: SyncJobRecord = { id: `sync-${at.getTime().toString(36)}-${this.counter.toString(36)}`, userId, status: "queued", createdAt: at, updatedAt: at };
    this.jobs.set(record.id, record);
    return record;
  }

  get(id: string): SyncJobRecord | undefined {
    return this.jobs.get(id);
  }

  findActiveForUser(userId: string): SyncJobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.userId === userId && !FINISHED.has(job.status)) return job;
    }
    return undefined;
  }

  update(id: string, patch: Partial<Pick<SyncJobRecord, "status" | "result" | "error">>): SyncJobRecord {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Unknown sync job ${id}`);
    const next: SyncJobRecord = { ...current, ...patch, updatedAt: this.now() };
    this.jobs.set(id, next);
    return next;
  }

  private prune(): void {
    const cutoff = this.now().getTime() - FINISHED_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (FINISHED.has(job.status) && job.updatedAt.getTime() < cutoff) this.jobs.delete(id);
    }
    // 오래된 순으로 잘라 무한히 자라지 않게 한다(Map은 삽입 순서를 지킨다).
    while (this.jobs.size > MAX_RECORDS) {
      const oldest = this.jobs.keys().next().value;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }
}
