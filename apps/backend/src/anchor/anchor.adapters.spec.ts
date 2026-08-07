import { describe, expect, it } from "vitest";
import { MockAnchorAdapter } from "./anchor.adapters";

describe("MockAnchorAdapter", () => {
  it("records and verifies generated transaction hashes", async () => {
    const adapter = new MockAnchorAdapter();
    const receipt = await adapter.anchor(`0x${"01".repeat(32)}`, "audit");
    expect(await adapter.verify(receipt.txHash)).toBe(true);
    expect(await adapter.verify(`0x${"00".repeat(32)}`)).toBe(false);
  });
});
