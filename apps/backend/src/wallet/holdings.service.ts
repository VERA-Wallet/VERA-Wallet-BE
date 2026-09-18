import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PRICE_ORACLE } from "../indexer/indexer.tokens";
import { CONTRACT_ALLOWLIST, SPAM_CONTRACT_DENYLIST, isWeaponizedSymbol } from "../indexer/spam-filter";
import type { PriceOracle } from "../indexer/price-oracle";
import type { BalanceReader, TokenBalance } from "./balance.reader";
import { BALANCE_READER } from "./wallet.tokens";
import type { WalletRepository, WalletBindingRepository } from "./wallet.repository";
import { WALLET_REPOSITORY } from "./wallet.tokens";

/**
 * 네이티브 코인 시세 대용 컨트랙트.
 *
 * DexScreener는 **컨트랙트 주소**로만 시세를 찾는데 네이티브 코인은 컨트랙트가 없다. 각 체인의 캐노니컬
 * wrapped 컨트랙트(WETH/WPOL)가 1:1로 상환되므로 그 시세를 네이티브 단가로 쓴다. 주소는 2026-09-18에
 * DexScreener 응답의 baseToken.symbol로 확인했다(각각 WETH·WETH·WETH·WETH·WPOL).
 */
const WRAPPED_NATIVE: Record<number, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  8453: "0x4200000000000000000000000000000000000006",
  42161: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  10: "0x4200000000000000000000000000000000000006",
  137: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
};

/** 시세 조회 동시 실행 수. DexScreener는 키가 없는 공개 API라 과하게 때리면 막힌다. */
const PRICE_CONCURRENCY = 4;

export interface HoldingDto {
  key: string;
  chainId: number;
  contract: string | null;
  symbol: string;
  name: string;
  amount: string;
  /** 단가(USD). 시세를 못 찾았으면 null — 0으로 내리면 "무가치"라는 다른 주장이 된다. */
  priceUsd: string | null;
  /** 평가액 = amount × priceUsd. 단가가 null이면 null이다. */
  valueUsd: string | null;
  /**
   * 에어드랍 스팸으로 판정됨. 지우지 않고 표시만 내린다 — 거래 분류와 같은 태도다.
   * 잔액은 온체인 사실이라 오판을 지우면 진짜 보유가 사라진다.
   */
  spam: boolean;
}

export interface HoldingsDto {
  walletAddress: string;
  holdings: HoldingDto[];
  /** 시세를 아는 항목만 더한 합계. 모르는 항목을 0으로 끼워 넣으면 합계가 조용히 작아진다. */
  totalUsd: string;
  unpricedCount: number;
  spamCount: number;
  skippedChainIds: number[];
  truncatedChainIds: number[];
}

// ── 십진 문자열 산술 ─────────────────────────────────────────────────────────
// 잔액은 18자리까지 간다. Number로 태우면 2^53 밖에서 값이 바뀌므로 자릿수만 맞춰 BigInt로 센다.

function fractionLength(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaledInt(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const magnitude = BigInt(`${whole || "0"}${fraction.padEnd(scale, "0")}`);
  return negative ? -magnitude : magnitude;
}

function fromScaledInt(scaled: bigint, scale: number): string {
  const negative = scaled < BigInt(0);
  const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale) || "0";
  const fraction = scale > 0 ? digits.slice(digits.length - scale).replace(/0+$/, "") : "";
  const body = fraction ? `${whole}.${fraction}` : whole;
  return negative && body !== "0" ? `-${body}` : body;
}

function multiplyDecimal(a: string, b: string): string {
  const scaleA = fractionLength(a);
  const scaleB = fractionLength(b);
  return fromScaledInt(toScaledInt(a, scaleA) * toScaledInt(b, scaleB), scaleA + scaleB);
}

function addDecimal(a: string, b: string): string {
  const scale = Math.max(fractionLength(a), fractionLength(b));
  return fromScaledInt(toScaledInt(a, scale) + toScaledInt(b, scale), scale);
}

/** 십진 문자열 비교(내림차순 정렬용). */
function compareDecimal(a: string, b: string): number {
  const scale = Math.max(fractionLength(a), fractionLength(b));
  const left = toScaledInt(a, scale);
  const right = toScaledInt(b, scale);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** 시세 문자열이 숫자인지. DexScreener는 문자열로 주고, 드물게 빈 값이나 지수표기가 섞인다. */
function isDecimalString(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}

async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]);
  });
  await Promise.all(runners);
  return results;
}

/**
 * 잔액 한 줄이 에어드랍 스팸인가.
 *
 * 거래의 `isInboundSpam`과 같은 신호(심볼 무기화·컨트랙트 명단)를 쓰되 자산 유형 규칙은 뺀다 —
 * 잔액에는 ERC-20만 올라오고, "받기만 한 NFT"라는 방향 개념 자체가 없다.
 * 네이티브 코인은 누가 밀어 넣을 수 없으므로 언제나 스팸이 아니다.
 */
function isSpamHolding(balance: TokenBalance): boolean {
  if (balance.contract === null) return false;
  const contract = balance.contract.toLowerCase();
  if (CONTRACT_ALLOWLIST.has(contract)) return false;
  if (SPAM_CONTRACT_DENYLIST.has(contract)) return true;
  return isWeaponizedSymbol(balance.symbol);
}

/**
 * 지갑 홈이 그리는 **현재 보유 자산**. 잔액(온체인 상태) × 현재가(DEX)다.
 *
 * 세금 화면의 수치와 별개다 — 저쪽은 거래 시점 시세로 쌓은 이력이고 여기는 지금 이 순간의 상태다.
 * 취득원가(평가손익)는 여기서 만들지 않는다. 원가는 이력·원가법(FIFO/이동평균/…)에 달린 값이라
 * 잔액만으로는 계산할 수 없고, 잔액에서 억지로 만들어 내면 세금 화면과 다른 숫자가 두 개 생긴다.
 */
@Injectable()
export class HoldingsService {
  constructor(
    @Inject(BALANCE_READER) private readonly balances: BalanceReader,
    @Inject(PRICE_ORACLE) private readonly prices: PriceOracle,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository & WalletBindingRepository,
  ) {}

  async forUser(userId: string, requestedWallet?: string): Promise<HoldingsDto> {
    // 남의 지갑 주소를 쿼리로 넣어 잔액을 캐가지 못하게, 요청한 주소가 이 사용자에게 묶여 있는지 먼저 본다.
    const binding = requestedWallet
      ? await this.wallets.findByUserAndAddress(userId, requestedWallet)
      : await this.wallets.findLatestByUser(userId);
    if (!binding) throw new NotFoundException("A bound wallet is required before reading holdings.");

    const snapshot = await this.balances.read(binding.walletAddress);
    const priced = await mapWithConcurrency(snapshot.balances, PRICE_CONCURRENCY, (balance) => this.price(balance));

    const holdings = priced.sort((left, right) => {
      // 스팸은 값과 무관하게 맨 아래다 — 유동성 있는 스캠 토큰이 평가액으로 목록 위를 차지하면 안 된다.
      if (left.spam !== right.spam) return left.spam ? 1 : -1;
      // 시세를 모르는 항목은 값으로 줄 세울 수 없으므로 그다음으로 내린다.
      if (left.valueUsd === null && right.valueUsd === null) return left.symbol.localeCompare(right.symbol);
      if (left.valueUsd === null) return 1;
      if (right.valueUsd === null) return -1;
      const byValue = compareDecimal(right.valueUsd, left.valueUsd);
      return byValue !== 0 ? byValue : left.symbol.localeCompare(right.symbol);
    });

    let totalUsd = "0";
    let unpricedCount = 0;
    let spamCount = 0;
    for (const holding of holdings) {
      // 스팸은 합계에도 넣지 않는다. 시세가 붙는 스캠 토큰이 총 평가액을 부풀리는 게 이 화면에서 제일 나쁜 거짓말이다.
      if (holding.spam) { spamCount += 1; continue; }
      if (holding.valueUsd === null) unpricedCount += 1;
      else totalUsd = addDecimal(totalUsd, holding.valueUsd);
    }

    return {
      walletAddress: binding.walletAddress,
      holdings,
      totalUsd,
      unpricedCount,
      spamCount,
      skippedChainIds: snapshot.skippedChainIds,
      truncatedChainIds: snapshot.truncatedChainIds,
    };
  }

  private async price(balance: TokenBalance): Promise<HoldingDto> {
    const contract = balance.contract ?? WRAPPED_NATIVE[balance.chainId] ?? null;
    const base: HoldingDto = {
      key: `${balance.chainId}:${balance.contract ?? "native"}`,
      chainId: balance.chainId,
      contract: balance.contract,
      symbol: balance.symbol,
      name: balance.name,
      amount: balance.amount,
      priceUsd: null,
      valueUsd: null,
      spam: isSpamHolding(balance),
    };
    if (!contract) return base;

    // oracle이 null을 주면 "조회 실패"(시세 미상)이고, pairCount 0은 "시장 없음 확인"이다.
    // 둘 다 화면에서는 단가 미상으로 같게 취급하되, 0원이라고 단정하지는 않는다.
    const market = await this.prices.lookup(balance.chainId, contract);
    const raw = market?.priceUsd;
    if (typeof raw !== "string" || !isDecimalString(raw)) return base;

    return { ...base, priceUsd: raw, valueUsd: multiplyDecimal(balance.amount, raw) };
  }
}
