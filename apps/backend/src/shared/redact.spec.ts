import { describe, expect, it } from "vitest";
import { redactError, redactSecrets } from "./redact";

describe("자격증명 마스킹", () => {
  it("URL 쿼리의 토큰을 지운다 — viem이 실패한 요청의 URL을 메시지에 통째로 넣는다", () => {
    const message = 'HTTP request failed.\n\nURL: https://stage-chainapi.omnione.net/?token=eyJhbGciOiJSUzI1NiJ9.abc.def\nStatus: 401';
    const output = redactSecrets(message);
    expect(output).not.toContain("eyJhbGciOiJSUzI1NiJ9");
    expect(output).toContain("token=***");
    // 어떤 요청이 실패했는지는 남아야 디버깅이 된다.
    expect(output).toContain("stage-chainapi.omnione.net");
    expect(output).toContain("Status: 401");
  });

  it("헤더 표기의 키도 지운다", () => {
    expect(redactSecrets("x-api-key: super-secret-value")).toBe("x-api-key=***");
    expect(redactSecrets("authorization: Bearer abc.def.ghi")).toContain("***");
  });

  it("지울 것이 없으면 메시지를 건드리지 않는다", () => {
    const clean = "OmniOne Chain anchor transaction reverted: 0xabc";
    expect(redactSecrets(clean)).toBe(clean);
    const error = new Error(clean);
    expect(redactError(error)).toBe(error);
  });

  it("에러의 스택은 유지하고 메시지만 바꾼다", () => {
    const error = new Error("boom token=secret-value");
    const stack = error.stack;
    const redacted = redactError(error) as Error;
    expect(redacted.message).toBe("boom token=***");
    expect(redacted.stack).toBe(stack);
  });
});
