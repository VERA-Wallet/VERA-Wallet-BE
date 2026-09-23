import type { ConfigService } from "@nestjs/config";

/**
 * 신원 검증 공급자(mock / OmniOne CX / Open DID)를 고르는 스위치.
 *
 * MOCK_MODE와 분리해 둔 이유는 persistence-mode.ts와 같다. 실지갑 인덱싱·시세·앵커를 실모드로 검증하고 싶은데
 * 손에 모바일신분증이 없으면, MOCK_MODE=false인 채로는 로그인 첫 단계에서 막혀 뒤쪽을 아무것도 볼 수 없다.
 * IDENTITY_PROVIDER=mock은 그 첫 단계만 mock 신원으로 넘기고 나머지 어댑터는 MOCK_MODE 판정을 그대로 따르게 한다.
 *
 * 값을 주지 않으면 기존 동작 그대로다 — MOCK_MODE=true면 mock, false면 OmniOne CX.
 * 알 수 없는 값도 기존 동작으로 떨어뜨린다. 오타 하나로 실모드가 조용히 mock 신원을 받아들이면 안 되기 때문이다.
 */
export function useMockIdentity(config: ConfigService): boolean {
  return identityProviderName((key) => config.get<string>(key)) === "mock";
}

/**
 * 어느 신원 공급자로 도는지의 이름. /health가 이 값을 내보내 FE가 로그인 화면의 출처 배지를 정확히 그린다 —
 * FE는 자기 CX mock 스위치만 알지, BE가 토큰을 실제로 검증하는지는 여기서만 알 수 있다.
 */
export function identityProviderName(get: (key: string) => string | undefined): "mock" | "omnione_cx" | "opendid" {
  const explicit = get("IDENTITY_PROVIDER");
  if (explicit === "opendid") return "opendid";
  if (explicit === "mock") return "mock";
  if (explicit === "omnione_cx") return "omnione_cx";
  return (get("MOCK_MODE") ?? "true") === "true" ? "mock" : "omnione_cx";
}
