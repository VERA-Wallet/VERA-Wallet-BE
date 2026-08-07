import type { SupportedCountry } from "./types";

export const rules = {
  KR: { version: "KR-2026.1", label: "대한민국", currency: "KRW", rate: "0" },
  DE: { version: "DE-2026.1", label: "독일", currency: "EUR", rate: "0.26375" },
  US: { version: "US-2026.1", label: "미국", currency: "USD", rate: "0.24" },
} as const;

export function isSupportedCountry(country: string): country is SupportedCountry {
  return Object.hasOwn(rules, country);
}

export function getRule(country: SupportedCountry) { return rules[country]; }
