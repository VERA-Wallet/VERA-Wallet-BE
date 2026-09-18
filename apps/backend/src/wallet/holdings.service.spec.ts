import { NotFoundException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { BalanceReader, BalanceSnapshot, TokenBalance } from "./balance.reader";
import { HoldingsService } from "./holdings.service";
import type { PriceOracle, TokenMarket } from "../indexer/price-oracle";

const BINDING = { id: "b1", userId: "u1", walletAddress: "0xWallet", verificationMethod: "watch_only" };

function serviceWith(balances: TokenBalance[], prices: Record<string, string | null>, bindings: unknown = BINDING) {
  const reader: BalanceReader = { read: async (): Promise<BalanceSnapshot> => ({ balances, skippedChainIds: [], truncatedChainIds: [] }) };
  const oracle: PriceOracle = {
    lookup: async (_chainId, contract): Promise<TokenMarket | null> => {
      const price = prices[contract.toLowerCase()] ?? null;
      return { priceUsd: price, liquidityUsd: price ? 1000 : 0, pairCount: price ? 1 : 0 };
    },
  };
  const wallets = {
    findLatestByUser: async () => bindings,
    findAllByUser: async () => [],
    markInitialSynced: async () => {},
    findByUserAndAddress: async () => bindings,
    upsert: async () => bindings,
  };
  return new HoldingsService(reader, oracle, wallets as never);
}

const token = (over: Partial<TokenBalance> = {}): TokenBalance => ({
  chainId: 1,
  contract: "0xaaa",
  symbol: "AAA",
  name: "AAA",
  decimals: 18,
  amount: "1",
  ...over,
});

describe("HoldingsService", () => {
  it("multiplies amount by price without floating point drift", async () => {
    const service = serviceWith([token({ amount: "0.001499311593817774" })], { "0xaaa": "2511.71" });
    const result = await service.forUser("u1");
    expect(result.holdings[0].valueUsd).toBe("3.76583592330804113354");
    expect(result.totalUsd).toBe("3.76583592330804113354");
  });

  // 스팸에 시세가 붙는 경우가 실제로 있다(유동성 있는 스캠 토큰). 합계에 들어가면 총 평가액이 부풀려진다.
  it("flags weaponized symbols as spam and keeps them out of the total", async () => {
    // 스팸에만 시세를 준다. 합계가 0이면 시세가 붙은 스팸이 합계에 안 들어갔다는 뜻이다.
    const service = serviceWith([token({ contract: "0xbbb", symbol: "www.bairdrop.co ✅", amount: "5000" })], { "0xbbb": "1" });
    const result = await service.forUser("u1");
    expect(result.holdings[0].spam).toBe(true);
    expect(result.holdings[0].valueUsd).toBe("5000");
    expect(result.spamCount).toBe(1);
    expect(result.totalUsd).toBe("0");
  });

  it("never marks a native coin as spam", async () => {
    const service = serviceWith([token({ contract: null, symbol: "ETH" })], {});
    const result = await service.forUser("u1");
    expect(result.holdings[0].spam).toBe(false);
  });

  // 시세 미상을 0으로 접으면 "무가치"라는 다른 주장이 된다 — 합계에서 빼되 목록에는 남긴다.
  it("keeps unpriced holdings visible but out of the total", async () => {
    const service = serviceWith([token({ contract: "0xccc", symbol: "IDOS", amount: "9" })], {});
    const result = await service.forUser("u1");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0].valueUsd).toBeNull();
    expect(result.unpricedCount).toBe(1);
    expect(result.totalUsd).toBe("0");
  });

  it("orders priced desc, then unpriced, then spam", async () => {
    const service = serviceWith(
      [
        token({ contract: "0xspam", symbol: "www.x.top ✅", amount: "1" }),
        token({ contract: "0xnone", symbol: "IDOS", amount: "1" }),
        token({ contract: "0xsmall", symbol: "SML", amount: "1" }),
        token({ contract: "0xbig", symbol: "BIG", amount: "1" }),
      ],
      { "0xspam": "9999", "0xsmall": "1", "0xbig": "100" },
    );
    const result = await service.forUser("u1");
    expect(result.holdings.map((h) => h.symbol)).toEqual(["BIG", "SML", "IDOS", "www.x.top ✅"]);
  });

  it("404s when the caller has no bound wallet", async () => {
    const service = serviceWith([], {}, null);
    await expect(service.forUser("u1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
