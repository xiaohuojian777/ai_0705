-- Preserve per-row receiver details when one imported shipment contains multiple receiver groups.
CREATE TABLE "UniversalImportShipmentReceiverGroup" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "receiverStore" VARCHAR(128),
    "receiverName" VARCHAR(64),
    "receiverPhone" VARCHAR(32),
    "receiverAddress" VARCHAR(256),
    "note" VARCHAR(256),
    "sourceRowCount" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UniversalImportShipmentReceiverGroup_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "UniversalImportShipmentItem"
ADD COLUMN "receiverGroupId" TEXT;

CREATE INDEX "UniversalImportShipmentReceiverGroup_shipmentId_idx"
ON "UniversalImportShipmentReceiverGroup"("shipmentId");

CREATE INDEX "UniversalImportShipmentReceiverGroup_receiverName_idx"
ON "UniversalImportShipmentReceiverGroup"("receiverName");

CREATE INDEX "UniversalImportShipmentItem_receiverGroupId_idx"
ON "UniversalImportShipmentItem"("receiverGroupId");

ALTER TABLE "UniversalImportShipmentReceiverGroup"
ADD CONSTRAINT "UniversalImportShipmentReceiverGroup_shipmentId_fkey"
FOREIGN KEY ("shipmentId") REFERENCES "UniversalImportShipment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UniversalImportShipmentItem"
ADD CONSTRAINT "UniversalImportShipmentItem_receiverGroupId_fkey"
FOREIGN KEY ("receiverGroupId") REFERENCES "UniversalImportShipmentReceiverGroup"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
