import { describe, expect, it } from "vitest";
import type { EvidenceAnchor, IdentityProvider } from "./index";

describe("public adapter contracts", () => {
  it("remain structurally implementable", () => {
    const identity: IdentityProvider = {
      requestVerification: async (sessionId) => ({ sessionId, verificationUrl: "mock://verify", expiresAt: new Date() }),
      handleCallback: async () => ({ didHash: "0x01", verifiedAt: new Date(), method: "mock" }),
    };
    const anchor: EvidenceAnchor = {
      anchor: async () => ({ txHash: "0x02", blockNumber: 1n, anchoredAt: new Date() }),
      verify: async () => true,
      // inspect는 체인을 직접 읽는 통로다. 테스트 대역은 "읽지 못함"(null)으로 답한다 — 없다고 지어내지 않는다.
      inspect: async () => null,
    };
    expect(identity).toBeDefined();
    expect(anchor).toBeDefined();
  });
});
