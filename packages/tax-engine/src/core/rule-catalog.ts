export const countryRuleCatalog = [
  { code: "DE", label: "독일", currency: "EUR", costBasis: "FIFO", demoPriority: 1, aggregateAdjustment: "offset", rate: "0.26375" },
  { code: "US", label: "미국", currency: "USD", costBasis: "FIFO", demoPriority: 2, aggregateAdjustment: "offset", rate: "0.24" },
  { code: "IN", label: "인도", currency: "INR", costBasis: "FIFO", demoPriority: 3, aggregateAdjustment: "ignored", rate: "0.312" },
  { code: "PT", label: "포르투갈", currency: "EUR", costBasis: "FIFO", demoPriority: null, aggregateAdjustment: "offset", rate: "0.28" },
  { code: "GB", label: "영국", currency: "GBP", costBasis: "SECTION_104", demoPriority: null, aggregateAdjustment: "offset", rate: "0.2" },
  { code: "AU", label: "호주", currency: "AUD", costBasis: "FIFO", demoPriority: null, aggregateAdjustment: "discount", rate: "0.225" },
  { code: "FR", label: "프랑스", currency: "EUR", costBasis: "평균 취득가", demoPriority: null, aggregateAdjustment: "inclusion", rate: "0.3" },
  { code: "IT", label: "이탈리아", currency: "EUR", costBasis: "LIFO", demoPriority: null, aggregateAdjustment: "offset", rate: "0.26" },
  { code: "ES", label: "스페인", currency: "EUR", costBasis: "FIFO", demoPriority: null, aggregateAdjustment: "offset", rate: "0.21" },
  { code: "CA", label: "캐나다", currency: "CAD", costBasis: "이동평균법", demoPriority: null, aggregateAdjustment: "inclusion", rate: "0.25" },
  { code: "JP", label: "일본", currency: "JPY", costBasis: "총평균법", demoPriority: null, aggregateAdjustment: "offset", rate: "0.2" },
  { code: "KR", label: "대한민국", currency: "KRW", costBasis: "이동평균법", demoPriority: null, aggregateAdjustment: "none", rate: "0" },
] as const;

export type CountryCode = (typeof countryRuleCatalog)[number]["code"];
export type CountryRuleDefinition = (typeof countryRuleCatalog)[number];

const aliases: Readonly<Record<string, CountryCode>> = { UK: "GB" };

export function canonicalCountryCode(country: string): CountryCode | null {
  const canonical = aliases[country] ?? country;
  return countryRuleCatalog.some((rule) => rule.code === canonical) ? canonical as CountryCode : null;
}

export function getCountryRule(country: string): CountryRuleDefinition | null {
  const canonical = canonicalCountryCode(country);
  return canonical ? countryRuleCatalog.find((rule) => rule.code === canonical) ?? null : null;
}
