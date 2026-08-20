# VeraWallet FE ↔ BE 연동 가이드

- 대상: VeraWallet-FE 개발자
- 기준일: 2026-08-07
- Backend: NestJS (`http://localhost:3200`)
- Frontend: Next.js (`http://localhost:3100`)

## 1. 가장 먼저 알아야 할 점

현재 VeraWallet-FE에는 `app/api/*` Route Handler와 인메모리 Mock 저장소가 들어 있습니다. 프론트의 `fetch("/api/...")`는 기본적으로 이 Next.js 내부 API에 도달하며, 별도로 실행한 NestJS 백엔드에는 전달되지 않습니다.

```text
현재
Browser → localhost:3100/api/* → Next.js Route Handler → FE Mock Store

연동 후
Browser → localhost:3100/api/* → Next.js beforeFiles rewrite → localhost:3200/api/* → NestJS
```

백엔드에도 두 실행 모드가 있습니다.

| 모드 | 저장소 | 외부 연동 | 응답 provenance |
|---|---|---|---|
| `MOCK_MODE=true` | 인메모리 | Mock OmniOne/Alchemy | `mock` |
| `MOCK_MODE=false` | PostgreSQL + Redis | Real 어댑터 | `live` |

현재 Real OmniOne CX 본인확인 어댑터는 **미구현**입니다(`OmniOneCxAdapter.handleCallback`이 TODO이며 호출 시 `503`). OmniOne Chain 쓰기와 Alchemy 어댑터도 같은 상태의 TODO 뼈대입니다. FE→BE 토큰 전달 경로는 완성되어 있으므로, Real 전환에 남은 것은 이 어댑터의 CX server-to-server 검증 구현 하나입니다. 따라서 첫 연동 목표는 **FE 내부 Mock을 NestJS Mock API로 교체하는 것**입니다.

### OmniOne CX 표준인증창 (Real 모드 본인확인)

Real 모드에서 모바일신분증 로그인은 라온시큐어 호스팅 표준인증창을 사용합니다.

1. FE는 `NEXT_PUBLIC_OMNIONE_CX_AUTH_URL` 설정 시 로그인 버튼에서 CX 인증창을 엽니다(`verawallet-fe/lib/omnione/oacx.ts`가 `oacx-vendor.js`, `oacx-ux.js`, `oacx-ux.css` 로드와 `<div id="oacxDiv">` 마운트를 담당).
2. `OACX.LOAD_MODULE("<OMNIONE_CX_AUTH_URL>/config/config.mid.json", { contentInfo: { signType: "ENT_MID" }, compareCI: false, isBirth: true }, cb)` 호출 시 표준인증창이 QR(데스크톱) 또는 딥링크(모바일)를 표시하고, 사용자가 모바일신분증 앱으로 제출하면 성공 콜백에 `res.token`이 전달됩니다. 배포된 모듈은 boolean `isBirth`를 필수로 요구하며 `compareCI`/`isBirth`는 정확히 하나만 true여야 합니다(가이드북 p.23 샘플에는 누락된 제약).
3. FE는 이 토큰을 `POST /api/auth/did/present`의 `cxToken` 필드로 전달합니다(코어 API를 직접 쓰는 경우 `POST /auth/verify/callback`의 `token`). BE는 이 값을 `PresentDidDto.cxToken`으로 받아 `AuthService.callback` → `IdentityProvider.handleCallback`까지 그대로 넘깁니다. 이후 CX 서버와 server-to-server로 토큰을 교환·파싱하고 CI 해시(`didHash`)만 저장하는 부분이 `OmniOneCxAdapter`의 남은 TODO입니다. 원본 신원 클레임은 FE·DB 어디에도 저장하지 않습니다.
4. Mock 모드(`MOCK_MODE=true`)에서는 토큰이 어댑터까지 전달되지만 `MockIdentityAdapter`가 검증 없이 고정 신원을 반환하며, `cxToken`이 없으면 `mock-did-<country>` 폴백으로 세션을 발급합니다(e2e·계약 테스트 경로). 이 폴백은 MOCK_MODE에서만 허용되고 `MOCK_MODE=false`에서는 토큰 없는 제시가 `401`입니다 — 인증창을 건너뛴 로그인을 막습니다. `NEXT_PUBLIC_OMNIONE_CX_AUTH_URL`을 비워 두면 FE는 기존 mock QR 프레젠테이션을 유지합니다.

## 2. 개발 서버 실행

Backend:

```bash
cd /srv/VeraWallet-BE
cp apps/backend/.env.example apps/backend/.env
pnpm install
pnpm prisma:generate
pnpm dev
```

Frontend:

```bash
cd /srv/VeraWallet-FE
pnpm install
pnpm exec next dev -p 3100
```

확인:

```bash
curl http://localhost:3200/health
```

```json
{
  "status": "ok",
  "service": "VeraWallet-BE",
  "mockMode": true,
  "timestamp": "2026-08-07T00:00:00.000Z"
}
```

Backend 환경변수는 최소한 다음 값을 맞춰야 합니다.

```dotenv
MOCK_MODE=true
PORT=3200
FRONTEND_ORIGIN=http://localhost:3100
SIWE_TRUSTED_ORIGIN=http://localhost:3100
JWT_SECRET=local-development-secret-at-least-32-characters
```

`localhost`와 `127.0.0.1`을 섞지 마십시오. SIWE의 `domain`과 `uri`는 서명 메시지의 일부이므로 실제 브라우저 origin과 `SIWE_TRUSTED_ORIGIN`이 일치해야 합니다.

## 3. Next.js 프록시 설정

현재 로컬 `app/api/*`보다 백엔드 프록시를 먼저 적용하려면 단순 rewrite 배열이 아니라 `beforeFiles`가 필요합니다. 단순 배열은 파일시스템 Route Handler가 우선될 수 있습니다.

`VeraWallet-FE/next.config.ts` 예시:

```ts
import type { NextConfig } from "next";

const backendOrigin = process.env.VERAWALLET_BACKEND_ORIGIN ?? "http://localhost:3200";

const nextConfig: NextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/api/:path*",
          destination: `${backendOrigin}/api/:path*`,
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
```

Frontend 환경변수:

```dotenv
VERAWALLET_BACKEND_ORIGIN=http://localhost:3200
```

설정 변경 후 Next.js 개발 서버를 재시작해야 합니다.

주의: FE 전용 `/api/auth/test-login`은 백엔드에 없습니다. 전체 `/api/*`를 프록시하면 이 개발 전용 경로는 `404`가 되며, 해당 경로에 의존하는 기존 FE e2e 테스트는 통합 테스트 흐름으로 교체해야 합니다.

직접 `http://localhost:3200`을 호출하는 방식도 가능하지만 모든 fetch에 `credentials: "include"`와 API base URL 처리가 필요합니다. 현재 어댑터가 상대 경로를 사용하므로 동일 origin rewrite 방식이 권장됩니다.

## 4. 공통 응답 계약

프론트 호환 API(`/api/*`)의 성공 응답:

```ts
type SuccessEnvelope<T> = {
  data: T;
  meta: {
    provenance: "mock" | "live";
    generatedAt: string; // RFC 3339
  };
};
```

오류 응답:

```ts
type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};
```

낙관적 잠금 충돌:

```ts
type VersionConflict<T> = {
  error: {
    code: "version_conflict";
    message: string;
  };
  data: T;
};
```

현재 FE의 `SuccessEnvelope.meta.provenance`와 일부 Zod schema는 `"mock"`만 허용합니다. Real 모드 전환 전에 반드시 `z.enum(["mock", "live"])` 또는 동등한 타입으로 확장해야 합니다.

### HTTP 상태 코드

| 상태 | 의미 |
|---|---|
| `200` | GET/PATCH 성공 |
| `201` | POST 성공 |
| `204` | 로그아웃 성공 |
| `400` | 요청 형식 또는 challenge 오류 |
| `401` | JWT 쿠키 없음/만료 또는 서명 실패 |
| `404` | 리소스 또는 바인딩된 지갑 없음 |
| `409` | nonce 재사용 또는 이벤트 버전 충돌 |
| `410` | nonce 만료 |
| `503` | Real 외부 어댑터 미구현/미설정 |

금액과 수량은 부동소수점 손실 방지를 위해 JSON number가 아닌 decimal 문자열로 처리합니다.

## 5. 인증과 온보딩 순서

현재 FE 호환 흐름은 HttpOnly 쿠키 `vw_access_token`을 사용합니다.

```text
1. DID 제시
   POST /api/auth/did/present
            ↓ JWT HttpOnly 쿠키 발급
2. SIWE nonce 요청
   POST /api/auth/nonce
            ↓
3. 지갑에서 SIWE 메시지 서명
            ↓
4. 서명 검증 및 지갑 바인딩
   POST /api/auth/verify
            ↓
5. 이벤트/세금 API 사용
```

브라우저 fetch가 다른 origin을 직접 호출한다면 `credentials: "include"`가 필수입니다. 권장 rewrite 방식에서는 기존 `credentials: "same-origin"`을 유지할 수 있습니다.

### 5.1 DID 제시

```http
POST /api/auth/did/present
Content-Type: application/json

{ "country": "KR" }
```

지원 코드: `KR`, `DE`, `US`, `UK`.

```json
{
  "data": {
    "countryCode": "KR",
    "ruleset": {
      "country": "KR",
      "cost_basis": "이동평균법",
      "badge_label": "대한민국"
    }
  },
  "meta": {
    "provenance": "mock",
    "generatedAt": "2026-08-07T00:00:00.000Z"
  }
}
```

응답의 `Set-Cookie`로 JWT가 저장됩니다. JWT나 DID hash를 브라우저 저장소에 별도로 복사하지 마십시오.

### 5.2 SIWE nonce 요청

```http
POST /api/auth/nonce
Content-Type: application/json
Cookie: vw_access_token=...

{ "chainId": 1 }
```

```json
{
  "data": {
    "nonce": "32-character-hex",
    "domain": "localhost:3100",
    "uri": "http://localhost:3100/connect-wallet",
    "chainId": 1,
    "issuedAt": "2026-08-07T00:00:00.000Z",
    "expiresAtMs": 1786032300000
  },
  "meta": {
    "provenance": "mock",
    "generatedAt": "2026-08-07T00:00:00.000Z"
  }
}
```

서명 메시지는 응답의 `domain`, `uri`, `chainId`, `nonce`, `issuedAt`을 그대로 사용해 생성해야 합니다. 클라이언트에서 값을 재생성하거나 수정하면 `challenge_mismatch`가 발생합니다. nonce 유효시간은 5분이며 한 번만 사용할 수 있습니다.

### 5.3 SIWE 검증과 바인딩

```http
POST /api/auth/verify
Content-Type: application/json
Cookie: vw_access_token=...

{
  "message": "<prepared SIWE message>",
  "signature": "0x..."
}
```

```json
{
  "data": {
    "walletAddress": "0x...",
    "chainId": 1
  },
  "meta": {
    "provenance": "mock",
    "generatedAt": "2026-08-07T00:00:00.000Z"
  }
}
```

서버는 `viem.verifyMessage`로 서명을 검증하고 `bindingHash`만 앵커링합니다. 개인키는 요청하거나 저장하지 않습니다.

### 5.4 세션 조회와 로그아웃

```http
GET /api/auth/session
```

```json
{
  "data": {
    "didVerified": true,
    "countryCode": "KR",
    "walletAddress": "0x...",
    "chainId": 1
  },
  "meta": {
    "provenance": "mock",
    "generatedAt": "2026-08-07T00:00:00.000Z"
  }
}
```

미인증 상태도 `200`이며 네 필드가 `false`/`null`로 반환됩니다.

```http
POST /api/auth/logout
```

성공 응답은 body가 없는 `204`입니다.

## 6. 이벤트 API

모든 이벤트 API는 유효한 JWT 쿠키와 바인딩된 지갑이 필요합니다. 최초 이벤트 조회 시 저장된 거래가 없으면 백엔드가 동기화를 한 번 실행합니다. `MOCK_MODE=true`에서는 25개의 정규화 fixture가 생성됩니다.

### 6.1 이벤트 목록

```http
GET /api/events?cursor=<event-id>&limit=20
```

- `limit`: 기본 20, 최소 1, 최대 100
- `cursor`: 마지막으로 받은 event ID

```ts
type EventListDTO = {
  items: Array<{
    event: NormalizedEvent;
    version: number;
  }>;
  nextCursor: string | null;
};
```

```ts
type NormalizedEvent = {
  id: string;
  tx_hash: string;
  chain_id: number;
  log_index: number;
  block_timestamp: string;
  wallet_address: string;
  direction: "IN" | "OUT";
  asset_type: "NATIVE" | "ERC20" | "ERC721" | "ERC1155";
  asset_contract: string | null;
  token_id: string | null;
  decimals: number;
  raw_amount: string;
  counterparty: string;
  gas_fee_native: string;
  classification: "RECEIVE" | "SEND" | "EXCHANGE" | "INTERNAL_TRANSFER" | "UNKNOWN";
  confidence: number;
  user_override: {
    classification: NormalizedEvent["classification"];
    reason: string | null;
    overridden_at: string;
  } | null;
  price_status: "RESOLVED" | "UNKNOWN" | "ESTIMATED";
  fiat_value: string | null;
  fiat_currency: string;
};
```

### 6.2 단건 조회

```http
GET /api/events/:id
```

```ts
type EventDetailDTO = {
  event: NormalizedEvent;
  version: number;
  override_history: Array<{
    from: NormalizedEvent["classification"];
    to: NormalizedEvent["classification"];
    reason: string | null;
    overridden_at: string;
  }>;
};
```

### 6.3 사용자 재분류

```http
PATCH /api/events/:id
Content-Type: application/json

{
  "classification": "SEND",
  "reason": "개인 지갑으로 전송",
  "expectedVersion": 1
}
```

성공 시 `{ event, version }`을 반환합니다. 다른 요청이 먼저 수정한 경우 `409`와 최신 `{ event, version }`이 반환되므로 클라이언트는 최신 데이터를 반영한 뒤 사용자가 다시 결정하도록 해야 합니다.

### 6.4 기간 요약

```http
GET /api/events/summary?from=2025-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z
```

기간은 `[from, to)`이며 RFC 3339 형식입니다.

```ts
type SummaryDTO = {
  periodPnl: string;
  computableEventCount: number;
  taxableEventCount: number;
  pendingReviewCount: number;
  currency: string;
  period: { from: string; to: string };
};
```

### 6.5 앵커 증명

```http
GET /api/anchor-proof?eventId=event-01
```

```ts
type AnchorProof = {
  tx_hash: string;
  merkle_root: string;
  anchored_at: string;
  explorer_url: string;
};
```

## 7. 세금 API

### 7.1 룰셋 목록

두 경로는 동일한 결과를 반환합니다.

```http
GET /api/tax/rulesets
GET /api/rulesets
```

지원 코드: `DE`, `US`, `IN`, `PT`, `GB`, `AU`, `FR`, `IT`, `ES`, `CA`, `JP`, `KR`.

### 7.2 세금 추정

```http
POST /api/tax/estimate
Content-Type: application/json

{
  "country": "US",
  "taxYear": 2025,
  "source": "wallet",
  "profile": {
    "filingStatus": "SINGLE"
  },
  "includeMarginal": false
}
```

응답은 기존 FE의 `TaxEstimate` DTO와 호환되며 다음 필드를 포함합니다.

- `country`, `countryLabel`, `currency`, `taxYear`, `period`
- `method`, `status`, `lines`, `totals`
- `lossCarryforward`, `notes`, `limitations`, `openQuestions`
- `requiredInputs`, `excludedEventIds`, `judgments`
- `isEstimate: true`, `disclaimer`

모든 금액은 decimal 문자열입니다. `isEstimate`와 disclaimer는 UI에서 제거하거나 숨기지 마십시오.

현재 제한: Backend v1 호환 계층에서는 `source: "scenario"`와 `source: "wallet"`이 모두 동기화된 지갑 이벤트를 사용합니다. `profile`과 `includeMarginal`도 요청 검증은 하지만 아직 계산에 반영하지 않습니다. FE 내부의 별도 국가 비교 scenario fixture 및 한계기여도와 완전히 같은 결과가 필요한 경우 후속 API 계약 확장이 필요합니다.

## 8. Backend 핵심 API

현재 FE 호환 계층 외에 다음 핵심 API도 존재합니다. 이 경로는 일부 응답이 `/api/*` envelope 형식이 아니며 Bearer JWT 사용을 지원합니다.

| Method | Path | 인증 | 설명 |
|---|---|---|---|
| POST | `/auth/verify/start` | 없음 | OmniOne 본인확인 세션 시작 |
| POST | `/auth/verify/callback` | 없음 | 콜백 검증, JWT 발급 |
| POST | `/wallet/bind/challenge` | JWT | personal_sign challenge |
| POST | `/wallet/bind` | JWT | 서명 검증, 바인딩, 비동기 앵커 |
| POST | `/indexer/sync` | JWT | 연결 지갑 동기화 |
| GET | `/tax/events?country=KR` | JWT | 저장된 과세 이벤트 |
| POST | `/tax/calculate` | JWT | 기간별 계산 및 draft report 생성 |
| GET | `/reports/:id` | JWT | 신고서 조회 |
| POST | `/reports/:id/finalize` | JWT | 신고서 확정 및 audit hash 앵커 |
| GET | `/anchors/:payloadHash` | 공개 | 앵커 상태 조회 |

현재 VeraWallet-FE는 우선 `/api/*` 호환 계층을 사용하는 것이 안전합니다.

## 9. 현재 알려진 차이와 제한

1. FE 내부 `/api/auth/nonce`는 익명 요청도 받지만 Backend 호환 API는 DID JWT 쿠키를 요구합니다. 정상 온보딩 순서는 DID → nonce → SIWE입니다.
2. FE 내부 DID 재제시는 이전 지갑 상태를 초기화하지만 Backend v1은 기존 DB 바인딩을 삭제하지 않습니다.
3. `/api/auth/session`의 `chainId`는 바인딩 존재 시 현재 `1`로 반환됩니다. 실제 SIWE chain ID 영속화는 후속 스키마 작업이 필요합니다.
4. `source: "scenario"`는 아직 별도 scenario fixture를 사용하지 않습니다.
5. `profile`과 `includeMarginal`은 현재 호환 DTO에서 허용되지만 계산에는 반영되지 않습니다.
6. Real 모드에서 OmniOne CX 본인확인은 동작하지만(1장 표준인증창 참조), Chain 쓰기/Alchemy 어댑터는 TODO이므로 `MOCK_MODE=false`만 설정한다고 모든 실데이터가 활성화되지는 않습니다.
7. `provenance: "live"`를 받을 수 있도록 FE runtime schema를 확장해야 Real 모드로 전환할 수 있습니다.

## 10. FE 연동 체크리스트

- [ ] `beforeFiles` rewrite로 `/api/*`를 `localhost:3200`에 연결
- [ ] Next.js 서버 재시작
- [ ] `/api/auth/test-login` 의존 제거 또는 통합 테스트 전용 처리
- [ ] DID → nonce → SIWE verify 순서 유지
- [ ] SIWE challenge 응답 값을 수정하지 않고 사용
- [ ] 쿠키 요청에서 credentials 유지
- [ ] `mock | live` provenance 허용
- [ ] decimal 문자열을 `Number`로 강제 변환하지 않기
- [ ] `409 version_conflict`의 최신 event/version 처리
- [ ] `isEstimate`와 disclaimer 상시 표시
- [ ] 연동 확인 시 NestJS 프로세스에 breakpoint/임시 요청 로그를 두고 `/api/*` 요청 도달 확인

rewrite는 목적지 주소를 숨기는 프록시이므로 브라우저 Network 탭의 요청 URL은 계속 `localhost:3100/api/*`로 표시됩니다. 연동 여부는 NestJS의 breakpoint 또는 임시 요청 로깅으로 확인하십시오. 프론트에서 DID 제시나 이벤트 조회를 수행했는데 NestJS가 전혀 반응하지 않는다면 요청은 여전히 FE 내부 Route Handler에서 처리되고 있는 것입니다.
