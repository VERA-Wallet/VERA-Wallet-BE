# VeraWallet-BE

VERA Wallet의 NestJS 백엔드입니다. 서버는 개인키를 생성하거나 저장하지 않으며, 지갑 소유권은 5분짜리 challenge와 `personal_sign`/SIWE 서명으로만 검증합니다. 사용자 식별 정보와 지갑 주소는 PostgreSQL에만 저장되고 OmniOne Chain에는 `binding`, `rule_version`, `audit` 해시만 전달됩니다. `AnchorRecord`에는 의도적으로 사용자 FK가 없습니다.

## 구성

- `apps/backend`: NestJS API, Prisma/PostgreSQL, Bull/Redis 어댑터
- `packages/interfaces`: OmniOne CX/Chain과 인덱서 포트
- `packages/tax-engine`: NestJS에 의존하지 않는 순수 TypeScript 계산 패키지
- `MOCK_MODE=true`: 외부 시스템과 DB/Redis 없이 전체 데모 흐름 실행
- `MOCK_MODE=false`: Prisma/PostgreSQL과 Bull/Redis 사용. OmniOne Chain 앵커는 `ANCHOR_PRIVATE_KEY`(필수)와 `OMNIONE_API_KEY`가 설정되면 실제 트랜잭션을 전송하고, 키가 없으면 503을 반환합니다. `ANCHOR_CONTRACT_ADDRESS`를 지정하면 앵커 컨트랙트의 `anchor(bytes32,string)`을 호출하고, 비워두면 자기 주소로 payloadHash+type을 calldata에 담은 트랜잭션을 보냅니다. OmniOne CX/Alchemy는 여전히 공급자 최종 명세를 기다리는 503 뼈대입니다.

내부 의존성 방향과 SOLID 경계는 [docs/architecture.md](docs/architecture.md)에 정리되어 있으며 아키텍처 테스트로 강제됩니다. FE 연동 담당자는 [docs/frontend-integration.md](docs/frontend-integration.md)를 먼저 확인하십시오.

## 로컬 실행

```bash
cp apps/backend/.env.example apps/backend/.env
pnpm install
pnpm prisma:generate
pnpm dev
```

Mock 서버는 기본적으로 `http://localhost:3200`에서 실행됩니다.

PostgreSQL/Redis 경로를 확인하려면:

```bash
docker compose up -d
# .env에서 MOCK_MODE=false로 변경한 뒤
pnpm prisma:migrate
pnpm dev
```

실모드에서는 32자 이상의 `JWT_SECRET`이 필수입니다. `OMNIONE_API_KEY`, `ANCHOR_PRIVATE_KEY`, `ALCHEMY_API_KEY`는 `.env`로만 주입하고 로그에 남기지 마십시오.

## 검증

```bash
pnpm test
pnpm lint
pnpm build
```

e2e 테스트는 `본인확인 → challenge → personal_sign 검증 → 바인딩 앵커 → 인덱싱 → 세금 계산 → 신고서 확정 → 공개 앵커 조회`를 `MOCK_MODE=true`에서 한 번에 검증합니다.

## API

핵심 API는 다음과 같습니다.

- `POST /auth/verify/start`, `POST /auth/verify/callback`
- `POST /wallet/bind/challenge`, `POST /wallet/bind`
- `POST /indexer/sync`
- `GET /tax/events`, `POST /tax/calculate`
- `GET /reports/:id`, `POST /reports/:id/finalize`
- `GET /anchors/:payloadHash` (공개)

인증 API가 반환한 JWT를 `Authorization: Bearer <token>`으로 전달합니다. 프론트 호환 계층은 기존 `VeraWallet-FE` DTO에 맞춰 `/api/auth/*`, `/api/events*`, `/api/tax/*`, `/api/rulesets`, `/api/anchor-proof`도 제공합니다. 브라우저 연결 시 `next.config.ts` rewrite 또는 reverse proxy로 `/api/*`를 이 서버에 전달하고, 쿠키 인증을 쓸 때는 `FRONTEND_ORIGIN`/`SIWE_TRUSTED_ORIGIN`을 실제 프론트 origin으로 지정하십시오.

모든 세금 계산·이벤트·신고서 응답에는 `isEstimate: true`와 한국어 disclaimer가 포함됩니다. 숫자는 JSON number가 아닌 decimal 문자열로 전송되어 정밀도를 보존합니다.
