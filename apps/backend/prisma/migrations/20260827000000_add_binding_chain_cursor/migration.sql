-- AlterTable
ALTER TABLE "WalletBinding" ADD COLUMN "initialSyncedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "BindingChainCursor" (
    "id" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "lastSyncedBlock" BIGINT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BindingChainCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BindingChainCursor_bindingId_chainId_key" ON "BindingChainCursor"("bindingId", "chainId");

-- CreateIndex
CREATE INDEX "BindingChainCursor_bindingId_idx" ON "BindingChainCursor"("bindingId");

-- AddForeignKey
ALTER TABLE "BindingChainCursor" ADD CONSTRAINT "BindingChainCursor_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "WalletBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
