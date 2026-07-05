-- CreateTable
CREATE TABLE "UniversalImportTemplate" (
    "id" TEXT NOT NULL,
    "fingerprint" VARCHAR(512) NOT NULL,
    "templateName" VARCHAR(64) NOT NULL,
    "mapping" JSONB NOT NULL,
    "createdBy" VARCHAR(32) NOT NULL,
    "updatedBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalImportTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalImportBatch" (
    "id" TEXT NOT NULL,
    "batchName" VARCHAR(64) NOT NULL,
    "originalFileName" VARCHAR(128) NOT NULL,
    "sheetName" VARCHAR(64) NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "successRows" INTEGER NOT NULL,
    "failedRows" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "createdBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalImportRecord" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "externalCode" VARCHAR(64),
    "senderName" VARCHAR(64) NOT NULL,
    "senderPhone" VARCHAR(32) NOT NULL,
    "senderAddress" VARCHAR(128) NOT NULL,
    "receiverName" VARCHAR(64) NOT NULL,
    "receiverPhone" VARCHAR(32) NOT NULL,
    "receiverAddress" VARCHAR(128) NOT NULL,
    "weight" DECIMAL(10,2) NOT NULL,
    "pieces" INTEGER NOT NULL,
    "temperature" VARCHAR(16) NOT NULL,
    "note" VARCHAR(256),
    "rowIndex" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniversalImportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UniversalImportTemplate_fingerprint_key" ON "UniversalImportTemplate"("fingerprint");

-- CreateIndex
CREATE INDEX "UniversalImportBatch_createdAt_idx" ON "UniversalImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "UniversalImportRecord_batchId_idx" ON "UniversalImportRecord"("batchId");

-- CreateIndex
CREATE INDEX "UniversalImportRecord_externalCode_idx" ON "UniversalImportRecord"("externalCode");

-- CreateIndex
CREATE INDEX "UniversalImportRecord_receiverName_idx" ON "UniversalImportRecord"("receiverName");

-- AddForeignKey
ALTER TABLE "UniversalImportRecord" ADD CONSTRAINT "UniversalImportRecord_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UniversalImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
