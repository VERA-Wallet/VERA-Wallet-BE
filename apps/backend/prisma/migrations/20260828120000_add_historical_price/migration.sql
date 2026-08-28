-- CreateTable
CREATE TABLE "HistoricalPrice" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "assetKey" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "krw" DECIMAL(65,30) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HistoricalPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalPrice_chainId_assetKey_date_key" ON "HistoricalPrice"("chainId", "assetKey", "date");
