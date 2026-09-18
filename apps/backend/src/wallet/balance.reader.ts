/**
 * 지갑의 **현재 온체인 잔액** 읽기 포트.
 *
 * 인덱서(`ChainIndexer`)와 일부러 분리한다. 인덱서는 "무슨 일이 있었나"(거래 이력)를 커서로 따라가며 모으고,
 * 여기는 "지금 얼마나 들고 있나"(상태)를 매번 새로 읽는다. 커서·중복제거·정규화가 필요 없고, 반대로
 * 이력에 안 잡힌 자산(인덱싱 이전 전송, 컨트랙트 내부 정산 등)도 잔액에는 잡힌다.
 */

export interface TokenBalance {
  chainId: number;
  /** ERC-20 컨트랙트 주소. 네이티브 코인은 컨트랙트가 없어 null이다. */
  contract: string | null;
  symbol: string;
  name: string;
  decimals: number;
  /** 사람이 읽는 수량(십진 문자열). decimals를 이미 적용한 값이다. */
  amount: string;
}

export interface BalanceSnapshot {
  balances: TokenBalance[];
  /** 읽지 못한 체인. 부분 실패를 "잔액 0"으로 둔갑시키지 않으려고 화면까지 들고 간다. */
  skippedChainIds: number[];
  /** 체인당 토큰 상한에 걸려 잘린 체인. */
  truncatedChainIds: number[];
}

export interface BalanceReader {
  read(address: string): Promise<BalanceSnapshot>;
}
