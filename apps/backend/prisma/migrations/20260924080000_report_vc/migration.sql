-- CreateTable
CREATE TABLE "ReportVcWallet" (
    "userId" TEXT NOT NULL,
    "holderDid" TEXT NOT NULL,
    "cxVerifiedAt" TIMESTAMP(3) NOT NULL,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportVcWallet_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "ReportVcAttempt" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "secretHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "upstreamId" TEXT,
    "idempotencyKey" TEXT,
    "requestHash" TEXT,
    "holderDid" TEXT,
    "evidenceRoot" TEXT,
    "snapshot" JSONB,
    "offer" JSONB,
    "result" JSONB,
    "disclosure" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nextPollAt" TIMESTAMP(3) NOT NULL,
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportVcAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportVcCredential" (
    "id" TEXT NOT NULL,
    "issuanceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "holderDid" TEXT NOT NULL,
    "evidenceRoot" TEXT NOT NULL,
    "countryCode" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportVcCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReportVcWallet_holderDid_key" ON "ReportVcWallet"("holderDid");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVcAttempt_upstreamId_key" ON "ReportVcAttempt"("upstreamId");

-- CreateIndex
CREATE INDEX "ReportVcAttempt_userId_purpose_status_idx" ON "ReportVcAttempt"("userId", "purpose", "status");

-- CreateIndex
CREATE INDEX "ReportVcAttempt_expiresAt_idx" ON "ReportVcAttempt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVcAttempt_userId_idempotencyKey_key" ON "ReportVcAttempt"("userId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ReportVcCredential_issuanceId_key" ON "ReportVcCredential"("issuanceId");

-- CreateIndex
CREATE INDEX "ReportVcCredential_userId_countryCode_taxYear_issuedAt_idx" ON "ReportVcCredential"("userId", "countryCode", "taxYear", "issuedAt");

