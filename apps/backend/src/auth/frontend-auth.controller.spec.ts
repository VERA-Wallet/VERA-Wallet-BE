import { UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import type { AuthService } from "./auth.service";
import { FrontendAuthController } from "./frontend-auth.controller";

/**
 * 이 파일이 고정하는 계약은 하나다: FE가 보낸 모바일신분증 토큰이 신원 검증까지 도달한다.
 *
 * 회귀가 조용하기 때문에 테스트가 필요하다 — DTO에서 `cxToken`이 빠지면 whitelist ValidationPipe가
 * 400도 없이 필드를 지워버리고, 컨트롤러는 mock 토큰으로 200을 계속 준다. 응답만 보면 정상이다.
 */
function makeController(overrides: { mockMode?: string; callback?: ReturnType<typeof vi.fn> } = {}) {
  const callback = overrides.callback ?? vi.fn().mockResolvedValue({ accessToken: "jwt-token", expiresIn: "1h", user: { id: "u1", didHash: "0xhash", verifiedAt: new Date(), method: "mock" } });
  const config = { get: vi.fn((_key: string, fallback?: string) => overrides.mockMode ?? fallback) } as unknown as ConfigService;
  const controller = new FrontendAuthController({ callback } as unknown as AuthService, config);
  const response = { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response;
  return { controller, callback, response };
}

describe("FrontendAuthController.present", () => {
  it("forwards the CX standard-auth-window token to identity verification", async () => {
    const { controller, callback, response } = makeController();

    await controller.present({ country: "KR", cxToken: "cx-window-token" }, response);

    expect(callback).toHaveBeenCalledWith("cx-window-token", "KR");
  });

  it("falls back to the mock token only when the auth window is not used in MOCK_MODE", async () => {
    const { controller, callback, response } = makeController({ mockMode: "true" });

    await controller.present({ country: "US" }, response);

    expect(callback).toHaveBeenCalledWith("mock-did-US", "US");
  });

  it("rejects a token-less presentation outside MOCK_MODE instead of minting a session", async () => {
    // Real 모드에서 폴백이 살아 있으면 인증창을 건너뛴 로그인이 된다. 쿠키가 나가지 않는 것까지 확인한다.
    const { controller, callback, response } = makeController({ mockMode: "false" });

    await expect(controller.present({ country: "KR" }, response)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(callback).not.toHaveBeenCalled();
    expect(response.cookie).not.toHaveBeenCalled();
  });

  it("issues the access-token cookie from the verified identity", async () => {
    const { controller, response } = makeController();

    const body = await controller.present({ country: "KR", cxToken: "cx-window-token" }, response);

    expect(response.cookie).toHaveBeenCalledWith("vw_access_token", "jwt-token", expect.anything());
    expect(body.data).toMatchObject({ countryCode: "KR", ruleset: { country: "KR", badge_label: "대한민국" } });
  });
});
