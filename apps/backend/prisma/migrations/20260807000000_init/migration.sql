CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE "User" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "didHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "IdentityVerification" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "IdentityVerification_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "VerifiableCredential" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "verificationId" TEXT NOT NULL,
  "vcType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  CONSTRAINT "VerifiableCredential_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WalletBinding" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "bindingHash" TEXT NOT NULL,
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletBinding_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TransactionRaw" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "source" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TransactionRaw_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TransactionNormalized" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "bindingId" TEXT NOT NULL,
  "txHash" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "chain" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TransactionNormalized_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TaxEvent" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "txId" TEXT NOT NULL,
  "reportId" TEXT,
  "countryCode" TEXT NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "gainLoss" DECIMAL(65,30) NOT NULL,
  "isEstimate" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "TaxEvent_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TaxReport" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "userId" TEXT NOT NULL,
  "period" TEXT NOT NULL,
  "countryCode" TEXT NOT NULL,
  "totalGain" DECIMAL(65,30) NOT NULL,
  "status" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TaxReport_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "AnchorRecord" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "payloadHash" TEXT NOT NULL,
  "anchorType" TEXT NOT NULL,
  "chainTxHash" TEXT,
  "blockNumber" BIGINT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "anchoredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnchorRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_didHash_key" ON "User"("didHash");
CREATE UNIQUE INDEX "VerifiableCredential_verificationId_key" ON "VerifiableCredential"("verificationId");
CREATE UNIQUE INDEX "WalletBinding_bindingHash_key" ON "WalletBinding"("bindingHash");
CREATE UNIQUE INDEX "WalletBinding_userId_walletAddress_key" ON "WalletBinding"("userId", "walletAddress");
CREATE INDEX "WalletBinding_walletAddress_idx" ON "WalletBinding"("walletAddress");
CREATE UNIQUE INDEX "TransactionNormalized_bindingId_txHash_eventType_key" ON "TransactionNormalized"("bindingId", "txHash", "eventType");
CREATE INDEX "TransactionNormalized_bindingId_occurredAt_idx" ON "TransactionNormalized"("bindingId", "occurredAt");
CREATE INDEX "TaxEvent_reportId_idx" ON "TaxEvent"("reportId");
CREATE INDEX "TaxEvent_countryCode_ruleVersion_idx" ON "TaxEvent"("countryCode", "ruleVersion");
CREATE UNIQUE INDEX "AnchorRecord_payloadHash_key" ON "AnchorRecord"("payloadHash");
CREATE INDEX "AnchorRecord_status_idx" ON "AnchorRecord"("status");
ALTER TABLE "IdentityVerification" ADD CONSTRAINT "IdentityVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VerifiableCredential" ADD CONSTRAINT "VerifiableCredential_verificationId_fkey" FOREIGN KEY ("verificationId") REFERENCES "IdentityVerification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "WalletBinding" ADD CONSTRAINT "WalletBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransactionNormalized" ADD CONSTRAINT "TransactionNormalized_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "WalletBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxEvent" ADD CONSTRAINT "TaxEvent_txId_fkey" FOREIGN KEY ("txId") REFERENCES "TransactionNormalized"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaxEvent" ADD CONSTRAINT "TaxEvent_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "TaxReport"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TaxReport" ADD CONSTRAINT "TaxReport_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
