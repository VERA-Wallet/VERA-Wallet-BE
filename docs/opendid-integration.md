# Open DID 백엔드 연결

이 브랜치는 QR 발급 → 브라우저에 묶인 검증 시도 → 결과 조회 → 기존 사용자/JWT/쿠키 발급을 구현한다. FE QR 화면과 프록시 연결, Open DID 스택 설치는 별도 작업이다. 실제 휴대폰 제출은 아직 검증하지 않았다.

## 확인한 upstream 계약

확인 기준: [OmniOneID/did-verifier-server, bd2e9ac](https://github.com/OmniOneID/did-verifier-server/tree/bd2e9ac8e0c52c7d0a19efc009f74044f8f1ed7c), 2026-09-23.

- [Verifier API](https://github.com/OmniOneID/did-verifier-server/blob/bd2e9ac8e0c52c7d0a19efc009f74044f8f1ed7c/docs/api/Verifier_API.md): 발급의 `id`는 메시지 ID다. BE가 UUID를 생성한다. 요청에는 서버 설정의 policyId만 사용한다.
- [VerifierServiceImpl](https://github.com/OmniOneID/did-verifier-server/blob/bd2e9ac8e0c52c7d0a19efc009f74044f8f1ed7c/source/did-verifier-server/src/main/java/org/omnione/did/verifier/v1/agent/service/VerifierServiceImpl.java): `requestVerify`는 VP 검증 후 제출 결과를 저장한다. `confirmVerify`는 저장된 제출이 없으면 `result:false`, 있으면 claims를 반환한다. 성공 조회가 결과를 소비하지 않는다.
- DTO에는 `vc`, `issuer`가 있지만 위 구현의 성공 builder는 두 필드를 채우지 않는다. holder DID도 반환하지 않는다. claims는 제출된 VC들의 클레임을 합친 목록이므로 식별 클레임이 중복되면 거부한다.
- 만료는 BE가 QR의 `validUntil`과 BE 상한 중 짧은 값으로 강제한다. 공식 confirm 경로는 미제출과 사용자 취소를 구분하지 않으므로 취소는 만료까지 pending으로 보일 수 있다.

어댑터 테스트의 데이터는 위 코드에서 유도한 합성 fixture이며 실폰 캡처가 아니다. `VerifyOffer`만 지원하고 ZKP `VerifyProofOffer`는 거부한다.

## 설정

`apps/backend/.env.example`의 Open DID 항목을 참고한다. 로컬 `.env`는 이 작업에서 변경하지 않았다.

```dotenv
IDENTITY_PROVIDER=opendid
MOCK_MODE=true
PERSISTENCE=prisma
FRONTEND_ORIGIN=http://localhost:3101
OPENDID_VERIFIER_URL=http://localhost:8092/verifier
OPENDID_POLICY_ID=<등록한 VP 정책>
OPENDID_SUBJECT_CLAIM_CODE=<issuer가 보장하는 불투명 고유 클레임>
OPENDID_TRUSTED_ISSUER_ID=<허용 issuer DID>
OPENDID_ISSUER_BINDING=response
OPENDID_HTTP_TIMEOUT_MS=10000
OPENDID_ATTEMPT_TTL_SECONDS=300
```

별도로 최소 32자 JWT_SECRET이 필요하다. 운영(`NODE_ENV=production`)은 Prisma 저장소가 필수다. 개발·테스트에서는 memory 저장소를 사용할 수 있지만 재시작 시 시도가 사라진다. 다른 데이터 공급자는 MOCK_MODE 설정을 계속 따른다.

Verifier 주소는 `/verifier`로 끝나야 한다. Docker Desktop에서 호스트의 Verifier를 부를 때 `host.docker.internal`을 사용한다. QR payload의 endpoints는 휴대폰에서 접근할 수 있는 주소여야 한다. BE가 endpoints를 임의로 바꾸지 않는다.

### issuer가 빠지는 공식 서버와 연결할 때

기본 `response` 모드는 confirm 결과에 정확한 issuer가 없으면 로그인에 실패한다. 이는 의도한 동작이다. 공식 develop을 그대로 사용하려면 다음 조건을 **실제 정책과 부정 테스트로 먼저 확인**해야 한다.

1. 정책이 허용 issuer와 VC 스키마를 제한한다.
2. 고유 클레임은 Issuer가 정하며 사용자가 임의로 지정할 수 없다. VC 재발급에도 동일하다.
3. 다른 issuer의 VC로 제출하면 Verifier가 거부한다. 여러 VC에서 같은 고유 클레임을 반환하지 않는다.

이 조건을 확인한 환경에서만 다음 두 값을 함께 설정한다.

```dotenv
OPENDID_ISSUER_BINDING=policy
OPENDID_POLICY_ISSUER_RESTRICTION_CONFIRMED=true
```

policy 모드는 누락된 issuer를 응답에서 검증한 것처럼 취급하지 않는다. 운영자가 확인한 Verifier 정책을 신뢰 경계로 사용하고 계정 해시에 설정의 issuer를 포함한다. 응답에 issuer가 실제로 있다면 이 모드에서도 설정과 불일치하면 거부한다. 이 저장소에서 외부 정책 강제 여부를 검증한 것은 아니므로 확인 전에는 기본값을 유지한다. 대안은 Verifier 응답을 수정해 고유 클레임의 실제 issuer를 반환하도록 하는 것이다.

계정 해시는 `SHA-256(JSON.stringify(["opendid","v1",issuer,claimCode,value]))`의 0x 접두어 hex다. 클레임은 정확히 하나의 비어 있지 않은 `text/plain`, `hideValue:false` 문자열이어야 한다. 이름·생년월일·VC ID fallback이나 CX 계정 자동 병합은 없다.

## DB와 실행

대상 환경의 DATABASE_URL을 확인한 뒤 적용한다.

```sh
pnpm prisma:generate
pnpm --filter @vera/backend exec prisma migrate deploy
pnpm build
```

`OpenDidAttempt` 테이블을 추가한다. 기존 사용자 테이블의 데이터 변환은 없다. 시도에는 offerId·쿠키 비밀의 해시·정책·국가·상태·TTL·lease만 저장한다. VP, claims, JWT는 저장하지 않는다. 1분 주기로 만료 후 1분 지난 시도를 정리한다.

완료 처리는 lease token으로 오래된 worker를 차단하고, 시도 소비·사용자 upsert·검증 이력을 하나의 DB 트랜잭션으로 반영한다. 완료 응답이 유실되면 새 QR로 다시 시도한다. 이미 소비된 offer로 JWT를 재발급하지 않는다.

## FE 계약

두 경로 모두 `Origin`이 FRONTEND_ORIGIN과 정확히 같아야 한다. 브라우저 쿠키를 유지하고 응답을 캐시하지 않는다. 사용자가 선택한 country는 신원 클레임으로 검증된 값이 아니다.

1. `POST /api/auth/did/offer`, `{country:"KR"}` → 201 `{data:{offerId,qrPayload,expiresAt,pollAfterMs},meta}`. HttpOnly `vw_did_attempt` 쿠키를 설정한다. QR에는 qrPayload를 직렬화한다. 실제 지갑 직렬화 호환성은 실기기 테스트가 남아 있다.
2. `POST /api/auth/did/present`, `{country:"KR",offerId}` → 미제출 시 202 `{data:{status:"pending",retryAfterMs:2000},meta}`. 기본 2초 간격으로 한 번씩 요청한다.
3. 성공 시 200 `{data:{countryCode,ruleset},meta}`와 기존 `vw_access_token` 쿠키. FE는 `/api/auth/session`으로 로그인 상태를 조회한다.

두 응답의 meta.provenance는 다른 데이터 공급자의 MOCK_MODE와 독립적으로 live다. 성공 전에는 JWT나 사용자 계정을 생성하지 않는다. `/auth/verify/start`와 `/auth/verify/callback`은 opendid 모드에서 401이다. mock/CX의 기존 경로는 유지한다.

| 응답 | FE 처리 |
|---|---|
| 400 | 입력 수정; country 변경 시 새 offer 발급 |
| 401 | 검증 실패 또는 시도 쿠키 불일치; 새 시도 안내 |
| 403 | Origin/프록시 설정 확인 |
| 409 | 동시 요청은 진행 중인 요청을 기다림; consumed는 새 offer |
| 410 | 만료, 재발급 |
| 429 | 폴링은 Retry-After를 따름; 발급 제한은 잠시 후 재시도 |
| 503 | 공급자 장애 또는 잘못된 응답, 만료 전 제한적 재시도 |

폴링 제한은 DB 시도 단위로 공유된다. 발급 제한은 프로세스별 직접 연결 IP당 분당 10회다. 프록시 뒤에서는 프록시의 IP를 공유하므로 실제 운영 전 trusted proxy/edge rate limit을 별도 설계해야 한다. 위조 가능한 X-Forwarded-For를 무조건 신뢰하지 않는다.

새 QR은 기존 시도 쿠키가 가리키는 미완료 시도를 무효화한다. FE는 발급 요청도 직렬화해야 한다. 동시에 발급하면 마지막 응답 쿠키만 브라우저에 남을 수 있다. 다른 탭에서 재발급한 경우 이전 화면은 새 시도를 시작해야 한다.

FE 저장소에서 필요한 작업은 `requestDidOffer`·202 파싱, 실제 QR/폴링 UI, proxy의 offer 경로 추가, `/health.identityProvider` 기반 모드와 provenance 표시다. 이 백엔드 브랜치는 FE 파일을 변경하지 않는다.

## 검증

```sh
pnpm test
pnpm build
pnpm lint
# 별도로 띄운 전용 DB에 마이그레이션 적용 후:
OPENDID_TEST_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:<port>/vera_opendid_test \
  pnpm --filter @vera/backend exec vitest run test/opendid-postgres.spec.ts
```

Postgres 테스트는 별도 URL이 없으면 skip하며 DB 이름이 `vera_opendid_test`인지 검사한다. 개발 DATABASE_URL로 마이그레이션/정리 작업을 실행하지 않는다.

검증 범위: 어댑터 응답·issuer/클레임 검증, HTTP cookie/session 흐름, 대기→성공, 다른 브라우저 차단, country/DTO, legacy 우회 차단, 동시 요청·재사용, 만료·잘못된 응답, 발급 제한, 실제 Postgres 두 클라이언트의 lease·완료 원자성·실패 롤백.

배포 전 남은 항목: 실제 VP 정책의 issuer/schema 제한과 고유 클레임 확인, 폰 접근 endpoints 및 QR 직렬화, 실폰 VC 발급/VP 제출, FE 연동, 운영 프록시 발급 제한. 공급자 설정 전환은 기존 JWT를 자동 폐기하지 않는다.

2026-09-23 실행 결과: 전체 576개 테스트 통과(backend 523, interfaces 1, tax-engine 52; 전용 Postgres 테스트 3개 포함), build/lint 통과. 마지막 요청 제한 응답 수정 후 Open DID 24개 테스트와 build/lint 재확인. 임시 DB는 종료·제거했으며 개발/운영 DB와 실제 .env는 변경하지 않았다.
