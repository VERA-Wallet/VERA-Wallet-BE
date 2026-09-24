import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

type Span = { provider: string; durationMs: number; status: number };
const context = new AsyncLocalStorage<{ spans: Span[] }>();
const ms = (start: number) => Math.round((performance.now() - start) * 10) / 10;

export function providerLabel(input: string | URL | RequestInfo): string {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    for (const [key, label] of [["REPORT_VC_ISSUER_URL", "did_issuer"], ["OPENDID_VERIFIER_URL", "did_verifier"], ["OMNIONE_CX_BASE_URL", "cx"]]) {
      const value = process.env[key];
      if (value && new URL(value).origin === url.origin) return label;
    }
    if (url.hostname.endsWith(".raonsecure.co.kr")) return "cx";
    if (url.hostname.endsWith(".omnione.net")) return "omnione_chain";
  } catch { /* Diagnostics must not interfere with requests. */ }
  return "external";
}

/** Measures fetch through response headers; body consumption remains in backend duration. */
export function installFetchTiming() {
  const original = globalThis.fetch;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const state = context.getStore();
    if (!state) return original(...args);
    const start = performance.now(); let status = 0;
    try { const response = await original(...args); status = response.status; return response; }
    finally { if (state.spans.length < 100) state.spans.push({ provider: providerLabel(args[0]), durationMs: ms(start), status }); }
  };
  return () => { globalThis.fetch = original; };
}

export function requestTiming(req: Request, res: Response, next: NextFunction) {
  const start = performance.now(); const requestId = randomUUID(); const state = { spans: [] as Span[] };
  res.setHeader("X-Request-Id", requestId);
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: Parameters<typeof res.writeHead>) {
    const grouped = new Map<string, number>();
    for (const span of state.spans) grouped.set(span.provider, (grouped.get(span.provider) ?? 0) + span.durationMs);
    res.setHeader("Server-Timing", [`backend;dur=${ms(start)}`, ...Array.from(grouped, ([name, duration]) => `${name}_headers;dur=${duration.toFixed(1)}`)].join(", "));
    return writeHead.apply(this, args);
  } as typeof res.writeHead;
  res.once("finish", () => {
    const durationMs = ms(start);
    if (durationMs >= 1000 || process.env.PERF_TIMING === "true") {
      // Registered route templates only: never URL queries, account IDs, tokens or bodies.
      console.info(JSON.stringify({ event: "request_timing", requestId, method: req.method,
        route: typeof req.route?.path === "string" ? req.route.path : "unmatched", status: res.statusCode, durationMs, upstream: state.spans }));
    }
  });
  context.run(state, next);
}

export async function measureOperation<T>(name: "sync.total" | "sync.scan" | "sync.persist", work: () => Promise<T>): Promise<T> {
  const start = performance.now(); let outcome = "ok";
  try { return await work(); } catch (error) { outcome = "error"; throw error; }
  finally {
    const durationMs = ms(start);
    if (durationMs >= 1000 || process.env.PERF_TIMING === "true") console.info(JSON.stringify({ event: "operation_timing", name, durationMs, outcome }));
  }
}
