export const generatedAt = () => new Date().toISOString();

export function success<T>(data: T, mock = process.env.MOCK_MODE !== "false") {
  return { data, meta: { provenance: mock ? "mock" as const : "live" as const, generatedAt: generatedAt() } };
}

export const ESTIMATE_DISCLAIMER =
  "본 결과는 지갑 데이터와 현재 룰셋에 기반한 추정치이며 세무 자문 또는 확정 신고 금액이 아닙니다.";
