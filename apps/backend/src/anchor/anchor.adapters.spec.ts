import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { MockAnchorAdapter, OmniOneChainAdapter } from "./anchor.adapters";

describe("MockAnchorAdapter", () => {
  it("records and verifies generated transaction hashes", async () => {
    const adapter = new MockAnchorAdapter();
    const receipt = await adapter.anchor(`0x${"01".repeat(32)}`, "audit");
    expect(await adapter.verify(receipt.txHash)).toBe(true);
    expect(await adapter.verify(`0x${"00".repeat(32)}`)).toBe(false);
  });
});

describe("OmniOneChainAdapter", () => {
  it("returns 503 when ANCHOR_PRIVATE_KEY is not configured", async () => {
    const config = { get: (_key: string, fallback?: string) => fallback } as unknown as ConfigService;
    const adapter = new OmniOneChainAdapter(config);
    await expect(adapter.anchor(`0x${"01".repeat(32)}`, "binding")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
