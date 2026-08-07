export type SupportedCountry = "KR" | "DE" | "US";

export type TaxableTransaction = {
  id: string;
  eventType: string;
  occurredAt: Date | string;
  payload: Record<string, unknown>;
};

export type CalculatedTaxEvent = {
  transactionId: string;
  countryCode: SupportedCountry;
  ruleVersion: string;
  gainLoss: string;
  isEstimate: true;
};
