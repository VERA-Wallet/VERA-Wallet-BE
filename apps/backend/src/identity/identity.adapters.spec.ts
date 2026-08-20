import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { MockIdentityAdapter, OmniOneCxAdapter } from "./identity.adapters";

describe("MockIdentityAdapter", () => {
  it("returns only a stable DID hash, never raw identity claims", async () => {
    const result = await new MockIdentityAdapter().handleCallback("any-token");
    expect(result).toMatchObject({ method: "mock" });
    expect(result.didHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result).not.toHaveProperty("name");
  });
});

const makeConfig = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;
const CX_BASE = "https://cx.example.com/ent/esig";

describe("OmniOneCxAdapter.handleCallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the result token via /trans/token and returns only a hashed identity", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ oacxCode: "OACX_SUCCESS", resultCode: "200", data: { ci: "ci-value", userDid: "did:kr:mobileid:abc", name: "홍길동", ihidnum: "7101010000000" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OmniOneCxAdapter(makeConfig({ OMNIONE_CX_BASE_URL: `${CX_BASE}/` }));

    const result = await adapter.handleCallback("result-token");

    expect(fetchMock).toHaveBeenCalledWith(`${CX_BASE}/oacx/api/v1.0/trans/token`, expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: "result-token" });
    expect(result.method).toBe("omnione_cx");
    expect(result.didHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 개인정보 원문이 어떤 형태로도 새어나가면 안 된다.
    expect(JSON.stringify(result)).not.toContain("홍길동");
    expect(JSON.stringify(result)).not.toContain("7101010000000");
  });

  it("derives the same didHash for the same subject so identity upserts stay stable", async () => {
    const respond = () => ({ ok: true, json: async () => ({ oacxCode: "OACX_SUCCESS", data: { ci: "ci-value" } }) });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond()));
    const adapter = new OmniOneCxAdapter(makeConfig({ OMNIONE_CX_BASE_URL: CX_BASE }));

    const first = await adapter.handleCallback("token-a");
    const second = await adapter.handleCallback("token-b");

    expect(first.didHash).toBe(second.didHash);
  });

  it("rejects with 401 when OmniOne CX does not confirm the token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oacxCode: "OACX_TOKEN_ERROR", resultCode: "310" }) }));
    const adapter = new OmniOneCxAdapter(makeConfig({ OMNIONE_CX_BASE_URL: CX_BASE }));

    await expect(adapter.handleCallback("bad-token")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects with 401 when the parsed token has no ci or userDid", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ oacxCode: "OACX_SUCCESS", data: {} }) }));
    const adapter = new OmniOneCxAdapter(makeConfig({ OMNIONE_CX_BASE_URL: CX_BASE }));

    await expect(adapter.handleCallback("subjectless-token")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("fails closed with 503 when the CX server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const adapter = new OmniOneCxAdapter(makeConfig({ OMNIONE_CX_BASE_URL: CX_BASE }));

    await expect(adapter.handleCallback("any-token")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("fails closed with 503 when OMNIONE_CX_BASE_URL is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OmniOneCxAdapter(makeConfig({}));

    await expect(adapter.handleCallback("any-token")).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
