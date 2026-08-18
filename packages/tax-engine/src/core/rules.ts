import type { SupportedCountry } from "./types";
import { getCountryRule } from "./rule-catalog";

export const rules = {
  KR: { version: "KR-2026.1", ...getCountryRule("KR")! },
  DE: { version: "DE-2026.1", ...getCountryRule("DE")! },
  US: { version: "US-2026.1", ...getCountryRule("US")! },
} as const;

export function isSupportedCountry(country: string): country is SupportedCountry {
  return Object.hasOwn(rules, country);
}

export function getRule(country: SupportedCountry) { return rules[country]; }
