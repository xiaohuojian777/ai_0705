-- CreateTable
CREATE TABLE "FeeTypeOperationLog" (
    "id" TEXT NOT NULL,
    "feeTypeId" VARCHAR(32),
    "feeCode" VARCHAR(8) NOT NULL,
    "feeName" VARCHAR(32) NOT NULL,
    "operationType" VARCHAR(16) NOT NULL,
    "operatorName" VARCHAR(32) NOT NULL,
    "summary" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeTypeOperationLog_pkey" PRIMARY KEY ("id")
);
