import { Injectable, Logger } from "@nestjs/common";
import { InjectQueue, Process, Processor } from "@nestjs/bull";
import type { Job, Queue } from "bull";
import { SyncJobRunner } from "./sync-job.service";
import type { SyncDispatcher } from "./sync-job";

type SyncJobData = { jobId: string; userId: string };

/**
 * Redis 없는 모드(MOCK_MODE)용. 요청을 막지 않도록 다음 틱에서 프로세스 안에서 돌린다.
 * anchor의 ImmediateAnchorDispatcher와 달리 await하지 않는다 — 여기서 기다리면 "받았다"는 응답이 곧 "끝났다"가 돼
 * 비동기 계약이 무의미해진다.
 */
@Injectable()
export class InProcessSyncDispatcher implements SyncDispatcher {
  private readonly logger = new Logger(InProcessSyncDispatcher.name);

  constructor(private readonly runner: SyncJobRunner) {}

  async enqueue(jobId: string, userId: string): Promise<void> {
    setImmediate(() => {
      this.runner.run(jobId, userId).catch((error) => this.logger.error(`Sync job ${jobId} crashed: ${(error as Error).message}`));
    });
  }
}

/**
 * Redis(Bull) 큐. 기본 동시성 1이라 사용자들의 동기화가 한 번에 하나씩 돈다 — Alchemy CU 예산을 여러 사용자가
 * 동시에 태우지 않게 하는 자연스러운 조절이다. 재시도는 하지 않는다: 실패 원인(공급자 장애)이 그대로면
 * 같은 호출을 반복할 뿐이고, 사용자는 화면의 "다시 시도"로 명시적으로 다시 요청한다.
 */
@Injectable()
export class BullSyncDispatcher implements SyncDispatcher {
  constructor(@InjectQueue("sync") private readonly queue: Queue<SyncJobData>) {}

  async enqueue(jobId: string, userId: string): Promise<void> {
    await this.queue.add("run", { jobId, userId }, { jobId, attempts: 1, removeOnComplete: 100, removeOnFail: 100 });
  }
}

@Processor("sync")
export class SyncProcessor {
  constructor(private readonly runner: SyncJobRunner) {}

  @Process("run") process(job: Job<SyncJobData>) {
    return this.runner.run(job.data.jobId, job.data.userId);
  }
}
