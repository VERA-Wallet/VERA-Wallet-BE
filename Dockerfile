# syntax=docker/dockerfile:1.7
# VeraWallet BE (NestJS + Prisma) 운영 이미지.
#
# 워크스페이스 전체(apps/backend, packages/interfaces, packages/tax-engine)를 한 번에 빌드한다.
# 최종 스테이지가 builder의 /app을 통째로(devDependencies 포함) 가져가는 이유:
#   - Prisma 클라이언트는 `prisma generate`가 node_modules/.pnpm/@prisma+client@…/ 안에 만든다. --prod 재설치를 하면
#     그 경로(peer 해시)가 달라져 생성물을 옮길 수 없고, prisma CLI(devDep)도 사라져 다시 만들 수도 없다.
#   - 기동 시 `prisma migrate deploy`를 돌리려면 어차피 CLI가 필요하다.
# 이미지가 커지지만(대략 1GB) 단일 머신 배포에서는 "재현 가능하고 깨지지 않는 쪽"을 택했다.

FROM node:22-bookworm-slim AS base
# Prisma 쿼리 엔진(debian-openssl-3.0.x)이 libssl을 요구한다. ca-certificates는 외부 API(Alchemy·CoinGecko·OmniOne) 호출용.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# packageManager 필드와 같은 버전으로 고정한다. corepack은 Node 25에서 빠질 예정이라 npm으로 설치한다.
RUN npm install -g pnpm@10.30.3
ENV CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1
WORKDIR /app

FROM base AS builder
# 매니페스트만 먼저 복사해 의존성 레이어를 소스 변경과 분리한다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/interfaces/package.json packages/interfaces/
COPY packages/tax-engine/package.json packages/tax-engine/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY . .
# 순서가 중요하다: backend의 @vera/* 런타임 import는 packages/*/dist를 본다(package.json main).
RUN pnpm --filter @vera/interfaces build \
 && pnpm --filter @vera/tax-engine build \
 && pnpm --filter @vera/backend prisma:generate \
 && pnpm --filter @vera/backend build

FROM base AS runner
# NODE_ENV는 일부러 여기서 정하지 않는다. auth-cookie.ts가 NODE_ENV=production일 때만 Secure 쿠키를 굽는데,
# http://<IP>:3100 같은 평문 배포에서 Secure가 켜지면 브라우저가 쿠키를 버려 로그인이 조용히 실패한다.
# compose의 BACKEND_NODE_ENV로 https 뒤에 둘 때만 production을 준다.
COPY --from=builder --chown=node:node /app /app
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
WORKDIR /app/apps/backend
EXPOSE 3200
ENTRYPOINT ["docker-entrypoint.sh"]
