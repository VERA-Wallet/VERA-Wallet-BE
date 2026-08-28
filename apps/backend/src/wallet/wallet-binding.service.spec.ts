import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MockWalletRepository } from "./wallet.repository.adapters";
import { WalletBindingService } from "./wallet-binding.service";
import type { AnchorSubmissionPort } from "../anchor/anchor.port";

const USER: AuthenticatedUser = { sub: "u1", didHash: `0x${"11".repeat(32)}`, countryCode: "KR" } as AuthenticatedUser;
// A valid EIP-55 checksummed address (lowercased input must normalize to this).
const ADDR = "0x8A361b90E7F153eEdEb91ef2b2c7Fa4Dd68ceeee";

const harness = () => {
  const wallets = new MockWalletRepository();
  const anchor = { submit: vi.fn(async () => ({ status: "pending" }) as never) } as unknown as AnchorSubmissionPort;
  return { wallets, anchor, service: new WalletBindingService(wallets, anchor) };
};

describe("WalletBindingService.watch", () => {
  it("creates a watch_only binding (no hash, no verifiedAt) and normalizes the address to checksum", async () => {
    const h = harness();
    const result = await h.service.watch(USER, ADDR.toLowerCase());
    expect(result).toEqual({ walletAddress: ADDR });
    const stored = await h.wallets.findByUserAndAddress("u1", ADDR);
    expect(stored).toMatchObject({ verificationMethod: "watch_only", bindingHash: null, verifiedAt: null });
    expect(h.anchor.submit).not.toHaveBeenCalled(); // watch-only never anchors
  });

  it("rejects an invalid address with 400", async () => {
    const h = harness();
    await expect(h.service.watch(USER, "0xnothex")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("is idempotent for an existing binding of the same address", async () => {
    const h = harness();
    await h.service.watch(USER, ADDR);
    await h.service.watch(USER, ADDR);
    expect((await h.wallets.findAllByUser("u1"))).toHaveLength(1);
  });

  it("never downgrades an already-verified siwe binding to watch_only", async () => {
    const h = harness();
    await h.wallets.upsert({ userId: "u1", walletAddress: ADDR, bindingHash: "0xhash", verificationMethod: "siwe", verifiedAt: new Date() });
    await h.service.watch(USER, ADDR);
    const stored = await h.wallets.findByUserAndAddress("u1", ADDR);
    expect(stored?.verificationMethod).toBe("siwe");
    expect(stored?.bindingHash).toBe("0xhash");
  });
});

describe("WalletBindingService.bind", () => {
  it("marks a signature binding verified (siwe + verifiedAt) and submits a binding anchor", async () => {
    const h = harness();
    await h.service.bind(USER, ADDR.toLowerCase(), "nonce-1", `0x${"ab".repeat(32)}`);
    const stored = await h.wallets.findByUserAndAddress("u1", ADDR);
    expect(stored).toMatchObject({ verificationMethod: "siwe" });
    expect(stored?.verifiedAt).toBeInstanceOf(Date);
    expect(stored?.bindingHash).not.toBeNull();
    expect(h.anchor.submit).toHaveBeenCalledWith(expect.any(String), "binding");
  });

  it("promotes an existing watch_only binding to siwe", async () => {
    const h = harness();
    await h.service.watch(USER, ADDR);
    await h.service.bind(USER, ADDR, "nonce-2", `0x${"cd".repeat(32)}`);
    const stored = await h.wallets.findByUserAndAddress("u1", ADDR);
    expect(stored?.verificationMethod).toBe("siwe");
    expect(stored?.verifiedAt).toBeInstanceOf(Date);
    expect((await h.wallets.findAllByUser("u1"))).toHaveLength(1); // promotion, not a new row
  });
});
