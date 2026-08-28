import { ServiceUnavailableException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FrontendEventCommandController } from "./frontend-events.controller";
import type { IndexerService } from "./indexer.service";
import type { EventReclassificationService } from "./event-reclassification.service";

describe("FrontendEventCommandController.resync (POST /api/events/resync)", () => {
  it("forces a sync and returns the envelope with JSON-safe skipped diagnostics", async () => {
    const result = {
      bindings: 2, fetched: 5, normalized: 5,
      chains: [{ chainId: 1, fetched: 5 }, { chainId: 10, fetched: 0 }],
      skipped: [
        { bindingId: "b1", chainId: 10, code: "chain_incomplete" },
        { bindingId: "b2", code: "binding_unavailable" },
      ],
    };
    const indexer = { sync: vi.fn().mockResolvedValue(result) } as unknown as IndexerService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, indexer);

    const response = await controller.resync({ sub: "u1", didHash: "0x", countryCode: "KR" } as never);

    expect(indexer.sync).toHaveBeenCalledWith("u1");
    expect(response.data).toEqual(result);
    expect(response.meta.provenance).toBeDefined();
    // The skipped diagnostics must survive JSON serialization untouched (no raw Error -> {}).
    expect(JSON.parse(JSON.stringify(response.data.skipped))).toEqual(result.skipped);
  });

  it("propagates a total-outage 503 from sync", async () => {
    const indexer = { sync: vi.fn().mockRejectedValue(new ServiceUnavailableException("outage")) } as unknown as IndexerService;
    const controller = new FrontendEventCommandController({} as EventReclassificationService, indexer);
    await expect(controller.resync({ sub: "u1", didHash: "0x", countryCode: "KR" } as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
