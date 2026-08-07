import { Controller, Get, NotFoundException, Param } from "@nestjs/common";
import { AnchorService } from "./anchor.service";

@Controller("anchors")
export class AnchorController {
  constructor(private readonly anchors: AnchorService) {}
  @Get(":payloadHash") async get(@Param("payloadHash") payloadHash: string) {
    const record = await this.anchors.get(payloadHash);
    if (!record) throw new NotFoundException("Anchor record not found.");
    return { ...record, blockNumber: record.blockNumber?.toString() ?? null };
  }
}
