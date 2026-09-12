import { describe, expect, it, vi } from "vitest";
import type { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import { FrontendSessionController } from "./frontend-session.controller";
import type { UserRepository } from "../identity/identity.repository";
import type { WalletRepository } from "./wallet.repository";

const request = (token?: string) => ({ cookies: token ? { vw_access_token: token } : {} }) as unknown as Request;
const payload = { sub: "u1", didHash: "0x", countryCode: "KR" };
const binding = { id: "b1", userId: "u1", walletAddress: "0xabc", bindingHash: null, verificationMethod: "watch_only", verifiedAt: null, boundAt: new Date(), initialSyncedAt: null };

function make(opts: { verify?: unknown; userExists: boolean; binding?: typeof binding | null }) {
  const jwt = { verifyAsync: vi.fn(async () => { if (opts.verify instanceof Error) throw opts.verify; return opts.verify ?? payload; }) } as unknown as JwtService;
  const users = { getUser: vi.fn(async () => (opts.userExists ? { id: "u1", didHash: "0x", createdAt: new Date() } : null)) } as unknown as UserRepository;
  const wallets = { findLatestByUser: vi.fn(async () => opts.binding ?? null) } as unknown as WalletRepository;
  return new FrontendSessionController(wallets, users, jwt);
}

describe("GET /api/auth/session", () => {
  it("returns the latest binding for a valid token whose user exists", async () => {
    const response = await make({ userExists: true, binding }).session(request("t"));
    expect(response.data).toEqual({ didVerified: true, countryCode: "KR", walletAddress: "0xabc", walletVerification: "watch_only" });
  });

  it("is anonymous without a cookie or with a bad signature", async () => {
    expect((await make({ userExists: true }).session(request())).data.didVerified).toBe(false);
    expect((await make({ verify: new Error("bad"), userExists: true }).session(request("t"))).data.didVerified).toBe(false);
  });

  it("is anonymous — not 'verified with no wallet' — when the token's user no longer exists (same verdict as JwtAuthGuard)", async () => {
    const response = await make({ userExists: false, binding }).session(request("t"));
    expect(response.data).toEqual({ didVerified: false, countryCode: null, walletAddress: null, walletVerification: null });
  });
});
