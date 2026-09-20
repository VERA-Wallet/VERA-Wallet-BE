import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../auth/auth.types";
import { MockSyncCursorRepository } from "../indexer/sync-cursor.repository.adapters";
import { CachedTransactionRepository, MockTransactionRepository } from "../indexer/transaction.repository.adapters";
import { MockWalletRepository } from "./wallet.repository.adapters";
import { WalletUnbindService } from "./wallet-unbind.service";

const USER: AuthenticatedUser = { sub: "u1", didHash: `0x${"11".repeat(32)}`, countryCode: "KR" } as AuthenticatedUser;
const OTHER: AuthenticatedUser = { sub: "u2", didHash: `0x${"22".repeat(32)}`, countryCode: "KR" } as AuthenticatedUser;
const ADDR = "0x8A361b90E7F153eEdEb91ef2b2c7Fa4Dd68ceeee";

const tx = (hash: string) => ({ txHash: hash, eventType: "transfer_in", chain: "ethereum", source: "alchemy", occurredAt: new Date("2026-01-01T00:00:00Z"), payload: { id: hash } }) as never;

async function harness() {
  const wallets = new MockWalletRepository();
  const inner = new MockTransactionRepository();
  const transactions = new CachedTransactionRepository(inner);
  const cursors = new MockSyncCursorRepository();
  const binding = await wallets.upsert({ userId: USER.sub, walletAddress: ADDR, bindingHash: null, verificationMethod: "watch_only", verifiedAt: null });
  await transactions.save(binding.id, USER.sub, [tx("1:0xaaa"), tx("1:0xbbb")]);
  await cursors.advance(binding.id, 1, 100n, 3);
  await cursors.advance(binding.id, 42161, 200n, 3);
  // 되돌림 자체는 인덱서 스펙(own-wallet-linking.service.spec)이 검증한다. 여기서는 포트가 올바른 인자로 불리는지만 본다.
  const links = { unlinkCounterparty: vi.fn(async () => 1) };
  return { wallets, transactions, cursors, binding, links, service: new WalletUnbindService(wallets, transactions, cursors, links) };
}

describe("WalletUnbindService.unbind", () => {
  it("removes the binding with its ledger rows and sync cursors, and reports what it removed", async () => {
    const h = await harness();
    // 읽기 캐시를 먼저 채운다 — 해제가 캐시를 비우지 않으면 지운 거래가 계속 보인다.
    expect(await h.transactions.listForUser(USER.sub)).toHaveLength(2);

    const result = await h.service.unbind(USER, ADDR.toLowerCase());

    expect(result).toEqual({ walletAddress: ADDR, removedTransactions: 2, rejudgedTransactions: 1 });
    expect(await h.wallets.findByUserAndAddress(USER.sub, ADDR)).toBeNull();
    expect(await h.wallets.findAllByUser(USER.sub)).toEqual([]);
    expect(await h.transactions.listForUser(USER.sub)).toEqual([]);
    expect(await h.cursors.listForBinding(h.binding.id)).toEqual([]);
  });

  it("is scoped to the caller: another user's address is 'not found', and nothing of theirs is touched", async () => {
    const h = await harness();
    await expect(h.service.unbind(OTHER, ADDR)).rejects.toBeInstanceOf(NotFoundException);
    expect(await h.wallets.findByUserAndAddress(USER.sub, ADDR)).not.toBeNull();
    expect(await h.transactions.listForUser(USER.sub)).toHaveLength(2);
  });

  it("asks the indexer to re-judge moves with the removed wallet, after the binding is gone", async () => {
    const h = await harness();
    const result = await h.service.unbind(USER, ADDR);
    expect(h.links.unlinkCounterparty).toHaveBeenCalledWith(USER.sub, ADDR);
    expect(result.rejudgedTransactions).toBe(1);
  });

  it("rejects an address that is not an EVM address with 400", async () => {
    const h = await harness();
    await expect(h.service.unbind(USER, "0xnothex")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("answers 'not found' for an address this account never registered", async () => {
    const h = await harness();
    await expect(h.service.unbind(USER, "0x0000000000000000000000000000000000000001")).rejects.toBeInstanceOf(NotFoundException);
  });
});
