import type { ConfigService } from "@nestjs/config";

/**
 * 저장소 구현(인메모리 / Prisma)을 고르는 스위치.
 *
 * MOCK_MODE와 분리해 둔 이유: MOCK_MODE는 저장소뿐 아니라 외부 공급자 어댑터(OmniOne CX·OmniOne Chain·
 * Alchemy)까지 함께 바꾼다. 그런데 그 실어댑터들은 공급자 최종 명세를 기다리는 뼈대라 호출되면 503을 던진다.
 * 그래서 "DB에 실제로 쌓고 싶다"는 이유로 MOCK_MODE=false를 주면 DID 인증부터 막혀 흐름 전체가 죽는다.
 *
 * 명세가 나오기 전까지는 "공급자는 mock, 저장은 Postgres"라는 조합이 필요하고, 이 함수가 그 조합을 연다.
 * PERSISTENCE를 주지 않으면 기존 동작 그대로다 — MOCK_MODE=true면 인메모리, false면 Prisma.
 */
export function usePrismaPersistence(config: ConfigService): boolean {
  const explicit = config.get<string>("PERSISTENCE");
  if (explicit) return explicit === "prisma";
  return config.get<string>("MOCK_MODE", "true") !== "true";
}
