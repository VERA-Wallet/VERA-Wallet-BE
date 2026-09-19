import { describe, expect, it } from "vitest";
import { ServiceUnavailableException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { MockAnchorAdapter, OmniOneChainAdapter, payloadHashFromInput, rpcAuthHeaders } from "./anchor.adapters";
import { encodeAbiParameters, encodeFunctionData } from "viem";

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

describe("체인 calldata에서 payload 해시 읽기", () => {
  const root = `0x${"ab".repeat(32)}` as const;
  const ABI = [{ type: "function", name: "anchor", stateMutability: "nonpayable", inputs: [{ name: "payloadHash", type: "bytes32" }, { name: "anchorType", type: "string" }], outputs: [] }] as const;

  it("자기 주소 전송(컨트랙트 없음): 맨 앞 bytes32", () => {
    const input = encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [root, "rule_version"]);
    expect(payloadHashFromInput(input)).toBe(root);
  });

  it("컨트랙트 호출(ANCHOR_CONTRACT_ADDRESS 설정): 셀렉터 다음 bytes32 — 맨 앞을 읽으면 셀렉터가 섞인다", () => {
    const input = encodeFunctionData({ abi: ABI, functionName: "anchor", args: [root, "rule_version"] });
    expect(input.slice(0, 10)).not.toBe(`0x${root.slice(2, 10)}`);
    expect(payloadHashFromInput(input)).toBe(root);
  });

  it("너무 짧은 calldata는 해시가 아니다", () => {
    expect(payloadHashFromInput("0x")).toBeNull();
    expect(payloadHashFromInput("0x1234")).toBeNull();
  });
});
