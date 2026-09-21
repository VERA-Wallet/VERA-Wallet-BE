-- 계산 근거 정본. 체인에는 merkleRoot만 올라가고, 그 루트가 덮는 잎(건별 판정)은 여기 남는다.
-- 같은 근거를 다시 기록해도 행은 하나다 — 앵커가 payloadHash 기준으로 이미 멱등이라 같은 규칙을 맞춘다.
CREATE TABLE "TaxEvidence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "merkleRoot" TEXT NOT NULL,
    "leafCount" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxEvidence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TaxEvidence_userId_merkleRoot_key" ON "TaxEvidence"("userId", "merkleRoot");
CREATE INDEX "TaxEvidence_userId_countryCode_taxYear_idx" ON "TaxEvidence"("userId", "countryCode", "taxYear");

ALTER TABLE "TaxEvidence" ADD CONSTRAINT "TaxEvidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
