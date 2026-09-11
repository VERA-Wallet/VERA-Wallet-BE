import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FrontendPortfolioController } from "./frontend-portfolio.controller";
import type { HoldingsDto, PortfolioHoldingsService } from "./holdings.service";

const user = { sub: "u1", didHash: "0x", countryCode: "KR" } as never;

describe("FrontendPortfolioController (GET /api/portfolio/holdings)", () => {
  it("wraps the user's holdings in the standard envelope", async () => {
    const dto: HoldingsDto = { walletAddresses: ["0xabc"], holdings: [], skippedChainIds: [], truncatedChainIds: [], unresolvedCount: 0, totalValueUsd: "0", unpricedCount: 0, asOf: "2026-09-11T05:00:00.000Z" };
    const service = { holdings: vi.fn().mockResolvedValue(dto) } as unknown as PortfolioHoldingsService;
    const response = await new FrontendPortfolioController(service).holdingsOf(user);
    expect(service.holdings).toHaveBeenCalledWith("u1");
    expect(response.data).toBe(dto);
    expect(response.meta.provenance).toBeDefined();
  });

  it("lets the unbound-wallet 404 through", async () => {
    const service = { holdings: vi.fn().mockRejectedValue(new NotFoundException("A bound wallet is required before reading holdings.")) } as unknown as PortfolioHoldingsService;
    await expect(new FrontendPortfolioController(service).holdingsOf(user)).rejects.toBeInstanceOf(NotFoundException);
  });
});
