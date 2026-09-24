import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFetchTiming, requestTiming, providerLabel } from "./request-timing";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("request performance boundaries", () => {
  it("classifies providers without keeping credentials, paths or query strings", () => {
    vi.stubEnv("REPORT_VC_ISSUER_URL", "http://localhost:8091/issuer");
    expect(providerLabel("http://localhost:8091/issuer/private?token=secret")).toBe("did_issuer");
    expect(providerLabel("https://test.stage-chainapi.omnione.net/?token=secret")).toBe("omnione_chain");
    expect(providerLabel("https://private.example/account/secret")).toBe("external");
  });
  it("keeps overlapping requests isolated and measures failed upstream calls", async () => {
    vi.stubEnv("PERF_TIMING", "true");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async input => {
      if (String(input).includes("fail")) throw new Error("token must never be logged");
      await new Promise(resolve => setTimeout(resolve, 15));
      return new globalThis.Response("{}", { status: 200 });
    }) as typeof fetch;
    const restore = installFetchTiming();
    const server = createServer((incoming, outgoing) => {
      const req = incoming as Request; const res = outgoing as Response;
      req.route = { path: "/api/example/:id" };
      requestTiming(req, res, () => {
        void (async () => {
          if (req.url?.includes("slow")) { await fetch("https://cx.raonsecure.co.kr/private?token=secret"); try { await fetch("https://private.example/fail"); } catch {} }
          res.end("ok");
        })();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const [slow, fast] = await Promise.all([original(`${url}/slow?token=secret`), original(`${url}/fast`)]);
      expect(slow.headers.get("server-timing")).toContain("cx_headers;dur=");
      expect(slow.headers.get("server-timing")).toContain("external_headers;dur=");
      expect(fast.headers.get("server-timing")).not.toContain("_headers");
      expect(slow.headers.get("x-request-id")).not.toBe(fast.headers.get("x-request-id"));
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|private.example/);
      expect(log.mock.calls.map(([line]) => JSON.parse(line).upstream.length).sort()).toEqual([0, 2]);
    } finally {
      restore(); globalThis.fetch = original;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
