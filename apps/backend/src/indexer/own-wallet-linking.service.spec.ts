import { describe, expect, it } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import type { BindingRecord, TransactionRecord } from "../shared/repository.types";
import { MockWalletRepository } from "../wallet/wallet.repository.adapters";
import { OwnWalletLinkingService } from "./own-wallet-linking.service";
import { MockTransactionRepository } from "./transaction.repository.adapters";
import type { TransactionRepository } from "./transaction.repository";

const USER = "u1";
// Two wallets the user has bound, plus one they have not.
const WALLET_A = "0x8a361b90e7f153eedeb91ef2b2c7fa4dd68ceeee";
const WALLET_B = "0xf8d09e078d3552ba1a5ae9876d3b24aa10b1efad";
const STRANGER = "0x000000000000000000000000000000000000dead";

const TX = "0x2c9fc74e00000000000000000000000000000000000000000000000000000000";
const ETH_RAW = "1784970000000000"; // 0.00178497 ETH at 18 decimals

type LegSpec = {
  /** payload.id. Real data can repeat it across the two rows - see the dedicated test. */
  id: string;
  wallet: string;
  counterparty: string;
  dir: "IN" | "OUT";
  chain?: number;
  txHash?: string;
  raw?: string;
  logIndex?: number;
  assetType?: "NATIVE" | "ERC20";
  contract?: string | null;
  cls?: string;
  groupId?: string | null;
  bridgeGroupId?: string | null;
  destChainId?: number | null;
  confidence?: number;
  userOverride?: unknown;
};

function leg(o: LegSpec): IndexedTransaction {
  const assetType = o.assetType ?? "NATIVE";
  const txHash = o.txHash ?? TX;
  return {
    source: "alchemy",
    txHash: `${o.chain ?? 1}:${txHash}:${o.id}`, // storage key is (bindingId, txHash, eventType)
    chain: String(o.chain ?? 1),
    eventType: o.dir === "IN" ? "transfer_in" : "transfer_out",
    occurredAt: new Date("2025-11-28T00:00:00Z"),
    payload: {
      id: o.id,
      tx_hash: txHash,
      chain_id: o.chain ?? 1,
      log_index: o.logIndex ?? 7,
      wallet_address: o.wallet,
      counterparty: o.counterparty,
      direction: o.dir,
      asset_type: assetType,
      asset_contract: o.contract ?? null,
      token_id: null,
      symbol: assetType === "NATIVE" ? "ETH" : "USDC",
      raw_amount: o.raw ?? ETH_RAW,
      decimals: assetType === "NATIVE" ? 18 : 6,
      classification: o.cls ?? (o.dir === "OUT" ? "SEND" : "RECEIVE"),
      confidence: o.confidence ?? 0.9,
      user_override: o.userOverride ?? null,
      group_id: o.groupId ?? null,
      ...(o.bridgeGroupId !== undefined ? { bridge_group_id: o.bridgeGroupId } : {}),
      ...(o.destChainId !== undefined ? { bridge_dest_chain_id: o.destChainId } : {}),
      _version: 1,
      _overrideHistory: [],
    },
  };
}

const bind = (wallets: MockWalletRepository, walletAddress: string): Promise<BindingRecord> =>
  wallets.upsert({ userId: USER, walletAddress, bindingHash: null, verificationMethod: "siwe", verifiedAt: new Date() });

/** Seed one binding per leg group so the two sides of a move live on DIFFERENT bindings, as in production. */
async function seed(groups: { wallet: string; legs: IndexedTransaction[] }[], bound: string[] = [WALLET_A, WALLET_B]) {
  const wallets = new MockWalletRepository();
  const repo = new MockTransactionRepository();
  for (const address of bound) await bind(wallets, address);
  for (const group of groups) {
    const binding = await wallets.findByUserAndAddress(USER, group.wallet);
    await repo.save(binding?.id ?? `unbound:${group.wallet}`, USER, group.legs);
  }
  const service = new OwnWalletLinkingService(repo, wallets);
  return { repo, wallets, service };
}

const rows = (repo: MockTransactionRepository) => repo.listForUser(USER);
const byDirection = async (repo: MockTransactionRepository, dir: "IN" | "OUT"): Promise<TransactionRecord> =>
  (await rows(repo)).find((row) => row.payload.direction === dir)!;

// The observed case: one tx, 0.00178497 ETH from wallet A to wallet B, both bound to the same user.
const ownPair = (ids: [string, string] = ["out", "in"]) => [
  { wallet: WALLET_A, legs: [leg({ id: ids[0], wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT" as const })] },
  { wallet: WALLET_B, legs: [leg({ id: ids[1], wallet: WALLET_B, counterparty: WALLET_A, dir: "IN" as const })] },
];

describe("OwnWalletLinkingService.linkForUser", () => {
  it("links a same-tx own-wallet pair: both INTERNAL_TRANSFER, one own: key, no dest chain", async () => {
    const { repo, service } = await seed(ownPair());
    expect(await service.linkForUser(USER)).toBe(2);

    const out = await byDirection(repo, "OUT");
    const inLeg = await byDirection(repo, "IN");
    expect(out.payload.classification).toBe("INTERNAL_TRANSFER");
    expect(inLeg.payload.classification).toBe("INTERNAL_TRANSFER");
    expect(out.payload.confidence).toBe(0.9);
    expect(inLeg.payload.confidence).toBe(0.9);
    expect(out.payload.bridge_group_id).toBe(`own:1:${TX}:7`);
    expect(inLeg.payload.bridge_group_id).toBe(out.payload.bridge_group_id);
    // Same-chain move: a null dest chain is what makes the FE label the merged row "이동", not "브릿지".
    expect(out.payload.bridge_dest_chain_id).toBeNull();
    expect(inLeg.payload.bridge_dest_chain_id).toBeNull();
  });

  it("pairs both rows even when they share one payload.id (the provider uniqueId is per transfer)", async () => {
    // Alchemy returns the SAME uniqueId to both wallets that saw the transfer, so payload.id collides
    // across the two bindings. Writes must address the storage row, not payload.id.
    const { repo, service } = await seed(ownPair(["1:0xdup:external", "1:0xdup:external"]));
    expect(await service.linkForUser(USER)).toBe(2);
    const all = await rows(repo);
    expect(all).toHaveLength(2);
    expect(all.every((row) => row.payload.classification === "INTERNAL_TRANSFER")).toBe(true);
    expect(new Set(all.map((row) => row.payload.bridge_group_id)).size).toBe(1);
  });

  it("leaves a transfer to a NON-bound address completely untouched", async () => {
    const { repo, service } = await seed([
      { wallet: WALLET_A, legs: [leg({ id: "out", wallet: WALLET_A, counterparty: STRANGER, dir: "OUT" })] },
    ]);
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byDirection(repo, "OUT")).payload.classification).toBe("SEND");
  });

  it("classifies a one-sided move (counterparty bound, its row not indexed) WITHOUT a group key", async () => {
    const { repo, service } = await seed([
      { wallet: WALLET_A, legs: [leg({ id: "out", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT" })] },
    ]);
    expect(await service.linkForUser(USER)).toBe(1);
    const out = await byDirection(repo, "OUT");
    // The counterparty being a bound wallet is proof enough that this is a self-move...
    expect(out.payload.classification).toBe("INTERNAL_TRANSFER");
    // ...but there is no second leg, so there is nothing to key. The tax engine reads a null group as
    // "internal_transfer_unlinked" and keeps the cost where it is.
    expect(out.payload.bridge_group_id).toBeNull();
  });

  it("never touches a leg the user manually overrode, and ignores swap-grouped legs", async () => {
    const overridden = await seed([
      {
        wallet: WALLET_A,
        legs: [
          leg({
            id: "out",
            wallet: WALLET_A,
            counterparty: WALLET_B,
            dir: "OUT",
            userOverride: { classification: "SEND", reason: null, overridden_at: "2025-12-01T00:00:00Z" },
          }),
        ],
      },
      { wallet: WALLET_B, legs: [leg({ id: "in", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN" })] },
    ]);
    expect(await overridden.service.linkForUser(USER)).toBe(1); // only the IN leg, one-sided
    expect((await byDirection(overridden.repo, "OUT")).payload.classification).toBe("SEND");
    expect((await byDirection(overridden.repo, "IN")).payload.bridge_group_id).toBeNull();

    const swap = await seed([
      { wallet: WALLET_A, legs: [leg({ id: "out", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", groupId: "1:0xswap" })] },
      { wallet: WALLET_B, legs: [leg({ id: "in", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN", groupId: "1:0xswap" })] },
    ]);
    expect(await swap.service.linkForUser(USER)).toBe(0);
    expect((await byDirection(swap.repo, "OUT")).payload.classification).toBe("SEND");
  });

  it("is idempotent: a second run writes nothing and keeps the same deterministic key", async () => {
    const { repo, service } = await seed(ownPair());
    expect(await service.linkForUser(USER)).toBe(2);
    const key = (await byDirection(repo, "OUT")).payload.bridge_group_id;
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byDirection(repo, "OUT")).payload.bridge_group_id).toBe(key);
  });

  it("clears a stale bridge link: an own move never keeps a bridge: key or a dest chain", async () => {
    const { repo, service } = await seed([
      {
        wallet: WALLET_A,
        legs: [
          leg({
            id: "out",
            wallet: WALLET_A,
            counterparty: WALLET_B,
            dir: "OUT",
            cls: "INTERNAL_TRANSFER",
            bridgeGroupId: "bridge:1:0xwrong",
            destChainId: 10,
          }),
        ],
      },
      { wallet: WALLET_B, legs: [leg({ id: "in", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN" })] },
    ]);
    expect(await service.linkForUser(USER)).toBe(2);
    const out = await byDirection(repo, "OUT");
    expect(out.payload.bridge_group_id).toBe(`own:1:${TX}:7`);
    expect(out.payload.bridge_dest_chain_id).toBeNull();
  });

  it("does NOT pair an ambiguous bucket, but still classifies every leg in it", async () => {
    // Two identical transfers A->B reported at the same slot: which IN pairs with which OUT is a
    // guess, so all three legs are classified with no key rather than keyed on a coin flip.
    const { repo, service } = await seed([
      {
        wallet: WALLET_A,
        legs: [
          leg({ id: "outA", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT" }),
          leg({ id: "outB", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT" }),
        ],
      },
      { wallet: WALLET_B, legs: [leg({ id: "in", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN" })] },
    ]);
    expect(await service.linkForUser(USER)).toBe(3);
    for (const row of await rows(repo)) {
      expect(row.payload.classification).toBe("INTERNAL_TRANSFER");
      expect(row.payload.bridge_group_id).toBeNull();
    }
  });

  it("keeps two assets moved in ONE tx in separate pairs (the slot pins the transfer)", async () => {
    const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const { repo, service } = await seed([
      {
        wallet: WALLET_A,
        legs: [
          leg({ id: "outEth", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", logIndex: 3 }),
          leg({ id: "outUsdc", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", logIndex: 4, assetType: "ERC20", contract: USDC_ETH, raw: "1000000" }),
        ],
      },
      {
        wallet: WALLET_B,
        legs: [
          leg({ id: "inEth", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN", logIndex: 3 }),
          leg({ id: "inUsdc", wallet: WALLET_B, counterparty: WALLET_A, dir: "IN", logIndex: 4, assetType: "ERC20", contract: USDC_ETH, raw: "1000000" }),
        ],
      },
    ]);
    expect(await service.linkForUser(USER)).toBe(4);
    const keys = new Map((await rows(repo)).map((row) => [String(row.payload.id), row.payload.bridge_group_id]));
    expect(keys.get("outEth")).toBe(`own:1:${TX}:3`);
    expect(keys.get("inEth")).toBe(`own:1:${TX}:3`);
    expect(keys.get("outUsdc")).toBe(`own:1:${TX}:4`);
    expect(keys.get("inUsdc")).toBe(`own:1:${TX}:4`);
  });

  it("does nothing when the user has a single binding (no own-wallet counterparty can exist)", async () => {
    const { repo, service } = await seed(
      [{ wallet: WALLET_A, legs: [leg({ id: "out", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT" })] }],
      [WALLET_A],
    );
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byDirection(repo, "OUT")).payload.classification).toBe("SEND");
  });

  it("isolates a per-leg write failure and repairs the orphan on the next run", async () => {
    const wallets = new MockWalletRepository();
    const base = new MockTransactionRepository();
    for (const address of [WALLET_A, WALLET_B]) await bind(wallets, address);
    for (const group of ownPair()) {
      const binding = await wallets.findByUserAndAddress(USER, group.wallet);
      await base.save(binding!.id, USER, group.legs);
    }
    let failIn = true;
    const flaky: TransactionRepository = {
      listForUser: (u) => base.listForUser(u),
      findForUser: (u, id) => base.findForUser(u, id),
      updatePayload: async (u, id, payload) => {
        const target = await base.findForUser(u, id);
        if (target?.payload.direction === "IN" && failIn) {
          failIn = false;
          throw new Error("simulated write failure");
        }
        return base.updatePayload(u, id, payload);
      },
    };
    const service = new OwnWalletLinkingService(flaky, wallets);

    expect(await service.linkForUser(USER)).toBe(1); // OUT written, IN threw
    expect((await byDirection(base, "OUT")).payload.classification).toBe("INTERNAL_TRANSFER");
    expect((await byDirection(base, "IN")).payload.classification).toBe("RECEIVE"); // orphaned

    expect(await service.linkForUser(USER)).toBe(1); // OUT already correct (skip), IN repaired
    expect((await byDirection(base, "IN")).payload.classification).toBe("INTERNAL_TRANSFER");
    expect((await byDirection(base, "IN")).payload.bridge_group_id).toBe(`own:1:${TX}:7`);
  });
});

describe("OwnWalletLinkingService.unlinkCounterparty", () => {
  // 지갑 B를 등록 해제한 뒤: A에 남은 "B와의 이동" 판정은 증명(바인딩)을 잃었으니 일반 전송으로 돌아가야 한다.
  const afterRemovingB = () => seed([
    { wallet: WALLET_A, legs: [
      // 양쪽이 있었던 이동(짝 키 own:) — B의 행은 바인딩과 함께 이미 지워졌다.
      leg({ id: "out", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", cls: "INTERNAL_TRANSFER", bridgeGroupId: `own:1:${TX}:7`, destChainId: null }),
      // 한쪽만 있었던 이동(짝 키 없음).
      leg({ id: "in-onesided", wallet: WALLET_A, counterparty: WALLET_B, dir: "IN", cls: "INTERNAL_TRANSFER", bridgeGroupId: null, logIndex: 8 }),
      // 사용자가 직접 고친 행은 그대로.
      leg({ id: "edited", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", cls: "INTERNAL_TRANSFER", bridgeGroupId: `own:1:${TX}:9`, logIndex: 9, userOverride: { classification: "INTERNAL_TRANSFER" } }),
      // 제3자와의 거래는 무관.
      leg({ id: "third", wallet: WALLET_A, counterparty: STRANGER, dir: "OUT", cls: "INTERNAL_TRANSFER", bridgeGroupId: `own:1:${TX}:10`, logIndex: 10 }),
      // 브릿지 패스가 쓴 짝 키는 다른 증명이다 — 건드리지 않는다.
      leg({ id: "bridge", wallet: WALLET_A, counterparty: WALLET_B, dir: "OUT", cls: "INTERNAL_TRANSFER", bridgeGroupId: "bridge:1:x", destChainId: 42161, logIndex: 11 }),
    ] },
  ], [WALLET_A]);

  it("re-judges the remaining wallet's moves with the removed wallet as plain transfers, leaving edits, third parties and bridges alone", async () => {
    const { repo, service } = await afterRemovingB();

    expect(await service.unlinkCounterparty(USER, WALLET_B.toUpperCase().replace("0X", "0x"))).toBe(2);

    const byId = Object.fromEntries((await rows(repo)).map((row) => [String(row.payload.id), row.payload]));
    expect(byId.out).toMatchObject({ classification: "SEND", bridge_group_id: null, bridge_dest_chain_id: null, confidence: 0.9 });
    expect(byId["in-onesided"]).toMatchObject({ classification: "RECEIVE", bridge_group_id: null });
    expect(byId.edited).toMatchObject({ classification: "INTERNAL_TRANSFER", bridge_group_id: `own:1:${TX}:9` });
    expect(byId.third).toMatchObject({ classification: "INTERNAL_TRANSFER", bridge_group_id: `own:1:${TX}:10` });
    expect(byId.bridge).toMatchObject({ classification: "INTERNAL_TRANSFER", bridge_group_id: "bridge:1:x", bridge_dest_chain_id: 42161 });
  });

  it("is idempotent: a second pass finds nothing left to revert", async () => {
    const { service } = await afterRemovingB();
    await service.unlinkCounterparty(USER, WALLET_B);
    expect(await service.unlinkCounterparty(USER, WALLET_B)).toBe(0);
  });
});
