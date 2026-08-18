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
  @Process("submit") process(job: Job<{ payloadHash: string; type: AnchorType }>) { return this.anchors.process(job.data.payloadHash, job.data.type); }
}

export const injectAnchorDispatcher = () => Inject(ANCHOR_DISPATCHER);
