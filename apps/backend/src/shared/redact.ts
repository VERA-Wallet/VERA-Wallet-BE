/**
 * 외부 클라이언트에 실린 자격증명을 지운다.
 *
 * OmniOne RPC는 인증 토큰을 **URL 쿼리**로 받는다(`?token=<JWT>`). 그런데 viem은 실패한 요청의
 * 에러 메시지에 URL을 통째로 넣는다(`URL: ${getUrl(url)}`). 그 에러가 로그나 응답으로 나가면
 * 27년짜리 API 토큰이 평문으로 남는다. 던지기 전에 한 번 거른다.
 *
 * 토큰 자리에 `***`를 남기는 이유: 아예 지우면 "인증 정보가 붙어 있었는지"조차 알 수 없어
 * 401을 디버깅할 수 없다.
 */
const SECRET_PATTERNS: RegExp[] = [
  // URL 쿼리·폼에 실린 토큰류. 값이 끝나는 지점은 구분자(&, 공백, 따옴표, 괄호)로 본다.
  /\b(token|apikey|api_key|access_token|secret|password)=([^&\s"'`)\]]+)/gi,
  // 헤더 표기(`x-api-key: ...`)와 Bearer.
  /\b(x-api-key|authorization)\s*:\s*([^\s"'`,)\]]+)/gi,
  /\bBearer\s+([A-Za-z0-9._~+/-]+=*)/gi,
  // 0x로 시작하는 32바이트 개인키. 트랜잭션·머클 해시(같은 길이)와 구분할 수 없으므로 여기서는 다루지 않고,
  // 개인키는 애초에 에러 메시지에 실리지 않는다(viem은 계정 주소만 노출한다).
];

export function redactSecrets(value: string): string {
  let output = value;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (_match, ...groups: string[]) =>
      groups.length >= 2 && typeof groups[1] === "string" ? `${groups[0]}=***` : `${groups[0]?.split(" ")[0] ?? ""} ***`,
    );
  }
  return output;
}

/** 에러를 그대로 다시 던지되 메시지에서 자격증명만 지운다. 스택·원인은 유지한다. */
export function redactError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const redacted = redactSecrets(error.message);
  if (redacted === error.message) return error;
  error.message = redacted;
  return error;
}
