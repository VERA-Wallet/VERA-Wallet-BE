/**
 * OmniOne Chain 탐색기 링크.
 *
 * **스테이지에는 블록 탐색기가 없다.** 콘솔(`stage-chain.omnione.net`)의 라우트는
 * home·environment·contract·apiKey·notice·user-guide뿐이고 트랜잭션 조회 화면이 없으며,
 * RPC 호스트(`stage-chainapi.omnione.net`)에 `/tx/<hash>`를 붙이면 401이 온다.
 * 그래서 주소를 지어내지 않는다 — 탐색기가 실제로 생겨 `OMNIONE_EXPLORER_URL`을 줄 때만 링크를 만든다.
 * null이면 화면은 링크 대신 거래 해시를 그대로 보인다(사용자가 직접 조회할 수 있는 유일한 값이다).
 */
export function omnioneExplorerTxUrl(txHash: string, base = process.env.OMNIONE_EXPLORER_URL): string | null {
  const trimmed = base?.trim();
  return trimmed ? `${trimmed.replace(/\/+$/, "")}/tx/${txHash}` : null;
}
