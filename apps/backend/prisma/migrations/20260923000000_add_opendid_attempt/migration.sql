CREATE TABLE "OpenDidAttempt" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "leaseToken" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextPollAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpenDidAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OpenDidAttempt_offerId_key" ON "OpenDidAttempt"("offerId");
CREATE INDEX "OpenDidAttempt_expiresAt_idx" ON "OpenDidAttempt"("expiresAt");
CREATE INDEX "OpenDidAttempt_secretHash_idx" ON "OpenDidAttempt"("secretHash");
