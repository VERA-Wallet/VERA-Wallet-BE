import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue, Process, Processor } from "@nestjs/bull";
import type { Job, Queue } from "bull";
import type { AnchorType } from "@vera/interfaces";
import { ANCHOR_DISPATCHER } from "./anchor.tokens";
import { AnchorService, type AnchorDispatcher } from "./anchor.service";

@Injectable()
export class ImmediateAnchorDispatcher implements AnchorDispatcher {
  constructor(private readonly anchors: AnchorService) {}
  async enqueue(payloadHash: string, type: AnchorType) { await this.anchors.process(payloadHash, type); }
}

@Injectable()
export class BullAnchorDispatcher implements AnchorDispatcher {
  constructor(@InjectQueue("anchor") private readonly queue: Queue) {}
  async enqueue(payloadHash: string, type: AnchorType) {
    await this.queue.add("submit", { payloadHash, type }, { attempts: 5, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 100, removeOnFail: 100 });
  }
}

@Processor("anchor")
export class AnchorProcessor {
  constructor(private readonly anchors: AnchorService) {}
  /**
   * 작업의 목적은 **부수효과**(체인 쓰기 + 기록 갱신)다. 영수증을 반환하면 Bull이 그 값을 JSON으로
   * 저장하려다 `blockNumber`(bigint)에서 던지고, 성공한 작업이 실패로 기록돼 재시도가 돈다.
   * 결과가 필요한 쪽은 앵커 저장소를 읽는다(`AnchorService.get`).
   */
  @Process("submit") async process(job: Job<{ payloadHash: string; type: AnchorType }>): Promise<void> {
    await this.anchors.process(job.data.payloadHash, job.data.type);
  }
}

export const injectAnchorDispatcher = () => Inject(ANCHOR_DISPATCHER);
