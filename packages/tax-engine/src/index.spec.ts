import { describe, expect, it } from "vitest";
import { calculateTaxEvents, summarize } from "./index";

describe("calculateTaxEvents", () => {
  it("keeps decimal arithmetic exact and marks every number as an estimate", () => {
    const events = calculateTaxEvents([
      { id: "a", eventType: "transfer_out", occurredAt: new Date(), payload: { gainLoss: "0.1" } },
      { id: "b", eventType: "transfer_out", occurredAt: new Date(), payload: { gainLoss: "0.2" } },
    ], "US");
    expect(summarize(events)).toMatchObject({ totalGain: "0.3", estimatedTax: "0.072", isEstimate: true });
    expect(events.every((event) => event.isEstimate)).toBe(true);
  });
});
