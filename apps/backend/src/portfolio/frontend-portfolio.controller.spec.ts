import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { FrontendPortfolioController } from "./frontend-portfolio.controller";
import type { HoldingsDto, PortfolioHoldingsService } from "./holdings.service";

const user = { sub: "u1", didHash: "0x", countryCode: "KR" } as never;

describe("FrontendPortfolioController (GET /api/portfolio/holdings)", () => {
  it("wraps the user's holdings in the standard envelope", async () => {
    const dto: HoldingsDto = { walletAddresses: ["0xabc"], byWallet: [], holdings: [], skippedChainIds: [], truncatedChainIds: [], unresolvedCount: 0, totalValueUsd: "0", unpricedCount: 0, asOf: "2026-09-11T05:00:00.000Z" };
    const service = { holdings: vi.fn().mockResolvedValue(dto) } as unknown as PortfolioHoldingsService;
    const response = await new FrontendPortfolioController(service).holdingsOf(user);
    expect(service.holdings).toHaveBeenCalledWith("u1", undefined);
    expect(response.data).toBe(dto);
    expect(response.meta.provenance).toBeDefined();
  });

  it("lets the unbound-wallet 404 through", async () => {
    const service = { holdings: vi.fn().mockRejectedValue(new NotFoundException("A bound wallet is required before reading holdings.")) } as unknown as PortfolioHoldingsService;
    await expect(new FrontendPortfolioController(service).holdingsOf(user)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("passes a valid ?address through and rejects a malformed one before touching the service", async () => {
    const service = { holdings: vi.fn().mockResolvedValue({}) } as unknown as PortfolioHoldingsService;
    await new FrontendPortfolioController(service).holdingsOf(user, "0xF8D09e078D3552Ba1a5ae9876D3b24AA10B1EFAD");
    expect(service.holdings).toHaveBeenCalledWith("u1", "0xF8D09e078D3552Ba1a5ae9876D3b24AA10B1EFAD");
    await expect(new FrontendPortfolioController(service).holdingsOf(user, "vitalik.eth")).rejects.toBeInstanceOf(BadRequestException);
    expect(service.holdings).toHaveBeenCalledTimes(1);
  });
});
