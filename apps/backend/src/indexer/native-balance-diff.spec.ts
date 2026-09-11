import { describe, expect, it } from "vitest";
import {
  internalNativeDelta,
  nativeLegFromDelta,
  parseHexQuantity,
  parseReceiptFacts,
  parseTransactionFacts,
  selectUnambiguousCandidates,
  totalFeePaid,
  type ReceiptFacts,
  type TransactionFacts,
} from "./native-balance-diff";

const WALLET = "0xf8d09e078d3552ba1a5ae9876d3b24aa10b1efad";
const ROUTER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";

const transaction = (fields: Partial<TransactionFacts> = {}): TransactionFacts => ({
  from: ROUTER,
  to: OTHER,
  value: 0n,
  gasPrice: null,
  ...fields,
});

const receipt = (fields: Partial<ReceiptFacts> = {}): ReceiptFacts => ({
  blockNumber: 100n,
  succeeded: true,
  gasUsed: 0n,
  effectiveGasPrice: 0n,
  surcharges: 0n,
  ...fields,
});

describe("internalNativeDelta", () => {
  // The reported Arbitrum swap, with the balances measured live on 2026-09-10:
  // tx 0xc88e2736…a240, wallet 0xF8D0…EFAD, USDC -> ETH through a router.
  it("recovers the live Arbitrum swap payout the trace path could not see", () => {
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET, to: ROUTER, value: 0n }),
      feePaid: 4_708_060_206_000n,
      balanceBefore: 98_883_166_198_000n,
      balanceAfter: 6_423_512_562_504_764n,
    });
    // 0.006329337456512764 ETH — Koinly reports 0.00632934 for the same transaction.
    expect(delta).toBe(6_329_337_456_512_764n);
  });

  it("adds back the fee AND the top-level value a sender spent, since neither is an internal move", () => {
    // Wallet sends 1 ETH into a router and gets 3 ETH back internally; balance moved +2 ETH - fee.
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET, to: ROUTER, value: 1_000n }),
      feePaid: 7n,
      balanceBefore: 10_000n,
      balanceAfter: 12_000n - 7n,
    });
    expect(delta).toBe(3_000n);
  });

  it("subtracts the top-level value a RECIPIENT received, because that leg is already an `external` transfer", () => {
    // Someone sends the wallet 500 wei top-level and a further 200 through an internal call.
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: OTHER, to: WALLET, value: 500n }),
      feePaid: 9n, // paid by the sender, not by us
      balanceBefore: 1_000n,
      balanceAfter: 1_700n,
    });
    expect(delta).toBe(200n);
  });

  it("nets a self-send to zero: the wallet is both sender and recipient", () => {
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET, to: WALLET, value: 400n }),
      feePaid: 21n,
      balanceBefore: 5_000n,
      balanceAfter: 5_000n - 21n,
    });
    expect(delta).toBe(0n);
  });

  it("returns zero for an ordinary approve, where only the fee moved", () => {
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET, to: ROUTER, value: 0n }),
      feePaid: 1_234n,
      balanceBefore: 9_999n,
      balanceAfter: 9_999n - 1_234n,
    });
    expect(delta).toBe(0n);
  });

  it("goes negative when an internal call takes native OUT of the wallet", () => {
    // A contract the wallet called pulled 750 wei out of it beyond the fee.
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET, to: ROUTER, value: 0n }),
      feePaid: 50n,
      balanceBefore: 10_000n,
      balanceAfter: 10_000n - 50n - 750n,
    });
    expect(delta).toBe(-750n);
  });

  it("ignores the fee entirely when the wallet did not send the transaction", () => {
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: OTHER, to: ROUTER, value: 3n }),
      feePaid: 1_000_000n,
      balanceBefore: 0n,
      balanceAfter: 42n,
    });
    expect(delta).toBe(42n);
  });

  it("matches the wallet case-insensitively on both sides", () => {
    const delta = internalNativeDelta({
      wallet: WALLET,
      transaction: transaction({ from: WALLET.toUpperCase(), to: ROUTER, value: 0n }),
      feePaid: 5n,
      balanceBefore: 100n,
      balanceAfter: 100n - 5n + 60n,
    });
    expect(delta).toBe(60n);
  });
});

describe("nativeLegFromDelta", () => {
  it("emits nothing for a zero delta, so ordinary transactions add no rows", () => {
    expect(nativeLegFromDelta(0n)).toBeNull();
  });

  it("emits an IN leg for a positive delta", () => {
    expect(nativeLegFromDelta(6_329_337_456_512_764n)).toEqual({ direction: "IN", hexValue: "0x167c7fb6c24efc" });
  });

  it("emits an OUT leg carrying the MAGNITUDE for a negative delta", () => {
    expect(nativeLegFromDelta(-750n)).toEqual({ direction: "OUT", hexValue: "0x2ee" });
  });
});

describe("selectUnambiguousCandidates", () => {
  const at = (hash: string, block: bigint) => ({ hash, block });
  const blockOf = (candidate: { block: bigint }) => candidate.block;

  it("keeps one candidate per block, in input order", () => {
    const { usable, ambiguousBlocks } = selectUnambiguousCandidates([at("a", 10n), at("b", 12n), at("c", 11n)], blockOf);
    expect(usable.map((candidate) => candidate.hash)).toEqual(["a", "b", "c"]);
    expect(ambiguousBlocks).toEqual([]);
  });

  it("drops BOTH candidates of a block that holds two, because the diff cannot say which moved what", () => {
    const { usable, ambiguousBlocks } = selectUnambiguousCandidates([at("a", 10n), at("b", 10n), at("c", 11n)], blockOf);
    expect(usable.map((candidate) => candidate.hash)).toEqual(["c"]);
    expect(ambiguousBlocks).toEqual([10n]);
  });

  it("reports every ambiguous block, not just the first", () => {
    const { usable, ambiguousBlocks } = selectUnambiguousCandidates(
      [at("a", 10n), at("b", 10n), at("c", 20n), at("d", 20n), at("e", 20n)],
      blockOf,
    );
    expect(usable).toEqual([]);
    expect(ambiguousBlocks).toEqual([10n, 20n]);
  });

  it("handles an empty candidate list", () => {
    expect(selectUnambiguousCandidates([], blockOf)).toEqual({ usable: [], ambiguousBlocks: [] });
  });
});

describe("parseReceiptFacts", () => {
  const raw = { blockNumber: "0x64", status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" };

  it("reads block, success and fee inputs from a successful receipt", () => {
    expect(parseReceiptFacts(raw)).toEqual({
      blockNumber: 100n,
      succeeded: true,
      gasUsed: 21_000n,
      effectiveGasPrice: 1_000_000_000n,
      surcharges: 0n,
    });
  });

  it("marks a reverted receipt as failed so the caller skips it", () => {
    expect(parseReceiptFacts({ ...raw, status: "0x0" })?.succeeded).toBe(false);
  });

  it("folds the OP-stack L1 and operator fees into surcharges, since the sender paid them too", () => {
    expect(parseReceiptFacts({ ...raw, l1Fee: "0x64", operatorFee: "0xa" })?.surcharges).toBe(110n);
  });

  it("reports a missing effectiveGasPrice as absent rather than zero", () => {
    const { effectiveGasPrice, ...rest } = raw;
    expect(parseReceiptFacts(rest)?.effectiveGasPrice).toBeNull();
  });

  it("rejects a null result, a missing status, and a malformed quantity", () => {
    const { status, ...withoutStatus } = raw;
    expect(parseReceiptFacts(null)).toBeNull();
    expect(parseReceiptFacts(withoutStatus)).toBeNull();
    expect(parseReceiptFacts({ ...raw, gasUsed: "21000" })).toBeNull();
    expect(parseReceiptFacts({ ...raw, effectiveGasPrice: "oops" })).toBeNull();
    expect(parseReceiptFacts({ ...raw, l1Fee: "nope" })).toBeNull();
  });
});

describe("parseTransactionFacts", () => {
  it("reads sender, recipient and value", () => {
    expect(parseTransactionFacts({ from: WALLET, to: ROUTER, value: "0x3e8" })).toEqual({
      from: WALLET,
      to: ROUTER,
      value: 1_000n,
      gasPrice: null,
    });
  });

  it("accepts a contract creation, whose `to` is null", () => {
    expect(parseTransactionFacts({ from: WALLET, to: null, value: "0x0" })?.to).toBeNull();
  });

  it("rejects a missing sender or an unparseable value", () => {
    expect(parseTransactionFacts({ to: ROUTER, value: "0x1" })).toBeNull();
    expect(parseTransactionFacts({ from: WALLET, to: ROUTER, value: 1 })).toBeNull();
    expect(parseTransactionFacts(null)).toBeNull();
  });
});

describe("totalFeePaid", () => {
  it("multiplies gas by the receipt's effective price and adds the surcharges", () => {
    expect(totalFeePaid(receipt({ gasUsed: 21_000n, effectiveGasPrice: 100n, surcharges: 7n }), transaction())).toBe(2_100_007n);
  });

  it("falls back to the transaction's own gas price when the receipt omits one", () => {
    expect(totalFeePaid(receipt({ gasUsed: 10n, effectiveGasPrice: null }), transaction({ gasPrice: 3n }))).toBe(30n);
  });

  it("returns null when neither side reports a price, so the caller drops the candidate", () => {
    expect(totalFeePaid(receipt({ gasUsed: 10n, effectiveGasPrice: null }), transaction({ gasPrice: null }))).toBeNull();
  });
});

describe("parseHexQuantity", () => {
  it("accepts a strict 0x quantity and rejects everything else", () => {
    expect(parseHexQuantity("0x0")).toBe(0n);
    expect(parseHexQuantity("0x0de0b6b3a7640000")).toBe(1_000_000_000_000_000_000n);
    for (const bad of ["", "0x", "1234", "0xzz", 42, null, undefined]) expect(parseHexQuantity(bad)).toBeNull();
  });
});
