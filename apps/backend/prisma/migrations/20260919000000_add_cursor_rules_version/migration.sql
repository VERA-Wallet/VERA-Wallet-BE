-- 커서가 어느 정규화 규칙 버전으로 걸었는지 기록한다. 기존 행은 0 = "규칙 버전을 모름"이라
-- 다음 동기화가 그 체인을 처음부터 다시 걷고 현재 버전을 찍는다.
ALTER TABLE "BindingChainCursor" ADD COLUMN "rulesVersion" INTEGER NOT NULL DEFAULT 0;
