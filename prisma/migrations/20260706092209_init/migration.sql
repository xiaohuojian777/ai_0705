-- CreateTable
CREATE TABLE "UserAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL
);

-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "FeeType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feeCode" TEXT NOT NULL,
    "feeName" TEXT NOT NULL,
    "businessDomain" TEXT NOT NULL,
    "quoteTypes" JSONB NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP NOT NULL
);

-- CreateTable
CREATE TABLE "FeeTypeOperationLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "feeTypeId" TEXT,
    "feeCode" TEXT NOT NULL,
    "feeName" TEXT NOT NULL,
    "operationType" TEXT NOT NULL,
    "operatorName" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UniversalImportRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fingerprint" TEXT NOT NULL,
    "ruleName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "mapping" JSONB NOT NULL,
    "ruleDsl" JSONB,
    "sampleMeta" JSONB,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL
);

-- CreateTable
CREATE TABLE "UniversalImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchName" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "sourceSheetName" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "totalRows" INTEGER NOT NULL,
    "successRows" INTEGER NOT NULL,
    "failedRows" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "parseSummary" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,
    CONSTRAINT "UniversalImportBatch_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "UniversalImportRule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UniversalImportShipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "batchId" TEXT NOT NULL,
    "externalCode" TEXT NOT NULL,
    "receiverStore" TEXT,
    "receiverName" TEXT,
    "receiverPhone" TEXT,
    "receiverAddress" TEXT,
    "note" TEXT,
    "sourceRowCount" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UniversalImportShipment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UniversalImportBatch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UniversalImportShipmentReceiverGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shipmentId" TEXT NOT NULL,
    "receiverStore" TEXT,
    "receiverName" TEXT,
    "receiverPhone" TEXT,
    "receiverAddress" TEXT,
    "note" TEXT,
    "sourceRowCount" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UniversalImportShipmentReceiverGroup_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "UniversalImportShipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UniversalImportShipmentItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shipmentId" TEXT NOT NULL,
    "receiverGroupId" TEXT,
    "sourceRowIndex" INTEGER NOT NULL,
    "skuCode" TEXT NOT NULL,
    "skuName" TEXT NOT NULL,
    "skuQuantity" DOUBLE PRECISION NOT NULL,
    "skuSpec" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UniversalImportShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "UniversalImportShipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UniversalImportShipmentItem_receiverGroupId_fkey" FOREIGN KEY ("receiverGroupId") REFERENCES "UniversalImportShipmentReceiverGroup" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UserAccount_username_key" ON "UserAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "FeeType_feeCode_key" ON "FeeType"("feeCode");

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
CREATE INDEX "UniversalImportShipmentReceiverGroup_shipmentId_idx" ON "UniversalImportShipmentReceiverGroup"("shipmentId");

-- CreateIndex
CREATE INDEX "UniversalImportShipmentReceiverGroup_receiverName_idx" ON "UniversalImportShipmentReceiverGroup"("receiverName");

-- CreateIndex
CREATE INDEX "UniversalImportShipmentItem_shipmentId_idx" ON "UniversalImportShipmentItem"("shipmentId");

-- CreateIndex
CREATE INDEX "UniversalImportShipmentItem_receiverGroupId_idx" ON "UniversalImportShipmentItem"("receiverGroupId");
