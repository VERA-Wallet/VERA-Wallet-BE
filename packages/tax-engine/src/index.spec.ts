import { describe, expect, it } from "vitest";
import { calculateTaxEvents, getFrontendRuleSet, listFrontendRuleSets, summarize } from "./index";

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

describe("country rule catalog", () => {
  it("uses one catalog while preserving the legacy UK alias", () => {
    expect(getFrontendRuleSet("UK")).toMatchObject({ code: "GB", costBasis: "SECTION_104", rate: "0.2" });
    expect(listFrontendRuleSets().find((rule) => rule.code === "GB")).toMatchObject({ cost_basis: "SECTION_104", currency: "GBP" });
  });
});
