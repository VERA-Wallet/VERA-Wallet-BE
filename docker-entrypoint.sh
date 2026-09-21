#!/bin/sh
# BE 컨테이너 진입점. Prisma를 쓰는 구성이면 스키마를 먼저 맞추고 서버를 띄운다.
#
# 판정은 src/shared/persistence-mode.ts와 같아야 한다:
#   PERSISTENCE가 있으면 그 값이 "prisma"일 때만, 없으면 MOCK_MODE != "true"일 때 Prisma를 쓴다.
# 여기서 어긋나면 "서버는 Prisma로 도는데 마이그레이션은 안 돈" 상태가 되어 첫 쿼리에서 P2021(테이블 없음)로 죽는다.
set -eu

use_prisma=false
if [ -n "${PERSISTENCE:-}" ]; then
  [ "$PERSISTENCE" = "prisma" ] && use_prisma=true
elif [ "${MOCK_MODE:-true}" != "true" ]; then
  use_prisma=true
fi

if [ "$use_prisma" = true ]; then
  echo "[entrypoint] Prisma persistence: applying migrations (prisma migrate deploy)"
  ./node_modules/.bin/prisma migrate deploy
else
  echo "[entrypoint] in-memory persistence: skipping migrations"
fi

exec node dist/main.js
