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
    };
    expect(identity).toBeDefined();
    expect(anchor).toBeDefined();
  });
});
