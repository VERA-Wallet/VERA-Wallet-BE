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
