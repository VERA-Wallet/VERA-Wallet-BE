import type { ConfigService } from "@nestjs/config";
import { describe, expect, it } from "vitest";
import { useMockIdentity } from "./identity-mode";

const configOf = (values: Record<string, string | undefined>) =>
  ({ get: (key: string, fallback?: string) => values[key] ?? fallback }) as unknown as ConfigService;

describe("useMockIdentity", () => {
  it("follows MOCK_MODE when IDENTITY_PROVIDER is not set", () => {
    expect(useMockIdentity(configOf({ MOCK_MODE: "true" }))).toBe(true);
    expect(useMockIdentity(configOf({ MOCK_MODE: "false" }))).toBe(false);
    expect(useMockIdentity(configOf({}))).toBe(true);
  });

  it("lets IDENTITY_PROVIDER=mock override a real-mode MOCK_MODE=false", () => {
    expect(useMockIdentity(configOf({ MOCK_MODE: "false", IDENTITY_PROVIDER: "mock" }))).toBe(true);
  });

  it("lets IDENTITY_PROVIDER=omnione_cx force the real adapter even in MOCK_MODE", () => {
    expect(useMockIdentity(configOf({ MOCK_MODE: "true", IDENTITY_PROVIDER: "omnione_cx" }))).toBe(false);
  });

  it("ignores unknown values instead of silently accepting mock identities in real mode", () => {
    expect(useMockIdentity(configOf({ MOCK_MODE: "false", IDENTITY_PROVIDER: "mokc" }))).toBe(false);
  });
});
import { describe, expect, it } from "vitest";
import { identityProviderName } from "./identity-mode";

describe("identityProviderName — /health가 내보내는 신원 공급자 이름", () => {
  const env = (values: Record<string, string | undefined>) => (key: string) => values[key];
  it("명시값이 우선한다", () => {
    expect(identityProviderName(env({ IDENTITY_PROVIDER: "mock", MOCK_MODE: "false" }))).toBe("mock");
    expect(identityProviderName(env({ IDENTITY_PROVIDER: "omnione_cx", MOCK_MODE: "true" }))).toBe("omnione_cx");
  });
  it("명시가 없으면 MOCK_MODE를 따르고, MOCK_MODE도 없으면 mock이다", () => {
    expect(identityProviderName(env({ MOCK_MODE: "false" }))).toBe("omnione_cx");
    expect(identityProviderName(env({ MOCK_MODE: "true" }))).toBe("mock");
    expect(identityProviderName(env({}))).toBe("mock");
  });
  it("오타는 기존 동작으로 떨어진다 — 실모드가 조용히 mock 신원을 받아들이면 안 된다", () => {
    expect(identityProviderName(env({ IDENTITY_PROVIDER: "omnione", MOCK_MODE: "false" }))).toBe("omnione_cx");
  });
});
