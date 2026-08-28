-- watch_only bindings have no signature, so bindingHash becomes nullable.
ALTER TABLE "WalletBinding" ALTER COLUMN "bindingHash" DROP NOT NULL;

-- verifiedAt marks a signature-verified binding (null for watch_only).
ALTER TABLE "WalletBinding" ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- verificationMethod added without a default on purpose: a silent 'siwe' default
-- could mark an unverified binding as verified. Existing rows were all SIWE-bound,
-- so backfill explicitly, then enforce NOT NULL.
ALTER TABLE "WalletBinding" ADD COLUMN "verificationMethod" TEXT;
UPDATE "WalletBinding" SET "verificationMethod" = 'siwe', "verifiedAt" = "boundAt" WHERE "verificationMethod" IS NULL;
ALTER TABLE "WalletBinding" ALTER COLUMN "verificationMethod" SET NOT NULL;
