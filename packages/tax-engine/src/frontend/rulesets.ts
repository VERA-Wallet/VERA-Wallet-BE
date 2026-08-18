import { countryRuleCatalog, getCountryRule } from "../core/rule-catalog";

export const frontendRuleSets = countryRuleCatalog.map((rule) => [rule.code, rule.label, rule.currency, rule.costBasis, rule.demoPriority, rule.aggregateAdjustment] as const);

export const frontendRates: Readonly<Record<string, string>> = Object.fromEntries(countryRuleCatalog.map((rule) => [rule.code, rule.rate]));
const topics = ["CAPITAL_GAINS", "STAKING", "AIRDROP", "CRYPTO_TO_CRYPTO", "DEFI_LP", "WRAPPING", "LOSS_OFFSET"] as const;

export const getFrontendRuleSet = getCountryRule;

export function listFrontendRuleSets() {
  return countryRuleCatalog.map((rule) => ({
    code: rule.code, label: rule.label, currency: rule.currency, cost_basis: rule.costBasis, badge_label: rule.label, demoPriority: rule.demoPriority, aggregateAdjustment: rule.aggregateAdjustment,
    profileFields: rule.code === "US" ? ["filingStatus", "otherIncome"] : [],
    status: rule.code === "KR" ? "UNDETERMINED" : "PARTIAL",
    topics: topics.map((topic) => ({ topic, status: rule.code === "KR" ? "UNDETERMINED" : "PARTIAL", basis: `${rule.label} v1 데모 룰셋` })),
    method: rule.costBasis,
  }));
}
