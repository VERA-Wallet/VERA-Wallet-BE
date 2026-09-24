# Open DID 백엔드 연동 계획

작성일: 2026-09-23 · 상태: 백엔드 구현 완료, FE·실기기 연동 대기

> 아래는 최초 설계 기록이다. 실제 구현 계약·설정·검증 결과는 [Open DID 백엔드 연결](../opendid-integration.md)을 우선한다. 공식 소스를 재확인해 `id`가 메시지 ID이고 현재 confirm 구현이 issuer/vc를 채우지 않는 점을 반영했다. 기존 공급자 콜백 타입은 유지하고 Open DID 전용 checkVerification으로 대기 상태를 처리한다.

## 1. 목표와 범위

VeraWallet의 신원 공급자에 `opendid`를 추가한다. BE가 Verifier에서 QR offer를 발급받고, 모바일 Open DID 지갑이 VP를 제출하면 BE가 검증 결과를 확인해 기존 사용자 저장·JWT·쿠키 흐름으로 연결한다. EVM 지갑 연결과 이후 자산 조회 흐름은 유지한다.

이번 문서는 구현 계획이다. 실제 코드 변경, Open DID 설치, 환경변수 적용, 배포는 별도 작업이다. 공급자는 기존처럼 서버 설정으로 하나를 선택한다. 로그인 화면에서 세 공급자를 동시에 고르는 기능과 기존 CX 계정 자동 병합은 범위에서 제외한다.

초기 범위는 안정적인 고유 클레임을 통한 로그인이다. 거주국은 기존 사용자 선택을 유지하고 검증된 정보로 표시하지 않는다. VC 거주국 클레임 연동은 후속 범위다.

## 2. 근거와 현재 구조

외부 계약은 사용자가 전달한 **2026-09-20 did-verifier-server develop / did-demo-server VerifierFeign 확인 결과**를 기준으로 한다. 이번 문서 작업에서 외부 소스나 실서버를 재검증하지 않았다. 구현 착수 시 사용한 커밋 SHA와 비식별 응답 fixture를 기록한다.

로컬 코드에서 확인한 연결 지점:

| 파일 | 현재 동작 | 계획 |
|---|---|---|
| `packages/interfaces/src/index.ts` | `handleCallback()`은 성공 신원만 반환 | Open DID 요청 및 대기 결과 타입 추가 |
| `apps/backend/src/shared/identity-mode.ts` | mock / omnione_cx 선택 | opendid 인식, health에 동일 값 노출 |
| `apps/backend/src/identity/identity.module.ts` | 두 공급자 팩토리 | Open DID 공급자 등록 |
| `apps/backend/src/identity/identity.adapters.ts` | mock 및 CX 토큰 검증 | 별도 Open DID 어댑터 파일 추가 |
| `apps/backend/src/auth/auth.service.ts` | 검증 직후 upsert → JWT | 대기와 성공을 분리하고 기존 세션 발급 로직 재사용 |
| `apps/backend/src/auth/frontend-auth.controller.ts` | `/api/auth/did/present`에서 cxToken 처리 | offer 생성 및 Open DID 폴링 분기 |
| `apps/backend/src/auth/auth.controller.ts` | `/auth/verify/start`, `/auth/verify/callback`도 공개 | Open DID에서 브라우저 바인딩 우회 경로가 되지 않도록 차단 |
| `apps/backend/src/auth/auth.dto.ts` | country / cxToken 검증 | offerId 추가, 공급자별 필수·배타 조건 검증 |
| `apps/backend/src/shared/api.ts` | provenance 기본값은 MOCK_MODE | 신원 응답은 실제 공급자 기준으로 명시 |

`IdentityVerification.method`는 Prisma에서 String이므로 공급자 이름 추가만으로 DB enum 변경은 필요 없다. 다만 아래 인증 시도 저장소를 추가하면 별도 마이그레이션이 필요하다.

## 3. Verifier 계약

베이스 URL은 **`http://<host>:8092/verifier`**다. 어댑터는 여기에 `/api/v1/...`를 붙인다. `/verifier`를 누락하거나 두 번 붙이지 않는다.

| 용도 | 메서드·전체 경로 | 요청 | 응답 |
|---|---|---|---|
| QR 발급 | `POST /verifier/api/v1/request-offer-qr` | `{id, policyId}` | `{txId, payload:{offerId,type,mode,device,service,endpoints,validUntil,locked}}` |
| 결과 확인 | `POST /verifier/api/v1/confirm-verify` | `{offerId}` | `{result:boolean, vc, issuer, claims:[{code,caption,value,type,format,hideValue}]}` |
| 정책 목록, 운영자용 | `GET /verifier/admin/v1/policies/all` | — | 관리 UI에서 정책 선택에 사용 |

QR 데이터는 발급 응답 전체가 아니라 `payload`다. 실제 QR 문자열 직렬화 방식은 지갑/데모와 호환되는 fixture로 고정한다. `request-profile`·`request-verify`는 모바일 지갑과 Verifier 사이의 호출이다.

**confirm 응답에는 holder DID가 없다.** holder DID가 있다고 가정하거나 VC id를 사람의 영구 식별자로 취급하지 않는다.

착수 전 확인할 외부 계약:

- `id`의 의미·생성 규칙: 서비스 등록 ID인지 요청 식별자인지 확인한다. 확인 없이 sessionId를 대입하지 않는다.
- `result:false` 및 오류 응답이 대기·거절·만료를 어떻게 구분하는지, 성공 결과 재조회가 가능한지 확인한다.
- `validUntil`의 형식·시간대, offer 유효기간, `locked` 의미를 확인한다.
- `vc`·`issuer`의 실제 타입과 issuer 식별자 위치, 클레임 값 타입 및 중복 code 처리 규칙을 고정한다.
- 호출 인증, 정책의 issuer/schema 제한, 요청 제한, 성공 결과의 offer 귀속을 확인한다.

확인되지 않은 `result:false`를 일괄 ‘거절’ 또는 ‘대기’로 단정하지 않는다. 공급자별 상태 매핑을 완료해야 실서버 연동 완료로 본다.

## 4. 계정 식별 정책

권장 기본값은 Issuer가 발급하는 **재발급 후에도 유지되는 불투명 고유 클레임**이다. 클레임 code와 허용 issuer를 BE 설정에 고정하고, 해당 클레임을 VP 정책의 필수 제시 항목으로 둔다. 사용자가 임의 입력하거나 수정할 수 있는 값은 계정 키로 쓰지 않는다.

계정 키 제안:

```text
didHash = 0x + SHA-256(JSON.stringify([
  "opendid", "v1", trustedIssuerId, subjectClaimCode, validatedSubjectValue
]))
```

정규화 규칙을 스키마와 함께 고정한다. 불필요한 대소문자 변환 등으로 다른 식별자를 합치지 않는다. 필수 클레임 누락·중복·잘못된 타입·허용되지 않은 issuer는 인증 실패다. 주민번호·이름·생년월일 조합은 사용하지 않는다.

`vc` 기반 키는 VC 재발급 시 계정이 갈라질 수 있으므로 기본 구현에서 자동 fallback하지 않는다. 데모에서 꼭 필요하면 별도의 명시적 정책으로 분리한다. CX와 Open DID의 계정은 자동 병합하지 않으며, 향후 병합에는 양쪽 계정 소유 증명이 필요하다.

## 5. 제안하는 VeraWallet API

아래는 **새 내부 API 설계안**이며 Verifier 원본 계약과 구분한다. 응답은 기존 `{data, meta}` envelope를 사용하고 `Cache-Control: no-store`를 설정한다.

### QR 발급

`POST /api/auth/did/offer`, body: `{country:"KR"}` (`KR|US|UK|DE`).

성공 HTTP 201:

```json
{
  "data": {
    "offerId": "<verifier-offer-id>",
    "qrPayload": {},
    "expiresAt": "<ISO-8601>",
    "pollAfterMs": 2000
  },
  "meta": {"provenance":"live", "generatedAt":"<ISO-8601>"}
}
```

`qrPayload`는 예시의 빈 객체 대신 실제 검증된 payload 전체를 보존한다. policyId와 Verifier URL은 클라이언트가 선택할 수 없다. BE가 서버 설정을 사용한다. 성공 시 인증 시도용 무작위 비밀 쿠키 `vw_did_attempt`를 HttpOnly·SameSite=Lax·운영 Secure로 발급한다. 쿠키를 QR이나 응답 JSON에 넣지 않는다.

### 결과 폴링

`POST /api/auth/did/present`, Open DID body: `{offerId, country}`. country는 기존 DTO 호환용으로 유지하되 발급 당시 저장값과 다르면 거부한다. cxToken과 offerId 동시 입력도 거부한다.

| 상황 | HTTP | data 또는 오류 코드 제안 | 세션 발급 |
|---|---|---|---|
| 아직 제출되지 않음 | 202 | `{status:"pending", retryAfterMs:2000}` | 없음 |
| 검증 성공 | 200 | 기존 `{countryCode, ruleset}` | 기존 `vw_access_token` 쿠키 |
| 잘못된 입력·country 불일치 | 400 | `invalid_verification_request` | 없음 |
| 시도 쿠키 누락·소유권 불일치·알 수 없는 offer | 401 | `invalid_verification_attempt` | 없음 |
| 명시적인 검증 거절·필수 클레임 부적합 | 401 | `identity_verification_failed` | 없음 |
| 이미 사용됨·동시 완료 처리 중 | 409 | `verification_consumed` / `verification_in_progress` | 없음 |
| 만료 | 410 | `verification_expired` | 없음 |
| 과도한 발급·폴링 | 429 | `verification_rate_limited` | 없음 |
| 상위 서버 장애·타임아웃·잘못된 응답 | 503 | `identity_provider_unavailable` | 없음 |

오류 envelope는 기존 HTTP exception filter 규약에 맞춘다. Open DID 성공은 명시적으로 HTTP 200을 지정한다. 기존 mock/CX 성공 응답과 상태 코드는 회귀 테스트로 유지한다. FE HTTP 클라이언트는 202를 성공 완료로 파싱하지 않고 별도 대기 타입으로 처리한다.

BE는 요청당 confirm 호출을 최대 한 번 수행하고 즉시 반환한다. FE가 기본 2초 간격으로 다음 요청을 보내며 중첩 호출을 막는다. 만료·이탈·성공 시 중지한다. 상위 오류는 제한된 backoff 후 재시도하고 만료를 넘기지 않는다.

## 6. 인증 시도와 중복 처리

offerId는 QR에서 보이므로 비밀 인증 수단이 아니다. BE는 **offerId + 발급 브라우저의 시도 쿠키**를 함께 검증한 뒤에만 confirm 및 세션 발급을 수행한다. 쿠키 인증을 사용하는 두 POST 경로에는 신뢰하는 Origin 검증을 적용한다.

초기 설계는 인증 시도 저장소 포트와 인메모리/Prisma 구현을 추가하는 것이다. `PERSISTENCE=prisma`에서는 공유 DB를 사용해 재시작과 다중 인스턴스를 지원한다. 실서비스에서는 인메모리 구현을 사용하지 않는다.

저장 필드 제안: 내부 attemptId, 고유 offerId, 쿠키 비밀의 해시, provider, policyId, country, expiresAt, status, 처리 lease 만료 시각, consumedAt. 원본 claims·VP·VC·JWT는 영속하지 않는다. 만료 시도 정리 작업과 최소 보존 기간을 정한다.

```text
pending → processing → consumed
             ├→ pending  (대기 또는 재시도 가능한 오류)
             ├→ rejected (명시적인 검증 실패)
             └→ expired
```

- DB 조건부 갱신으로 처리 lease를 획득한다. 외부 HTTP 호출 동안 DB 트랜잭션을 열어 두지 않는다.
- 유효기간은 Verifier 만료와 BE 상한 중 짧은 값이다. 기본 상한 제안은 5분이며 실서버 TTL 확인 후 고정한다.
- 성공 시 사용자 upsert·검증 이력·시도 소비를 하나의 DB 트랜잭션으로 묶도록 저장소 경계를 확장한다. 트랜잭션 성공 후 JWT와 쿠키를 전달한다.
- 동시 요청 중 하나만 완료할 수 있다. 대기·실패에서 upsert나 JWT 발급을 실행하지 않는다.
- 성공 직후 응답 유실 또는 프로세스 종료로 쿠키를 받지 못하면 새 QR로 다시 시도한다. 일회성 결과를 소모한 뒤 복구할 수 없는 상위 동작도 새 시도로 처리한다.
- 재발급 시 같은 브라우저의 이전 시도를 무효화한다. 초기 UX는 브라우저당 활성 시도 하나이며 다른 탭에서도 새 QR이 이전 시도를 대체한다.
- Open DID 모드에서는 기존 `/auth/verify/start`·`/auth/verify/callback`을 명시적으로 비활성화한다. offerId를 기존 callback token으로 보내 바인딩 없이 JWT를 받는 경로를 남기지 않는다.

## 7. 구현 단위와 순서

### 단계 0 — 외부 스택과 계약 확보

사용자가 전달한 준비 순서는 Java 21 → 오케스트레이터(9001) 엔티티 기동 → TA/Issuer/Verifier/CA/Wallet 등록·TA 승인 → VC 스키마 → 서비스·프로필·VP 정책 → did-ca-aos 설치 및 VC 발급이다. 세부 실행 명령은 사용하는 Open DID 버전에서 확인한다.

고유 클레임 code, 허용 issuer, policyId, request의 id 의미를 확정하고, 실폰으로 데모 제출 성공을 먼저 확보한다. 정상/대기/거절/만료 응답을 비식별 fixture로 보관한다. Verifier 접근용 BE 주소와 QR endpoints에 들어가는 모바일 접근 주소를 따로 확인한다. 폰에서 `localhost`나 `host.docker.internal`은 서버의 LAN 주소를 대신하지 못한다.

### 단계 1 — 타입·공급자·어댑터

- `VerifiedIdentity.method`에 `opendid` 추가.
- `VerificationRequest`를 공급자별 판별 유니온으로 정리해 QR payload와 offerId를 표현한다. Open DID용 가짜 verificationUrl을 만들지 않는다.
- `handleCallback` 결과는 `verified | pending | rejected | expired` 판별 유니온으로 확장하고 mock/CX 및 호출부를 함께 수정한다. 공급자 어댑터는 검증만, AuthService는 세션 발급을 담당한다.
- 새 `identity/opendid-verifier.adapter.ts`에 URL 조합·응답 런타임 검증·timeout·상태 매핑·클레임 추출을 모은다.
- `IDENTITY_PROVIDER=opendid` 선택 시 필요한 설정이 없으면 시작 단계에서 실패한다. mock으로 자동 전환하지 않는다.

### 단계 2 — 인증 시도·API·세션

- 인증 시도 저장소 및 Prisma 모델/마이그레이션 추가.
- offer DTO·present DTO, 공급자별 필수 입력 검증, 시도 쿠키 helper 추가.
- offer 발급과 confirm 오케스트레이션, lease·TTL·소비 처리를 구현.
- 기존 사용자/JWT 로직을 검증 완료 전용 메서드로 분리하고 원시 offerId로 호출하지 못하게 한다.
- 이전 auth 경로 차단, Origin 검증, 요청 제한, 원문 없는 로그를 구현.

### 단계 3 — FE 연결 작업

백엔드 API 완료 후 FE 저장소에서 별도 작업한다.

- `lib/ports/auth-client.ts`, `lib/adapters/http/auth-client.http.ts`: `requestDidOffer()` 및 pending 응답 타입·스키마 추가.
- `components/did/did-login-flow.tsx`: 실제 QR, 폴링, 만료·재발급·오류 표시.
- `app/login/page.tsx`, `lib/api-mode.ts`: health의 provider를 내려 명시적 분기. health 실패를 실인증 성공이나 mock 완료로 바꾸지 않는다.
- identity provenance는 공급자별 계산. Open DID는 CX mock 플래그에 종속시키지 않고, `MOCK_MODE=true`와 실신원 조합도 정확히 표시한다.
- `proxy.ts`: offer 경로를 두 BE 소유 목록에 추가하고 시도 쿠키 왕복 확인.
- FE 독립 mock용 `app/api/auth/did/offer/route.ts`를 만들되 실모드 장애 fallback으로 사용하지 않는다.

### 단계 4 — 통합 검증·운영 전환

fixtures → BE 통합 테스트 → FE 계약 테스트 → 실폰 QR E2E 순서로 진행한다. 실서버 정상 응답만으로 완료 처리하지 않고 아래 수용 기준을 충족한다.

## 8. 설정과 운영

BE의 `apps/backend/.env.example`에 문서화할 제안:

```dotenv
IDENTITY_PROVIDER=opendid
OPENDID_VERIFIER_URL=http://host.docker.internal:8092/verifier
OPENDID_POLICY_ID=<등록한 정책 ID>
OPENDID_SUBJECT_CLAIM_CODE=<재발급에도 유지되는 고유 클레임 code>
OPENDID_TRUSTED_ISSUER_ID=<허용 issuer 식별자>
OPENDID_HTTP_TIMEOUT_MS=10000
OPENDID_ATTEMPT_TTL_SECONDS=300
```

`id`가 등록 서비스 ID인 것으로 확인되면 별도 `OPENDID_SERVICE_ID`를 추가한다. 호스트에서 BE를 직접 실행할 때는 접근 가능한 localhost/LAN 주소를 사용한다. Docker Desktop에서 맥 호스트의 Verifier로 접근할 때 위 주소를 사용한다. 실제 프로세스 내부에서 연결을 확인한다.

관리 API는 런타임에 정책을 자동 선택하는 데 사용하지 않는다. 정책과 issuer 변경은 명시적 설정 변경이다. 외부 호출 자격증명이 필요하면 BE 전용 비밀 설정으로 추가한다. FE에 새 `NEXT_PUBLIC_*` 자격증명을 만들지 않는다.

관측 항목은 offer 발급/성공/실패/만료 수, 상위 호출 지연과 오류 코드다. 쿠키·JWT·원본 claims·VC·QR payload는 로그에 남기지 않는다. 추적에는 내부 attemptId를 사용한다.

롤백은 Open DID 신규 시도 발급을 중단하고 미완료 시도를 무효화한 뒤 이전 공급자 설정과 호환 FE로 복구한다. 기존 계정 데이터는 삭제하지 않는다. 이미 발급된 JWT는 현행 만료 정책을 따르며, 공급자 전환만으로 폐기되지 않는다는 점을 운영 기록에 남긴다.

## 9. 수용 기준과 테스트

| 검증 | 완료 기준 |
|---|---|
| URL·계약 | `/verifier`가 정확히 한 번 포함되고 요청 body 및 QR payload가 fixture와 일치 |
| 설정 | opendid 선택·health 표시 일치, 필수 설정 누락 시 시작 실패 |
| 대기 → 성공 | 202에서는 사용자/JWT/쿠키 없음, 200에서 기존 세션 조회·지갑 연결 가능 |
| 입력 검증 | offerId가 whitelist에서 보존되고 공급자별 필수값·배타 조건 검증 |
| 소유권 | 타 브라우저, 쿠키 없음, 다른 offerId, 위조 Origin으로 세션 발급 불가 |
| 동시성·재사용 | 동시 present 중 한 건만 완료, 소비된 offer 및 이전 auth 경로로 JWT 재발급 불가 |
| 장애·만료 | timeout·잘못된 JSON·상위 오류를 성공으로 취급하지 않음, TTL 후 만료 |
| 계정 안정성 | 동일 issuer+고유 클레임은 VC 재발급 후 같은 user, 다른 클레임/issuer는 다른 user |
| 클레임 검증 | 필수값 없음·중복·타입 오류·허용 외 issuer에서 인증 실패 |
| 저장소 | Prisma에서 두 인스턴스 간 lease/소비 원자성 검증, 재시작 후 미완료 시도 정책 확인 |
| 개인정보 | 응답·로그·영속 시도 데이터에 원문 신원정보가 남지 않음 |
| 회귀 | mock/CX 로그인, 쿠키, session, EVM 지갑 연결 동작 유지 |
| 실기기 | 폰에서 QR endpoints 접근, VP 제출, BE confirm, 로그인 완료를 하나의 시도로 확인 |

구현 후 BE 저장소에서 실행:

```sh
pnpm --filter @vera/interfaces test
pnpm --filter @vera/backend test
pnpm build
pnpm lint
```

새 마이그레이션은 격리 DB에 적용해 동시성·재시작 테스트를 수행한다. FE 연결 이후에는 해당 저장소의 auth 계약 테스트와 QR 흐름 E2E를 추가 실행한다. 이번 문서 작성에서는 런타임 테스트나 외부 스택 기동을 수행하지 않는다.

## 10. 구현 전 확정할 결정

1. Issuer가 보장하는 고유 클레임 code·값 타입·재발급 안정성 및 허용 issuer.
2. 실제 policyId, request의 id 의미, 미완료/실패/만료 응답 매핑.
3. QR 직렬화 방식과 폰이 접근할 서비스 endpoints.
4. 초기에는 거주국 자기 선택 유지. VC 기반 거주국을 도입하면 JWT·ruleset 모두 검증값을 사용하고 불일치 규칙을 별도 설계.

이 결정들은 문서 작성을 막지 않지만 실서버 어댑터의 최종 계약과 로그인 수용 테스트에는 필요하다.
