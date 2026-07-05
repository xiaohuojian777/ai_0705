-- DropForeignKey
ALTER TABLE "UniversalImportRecord" DROP CONSTRAINT "UniversalImportRecord_batchId_fkey";

-- DropTable
DROP TABLE "UniversalImportRecord";

-- DropTable
DROP TABLE "UniversalImportTemplate";

-- DropTable
DROP TABLE "UniversalImportBatch";

-- CreateTable
CREATE TABLE "UniversalImportRule" (
    "id" TEXT NOT NULL,
    "fingerprint" VARCHAR(512) NOT NULL,
    "ruleName" VARCHAR(64) NOT NULL,
    "fileType" VARCHAR(16) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" VARCHAR(16) NOT NULL,
    "mapping" JSONB NOT NULL,
    "sampleMeta" JSONB,
    "createdBy" VARCHAR(32) NOT NULL,
    "updatedBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalImportRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalImportBatch" (
    "id" TEXT NOT NULL,
    "batchName" VARCHAR(64) NOT NULL,
    "originalFileName" VARCHAR(128) NOT NULL,
    "sourceSheetName" VARCHAR(64) NOT NULL,
    "fileType" VARCHAR(16) NOT NULL,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "totalRows" INTEGER NOT NULL,
    "successRows" INTEGER NOT NULL,
    "failedRows" INTEGER NOT NULL,
    "status" VARCHAR(24) NOT NULL,
    "parseSummary" JSONB,
    "createdBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UniversalImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalImportShipment" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "externalCode" VARCHAR(64) NOT NULL,
    "receiverStore" VARCHAR(128),
    "receiverName" VARCHAR(64),
    "receiverPhone" VARCHAR(32),
    "receiverAddress" VARCHAR(256),
    "note" VARCHAR(256),
    "sourceRowCount" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniversalImportShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UniversalImportShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sourceRowIndex" INTEGER NOT NULL,
    "skuCode" VARCHAR(64) NOT NULL,
    "skuName" VARCHAR(128) NOT NULL,
    "skuQuantity" INTEGER NOT NULL,
    "skuSpec" VARCHAR(128),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniversalImportShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UniversalImportRule_fingerprint_key" ON "UniversalImportRule"("fingerprint");

-- CreateIndex
CREATE INDEX "UniversalImportBatch_createdAt_idx" ON "UniversalImportBatch"("createdAt");

-- CreateIndex
CREATE INDEX "UniversalImportBatch_ruleId_idx" ON "UniversalImportBatch"("ruleId");

-- CreateIndex
CREATE INDEX "UniversalImportShipment_batchId_idx" ON "UniversalImportShipment"("batchId");

-- CreateIndex
CREATE INDEX "UniversalImportShipment_externalCode_idx" ON "UniversalImportShipment"("externalCode");

-- CreateIndex
CREATE INDEX "UniversalImportShipment_receiverName_idx" ON "UniversalImportShipment"("receiverName");

-- CreateIndex
CREATE INDEX "UniversalImportShipmentItem_shipmentId_idx" ON "UniversalImportShipmentItem"("shipmentId");

-- AddForeignKey
ALTER TABLE "UniversalImportBatch" ADD CONSTRAINT "UniversalImportBatch_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "UniversalImportRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UniversalImportShipment" ADD CONSTRAINT "UniversalImportShipment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UniversalImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UniversalImportShipmentItem" ADD CONSTRAINT "UniversalImportShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "UniversalImportShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
