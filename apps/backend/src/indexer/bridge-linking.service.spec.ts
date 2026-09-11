import { describe, expect, it } from "vitest";
import type { IndexedTransaction } from "@vera/interfaces";
import type { TransactionRecord } from "../shared/repository.types";
import { BridgeLinkingService } from "./bridge-linking.service";
import { MockTransactionRepository } from "./transaction.repository.adapters";
import type { TransactionRepository } from "./transaction.repository";

// Canonical contracts the linker recognizes (native has none).
const USDT_POLYGON = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
const USDT_ETH = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH_OP = "0x4200000000000000000000000000000000000006";

type LegSpec = {
  id: string;
  chain: number;
  dir: "IN" | "OUT";
  symbol: string;
  raw: string;
  ts: string;
  assetType?: "NATIVE" | "ERC20";
  contract?: string | null;
  decimals?: number;
  cls?: string;
  bridgeSuspected?: boolean;
  groupId?: string | null;
  userOverride?: unknown;
};

function leg(o: LegSpec): IndexedTransaction {
  const assetType = o.assetType ?? "NATIVE";
  return {
    source: "alchemy",
    txHash: `0x${o.id}`,
    chain: String(o.chain),
    eventType: o.dir === "IN" ? "transfer_in" : "transfer_out",
    occurredAt: new Date(o.ts),
    payload: {
      id: o.id,
      tx_hash: `0x${o.id}`,
      chain_id: o.chain,
      direction: o.dir,
      asset_type: assetType,
      asset_contract: o.contract ?? (assetType === "NATIVE" ? null : `0x${o.id.padEnd(40, "0")}`),
      symbol: o.symbol,
      raw_amount: o.raw,
      decimals: o.decimals ?? (assetType === "NATIVE" ? 18 : 6),
      classification: o.cls ?? (o.dir === "OUT" ? "SEND" : "RECEIVE"),
      confidence: o.bridgeSuspected ? 0.4 : 0.9,
      user_override: o.userOverride ?? null,
      _version: 1,
      _overrideHistory: [],
      ...(o.bridgeSuspected ? { bridge_suspected: true } : {}),
      ...(o.groupId !== undefined ? { group_id: o.groupId } : {}),
    },
  };
}

const USER = "u1";
const BINDING = "b1";

async function seed(...legs: IndexedTransaction[]) {
  const repo = new MockTransactionRepository();
  await repo.save(BINDING, USER, legs);
  const service = new BridgeLinkingService(repo);
  return { repo, service };
}

const byId = async (repo: MockTransactionRepository, id: string) =>
  (await repo.listForUser(USER)).find((r) => r.payload.id === id)!;

// native ETH helpers
const ethOut = (id: string, chain: number, raw: string, ts: string) =>
  leg({ id, chain, dir: "OUT", symbol: "ETH", raw, ts, assetType: "NATIVE", bridgeSuspected: true });
const ethIn = (id: string, chain: number, raw: string, ts: string, cls = "RECEIVE") =>
  leg({ id, chain, dir: "IN", symbol: "ETH", raw, ts, assetType: "NATIVE", cls });
const eth = (hundredths: number) => `${hundredths}${"0".repeat(16)}`; // 0.01 * n at 18 decimals

describe("BridgeLinkingService.linkForUser", () => {
  it("links an isolated 1:1 native-ETH bridge: both INTERNAL_TRANSFER, one group_id, dest chain", async () => {
    const { repo, service } = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      ethIn("in", 10, "99900000000000000" /* 0.0999 ETH (fee) */, "2025-01-01T00:00:16Z"),
    );
    expect(await service.linkForUser(USER)).toBe(1);
    const out = await byId(repo, "out");
    const inLeg = await byId(repo, "in");
    expect(out.payload.classification).toBe("INTERNAL_TRANSFER");
    expect(inLeg.payload.classification).toBe("INTERNAL_TRANSFER");
    expect(out.payload.confidence).toBe(0.9);
    expect(out.payload.bridge_group_id).toBe("bridge:1:0xout");
    expect(inLeg.payload.bridge_group_id).toBe(out.payload.bridge_group_id);
    expect(out.payload.bridge_dest_chain_id).toBe(10);
    expect(inLeg.payload).not.toHaveProperty("bridge_dest_chain_id");
  });

  it("links a canonical USDT bridge across chains and rescues a SPAM-misflagged destination", async () => {
    const { repo, service } = await seed(
      leg({ id: "out", chain: 137, dir: "OUT", symbol: "USDT", raw: "10000000", ts: "2025-01-01T00:00:00Z", assetType: "ERC20", contract: USDT_POLYGON, bridgeSuspected: true }),
      leg({ id: "in", chain: 1, dir: "IN", symbol: "USDT", raw: "8500000", ts: "2025-01-01T00:00:29Z", assetType: "ERC20", contract: USDT_ETH, cls: "SPAM" }),
    );
    expect(await service.linkForUser(USER)).toBe(1);
    expect((await byId(repo, "in")).payload.classification).toBe("INTERNAL_TRANSFER");
    expect((await byId(repo, "out")).payload.classification).toBe("INTERNAL_TRANSFER");
  });

  it("treats native ETH and canonical WETH as the same asset", async () => {
    const { service } = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      leg({ id: "in", chain: 10, dir: "IN", symbol: "WETH", raw: eth(10), ts: "2025-01-01T00:00:16Z", assetType: "ERC20", contract: WETH_OP, decimals: 18 }),
    );
    expect(await service.linkForUser(USER)).toBe(1);
  });

  it("NEVER links a spoofed same-symbol token (unknown contract) - a spoof must not erase a SEND", async () => {
    const { repo, service } = await seed(
      leg({ id: "out", chain: 137, dir: "OUT", symbol: "USDT", raw: "10000000", ts: "2025-01-01T00:00:00Z", assetType: "ERC20", contract: USDT_POLYGON, bridgeSuspected: true }),
      // symbol says USDT but the contract is not a recognized canonical USDT -> not asset-equivalent
      leg({ id: "in", chain: 1, dir: "IN", symbol: "USDT", raw: "9900000", ts: "2025-01-01T00:00:29Z", assetType: "ERC20", contract: "0x000000000000000000000000000000000000dead" }),
    );
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byId(repo, "out")).payload.classification).toBe("SEND");
  });

  it("does NOT link a two-OUT / one-IN ambiguous shape (bidirectional uniqueness, not greedy)", async () => {
    const { repo, service } = await seed(
      ethOut("outA", 1, eth(10), "2025-01-01T00:00:00Z"),
      ethOut("outB", 8453, eth(10), "2025-01-01T00:00:05Z"),
      ethIn("in", 10, eth(10), "2025-01-01T00:00:16Z"), // eligible for BOTH outs -> ambiguous
    );
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byId(repo, "outA")).payload.classification).toBe("SEND");
    expect((await byId(repo, "outB")).payload.classification).toBe("SEND");
    expect((await byId(repo, "in")).payload.classification).toBe("RECEIVE");
  });

  it("does NOT link a one-OUT / two-IN ambiguous shape", async () => {
    const { repo, service } = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      ethIn("inA", 10, eth(10), "2025-01-01T00:00:16Z"),
      ethIn("inB", 42161, eth(10), "2025-01-01T00:01:00Z"),
    );
    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byId(repo, "out")).payload.classification).toBe("SEND");
  });

  it("does NOT link with no candidate, a same-chain move, an out-of-window IN, or an out-of-band amount", async () => {
    expect(await (await seed(ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"))).service.linkForUser(USER)).toBe(0);
    expect(await (await seed(ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"), ethIn("in", 1, eth(10), "2025-01-01T00:00:16Z"))).service.linkForUser(USER)).toBe(0);
    expect(await (await seed(ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"), ethIn("in", 10, eth(10), "2025-01-01T09:00:00Z"))).service.linkForUser(USER)).toBe(0);
    expect(await (await seed(ethOut("out", 1, eth(100), "2025-01-01T00:00:00Z"), ethIn("in", 10, eth(50), "2025-01-01T00:00:16Z"))).service.linkForUser(USER)).toBe(0);
  });

  it("never touches a leg the user manually overrode, and ignores swap-grouped legs", async () => {
    const outOverridden = await seed(
      leg({ id: "out", chain: 1, dir: "OUT", symbol: "ETH", raw: eth(10), ts: "2025-01-01T00:00:00Z", bridgeSuspected: true, userOverride: { classification: "SEND", reason: null, overridden_at: "2025-01-02T00:00:00Z" } }),
      ethIn("in", 10, eth(10), "2025-01-01T00:00:16Z"),
    );
    expect(await outOverridden.service.linkForUser(USER)).toBe(0);

    const inOverridden = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      leg({ id: "in", chain: 10, dir: "IN", symbol: "ETH", raw: eth(10), ts: "2025-01-01T00:00:16Z", userOverride: { classification: "RECEIVE", reason: null, overridden_at: "2025-01-02T00:00:00Z" } }),
    );
    expect(await inOverridden.service.linkForUser(USER)).toBe(0);

    const swap = await seed(
      leg({ id: "out", chain: 1, dir: "OUT", symbol: "ETH", raw: eth(10), ts: "2025-01-01T00:00:00Z", bridgeSuspected: true, groupId: "1:0xswap" }),
      ethIn("in", 10, eth(10), "2025-01-01T00:00:16Z"),
    );
    expect(await swap.service.linkForUser(USER)).toBe(0);
  });

  it("is idempotent: a second run writes nothing new and keeps the same deterministic group id", async () => {
    const { repo, service } = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      ethIn("in", 10, "99900000000000000", "2025-01-01T00:00:16Z"),
    );
    expect(await service.linkForUser(USER)).toBe(1);
    const gid = (await byId(repo, "out")).payload.bridge_group_id;
    expect(await service.linkForUser(USER)).toBe(0); // no-op on repeat
    expect((await byId(repo, "out")).payload.bridge_group_id).toBe(gid);
  });

  // --- cross-asset (bridge + swap) -------------------------------------------------------------
  // A bridge aggregator that routes through a pool pays out the OTHER stablecoin on the destination
  // chain. That conversion is a DISPOSAL, so the pair is booked EXCHANGE + RECEIVE, not as a move.
  describe("cross-asset canonical stablecoin pair", () => {
    // The observed Mayan route: 17.26924 USDT on Polygon -> 15.941987 USDC on Ethereum, ~30s later.
    const usdtOut = () =>
      leg({ id: "out", chain: 137, dir: "OUT", symbol: "USDT", raw: "17269240", ts: "2025-11-20T00:00:00Z", assetType: "ERC20", contract: USDT_POLYGON, bridgeSuspected: true });
    const usdcIn = (raw = "15941987") =>
      leg({ id: "in", chain: 1, dir: "IN", symbol: "USDC", raw, ts: "2025-11-20T00:00:30Z", assetType: "ERC20", contract: USDC_ETH });

    it("links USDT(Polygon) -> USDC(Ethereum) as a disposal: OUT EXCHANGE, IN RECEIVE, shared key", async () => {
      const { repo, service } = await seed(usdtOut(), usdcIn());
      expect(await service.linkForUser(USER)).toBe(1);
      const out = await byId(repo, "out");
      const inLeg = await byId(repo, "in");
      // The conversion is taxable, so the OUT stays a disposal and the IN anchors the new cost basis.
      expect(out.payload.classification).toBe("EXCHANGE");
      expect(inLeg.payload.classification).toBe("RECEIVE");
      expect(out.payload.confidence).toBe(0.9);
      expect(inLeg.payload.confidence).toBe(0.9);
      // Linked for display/provenance only. bridge_group_id moves cost between pools ONLY together
      // with INTERNAL_TRANSFER (cost-basis.ts bridgeGroupOf), so the disposal is still charged.
      expect(out.payload.bridge_group_id).toBe("bridge:137:0xout");
      expect(inLeg.payload.bridge_group_id).toBe(out.payload.bridge_group_id);
      expect(out.payload.bridge_dest_chain_id).toBe(1);
      // group_id would make the tax engine collapse the two chains to a single gas target.
      expect(out.payload.group_id ?? null).toBeNull();
      expect(inLeg.payload.group_id ?? null).toBeNull();
    });

    it("NEVER links a spoofed USDC contract - symbol alone can claim anything", async () => {
      const { repo, service } = await seed(
        usdtOut(),
        leg({ id: "in", chain: 1, dir: "IN", symbol: "USDC", raw: "15941987", ts: "2025-11-20T00:00:30Z", assetType: "ERC20", contract: "0x000000000000000000000000000000000000dead" }),
      );
      expect(await service.linkForUser(USER)).toBe(0);
      expect((await byId(repo, "out")).payload.classification).toBe("SEND");
    });

    it("does NOT cross assets that are not both canonical USD stables (ETH -> USDC)", async () => {
      const { service } = await seed(ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"), usdcIn("100000"));
      expect(await service.linkForUser(USER)).toBe(0);
    });

    it("keeps the same fee band for a cross-asset pair (no loosening for the same-asset case)", async () => {
      // 12.0 / 17.26924 = 69.5%, below the 80% floor -> not a pair.
      const { service } = await seed(usdtOut(), usdcIn("12000000"));
      expect(await service.linkForUser(USER)).toBe(0);
    });

    it("is idempotent and stays EXCHANGE/RECEIVE on a repeat run", async () => {
      const { repo, service } = await seed(usdtOut(), usdcIn());
      expect(await service.linkForUser(USER)).toBe(1);
      expect(await service.linkForUser(USER)).toBe(0);
      expect((await byId(repo, "out")).payload.classification).toBe("EXCHANGE");
      expect((await byId(repo, "in")).payload.classification).toBe("RECEIVE");
    });
  });

  it("never steals a leg the own-wallet pass already linked (own: keys are off limits)", async () => {
    const { repo, service } = await seed(
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      leg({ id: "in", chain: 10, dir: "IN", symbol: "ETH", raw: eth(10), ts: "2025-01-01T00:00:16Z", cls: "INTERNAL_TRANSFER" }),
    );
    // Mark the IN as an own-wallet move, the way own-wallet-linking.service.ts would have.
    const inLeg = await byId(repo, "in");
    await repo.updatePayload(USER, "in", { ...inLeg.payload, bridge_group_id: "own:10:0xin:3" });

    expect(await service.linkForUser(USER)).toBe(0);
    expect((await byId(repo, "in")).payload.bridge_group_id).toBe("own:10:0xin:3");
    expect((await byId(repo, "out")).payload.classification).toBe("SEND");
  });

  it("self-heals a one-sided (orphaned) link: a mid-pair write failure is repaired on the next run", async () => {
    const base = new MockTransactionRepository();
    await base.save(BINDING, USER, [
      ethOut("out", 1, eth(10), "2025-01-01T00:00:00Z"),
      ethIn("in", 10, "99900000000000000", "2025-01-01T00:00:16Z"),
    ]);
    // Wrap the repo so the FIRST write to the IN leg throws, orphaning the pair (OUT linked, IN not).
    let failIn = true;
    const flaky: TransactionRepository = {
      listForUser: (u) => base.listForUser(u),
      findForUser: (u, id) => base.findForUser(u, id),
      updatePayload: async (u, id, payload) => {
        if (id === "in" && failIn) {
          failIn = false;
          throw new Error("simulated write failure");
        }
        return base.updatePayload(u, id, payload);
      },
    };
    const service = new BridgeLinkingService(flaky);

    await service.linkForUser(USER); // OUT gets linked, IN write throws -> orphan
    expect((await byId(base, "out")).payload.classification).toBe("INTERNAL_TRANSFER");
    expect((await byId(base, "in")).payload.classification).toBe("RECEIVE"); // orphaned

    await service.linkForUser(USER); // repair: OUT already correct (skip), IN now written
    expect((await byId(base, "in")).payload.classification).toBe("INTERNAL_TRANSFER");
    expect((await byId(base, "in")).payload.bridge_group_id).toBe("bridge:1:0xout");
  });
});
