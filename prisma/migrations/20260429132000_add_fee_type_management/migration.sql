-- CreateTable
CREATE TABLE "FeeType" (
    "id" TEXT NOT NULL,
    "feeCode" VARCHAR(8) NOT NULL,
    "feeName" VARCHAR(32) NOT NULL,
    "businessDomain" VARCHAR(16) NOT NULL,
    "quoteTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" VARCHAR(256),
    "createdBy" VARCHAR(32) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" VARCHAR(32) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeeType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeeType_feeCode_key" ON "FeeType"("feeCode");

-- SeedData
INSERT INTO "FeeType" (
    "id",
    "feeCode",
    "feeName",
    "businessDomain",
    "quoteTypes",
    "note",
    "createdBy",
    "createdAt",
    "updatedBy",
    "updatedAt"
) VALUES
    (
        'fee_type_1001',
        '1001',
        '派送费',
        '运配',
        ARRAY['基础价格', '网点价格'],
        '2021新增',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59'
    ),
    (
        'fee_type_1002',
        '1002',
        '转运费',
        '运配',
        ARRAY['基础价格', '网点价格'],
        NULL,
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59'
    ),
    (
        'fee_type_1003',
        '1003',
        '中转费',
        '运配',
        ARRAY['成本价格'],
        NULL,
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59'
    ),
    (
        'fee_type_1004',
        '1004',
        '到付款手续费',
        '运配',
        ARRAY['增值服务价格'],
        NULL,
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59'
    ),
    (
        'fee_type_1005',
        '1005',
        '操作费',
        '运配',
        ARRAY['网点价格'],
        NULL,
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59',
        '系统用户',
        TIMESTAMP '2021-01-18 15:42:59'
    );
