/**
 * 지갑 등록 해제가 인덱서에 요구하는 것 하나: 지운 지갑과의 "내 지갑 간 이동" 판정을 되돌려라.
 * 기능 모듈끼리는 구체 서비스가 아니라 이 포트(토큰 `OWN_WALLET_UNLINK`)로만 만난다.
 */
export interface OwnWalletUnlinkPort {
  /** 되돌린 행 수를 돌려준다. */
  unlinkCounterparty(userId: string, removedAddress: string): Promise<number>;
}
