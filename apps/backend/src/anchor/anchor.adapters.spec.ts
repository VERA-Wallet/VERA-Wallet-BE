import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { MockAnchorAdapter, OmniOneChainAdapter, rpcAuthHeaders } from "./anchor.adapters";

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

describe("OmniOne RPC 인증 헤더", () => {
  it("키가 있으면 Authorization: Bearer로 보낸다 — 이 노드는 x-api-key를 받지 않는다(401)", () => {
    expect(rpcAuthHeaders("tok-123")).toEqual({ Authorization: "Bearer tok-123" });
    expect(rpcAuthHeaders("tok-123")).not.toHaveProperty("x-api-key");
  });

  it("키가 없거나 공백뿐이면 헤더를 달지 않는다 — URL에 토큰을 둔 기존 설정이 그대로 동작해야 한다", () => {
    expect(rpcAuthHeaders(undefined)).toEqual({});
    expect(rpcAuthHeaders("   ")).toEqual({});
  });
});

