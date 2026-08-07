import { describe, expect, it } from "vitest";
import { MockIdentityAdapter } from "./identity.adapters";

describe("MockIdentityAdapter", () => {
  it("returns only a stable DID hash, never raw identity claims", async () => {
    const result = await new MockIdentityAdapter().handleCallback("any-token");
    expect(result).toMatchObject({ method: "mock" });
    expect(result.didHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty("name");
  });
});
