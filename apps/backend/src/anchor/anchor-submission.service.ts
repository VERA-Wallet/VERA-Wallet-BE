import { Inject, Injectable } from "@nestjs/common";
import type { AnchorType } from "@vera/interfaces";
import { ANCHOR_DISPATCHER } from "../shared/tokens";
import { AnchorService, type AnchorDispatcher } from "./anchor.service";

@Injectable()
export class AnchorSubmissionService {
  constructor(private readonly anchors: AnchorService, @Inject(ANCHOR_DISPATCHER) private readonly dispatcher: AnchorDispatcher) {}
  async submit(payloadHash: string, type: AnchorType) {
    await this.anchors.prepare(payloadHash, type);
    await this.dispatcher.enqueue(payloadHash, type);
    return this.anchors.get(payloadHash);
  }
}
