/**
 * 표시용 정식 자산 표 — "다른 체인이지만 같은 발행처의 같은 토큰"을 하나로 묶는 키.
 *
 * 규칙:
 * - 키는 `(chainId, 컨트랙트 소문자)`다. **심볼로는 절대 묶지 않는다** — 스팸이 "USDC"를 사칭할 수 있고,
 *   USDC(Circle 네이티브)·USDbC(브릿지)·USDC.e는 심볼이 비슷해도 다른 토큰이다. 표에 있는 배포만 같은 자산이다.
 * - 네이티브 코인은 체인 레지스트리의 nativeSymbol로 묶는다(ETH 계열 L2는 모두 `eth`).
 * - 표에 없는 토큰은 `null` — 묶지 않고 체인별로 남는다.
 *
 * 세금 원장은 이 표를 쓰지 않는다. 브릿지 판정은 indexer/bridge-linking.service.ts의 스테이블 전용 표를 쓰고,
 * 원가 fold는 체인별 cell 그대로다. 여기는 포트폴리오 화면이 행을 합쳐 보이기 위한 키일 뿐이다.
 */
import { CHAIN_REGISTRY } from "../indexer/chain-registry";

const CANONICAL_ERC20: Record<string, string> = {
  // USDC (Circle, 네이티브 발행)
  "1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "usdc",
  "10:0x0b2c639c533813f4aa9d7837caf62653d097ff85": "usdc",
  "137:0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": "usdc",
  "8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "usdc",
  "42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831": "usdc",
  // USDT (Tether)
  "1:0xdac17f958d2ee523a2206206994597c13d831ec7": "usdt",
  "10:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58": "usdt",
  "137:0xc2132d05d31c914a87c6611c10748aeb04b58e8f": "usdt",
  "8453:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "usdt",
  "42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9": "usdt",
  // DAI
  "1:0x6b175474e89094c44da98b954eedeac495271d0f": "dai",
  // WETH — 네이티브 ETH와 같은 자산으로 본다(1:1 래핑)
  "1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "eth",
  "8453:0x4200000000000000000000000000000000000006": "eth",
  "10:0x4200000000000000000000000000000000000006": "eth",
  "42161:0x82af49447d8a07e3bd95bd0d56f35241523fbab1": "eth",
  "137:0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": "pol",
  // 2026-09-11 실지갑에서 확인한 멀티체인 배포
  "1:0xbe0ed4138121ecfc5c0e56b40517da27e6c5226b": "ath", // Aethir
  "42161:0xc87b37a581ec3257b734886d9d3a581f5a9d056c": "ath",
  "8453:0xc08cd26474722ce93f4d0c34d16201461c10aa8c": "carv", // CARV
  "42161:0xc08cd26474722ce93f4d0c34d16201461c10aa8c": "carv",
};

/** (체인, 자산) → 정식 자산 키. 표에 없으면 null. */
export function canonicalAssetIdOf(chainId: number, assetType: "NATIVE" | "ERC20", contract: string | null): string | null {
  if (assetType === "NATIVE") {
    const symbol = CHAIN_REGISTRY.find((entry) => entry.chainId === chainId)?.nativeSymbol;
    return symbol ? symbol.toLowerCase() : null;
  }
  if (!contract) return null;
  return CANONICAL_ERC20[`${chainId}:${contract.toLowerCase()}`] ?? null;
}
