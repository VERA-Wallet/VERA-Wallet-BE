export const frontendRuleSets = [
  ["DE", "독일", "EUR", "FIFO", 1, "offset"],
  ["US", "미국", "USD", "FIFO", 2, "offset"],
  ["IN", "인도", "INR", "FIFO", 3, "ignored"],
  ["PT", "포르투갈", "EUR", "FIFO", null, "offset"],
  ["GB", "영국", "GBP", "SECTION_104", null, "offset"],
  ["AU", "호주", "AUD", "FIFO", null, "discount"],
  ["FR", "프랑스", "EUR", "평균 취득가", null, "inclusion"],
  ["IT", "이탈리아", "EUR", "LIFO", null, "offset"],
  ["ES", "스페인", "EUR", "FIFO", null, "offset"],
  ["CA", "캐나다", "CAD", "이동평균법", null, "inclusion"],
  ["JP", "일본", "JPY", "총평균법", null, "offset"],
  ["KR", "대한민국", "KRW", "이동평균법", null, "none"],
] as const;

export const frontendRates: Readonly<Record<string, string>> = { DE: "0.26375", US: "0.24", IN: "0.312", PT: "0.28", GB: "0.2", AU: "0.225", FR: "0.3", IT: "0.26", ES: "0.21", CA: "0.25", JP: "0.2", KR: "0" };
const topics = ["CAPITAL_GAINS", "STAKING", "AIRDROP", "CRYPTO_TO_CRYPTO", "DEFI_LP", "WRAPPING", "LOSS_OFFSET"] as const;

export function listFrontendRuleSets() {
  return frontendRuleSets.map(([code, label, currency, method, demoPriority, aggregateAdjustment]) => ({
    code, label, currency, cost_basis: method, badge_label: label, demoPriority, aggregateAdjustment,
    profileFields: code === "US" ? ["filingStatus", "otherIncome"] : [],
    status: code === "KR" ? "UNDETERMINED" : "PARTIAL",
    topics: topics.map((topic) => ({ topic, status: code === "KR" ? "UNDETERMINED" : "PARTIAL", basis: `${label} v1 데모 룰셋` })),
    method,
  }));
}
