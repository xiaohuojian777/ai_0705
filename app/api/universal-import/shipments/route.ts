import {
  formatIssueLabel,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

type ShipmentDraft = {
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  note: string | null;
  sourceRowCount: number;
  rows: UniversalImportRow[];
};

type ReceiverGroupDraft = {
  key: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  note: string | null;
  rows: UniversalImportRow[];
};

type ShipmentSubmitResult = {
  externalCode: string;
  receiverLabel: string;
  sourceRowCount: number;
  status: "success" | "failed";
  shipmentId?: string;
  rowIndexes: number[];
  error?: string;
};

type PreparedShipmentDraft = ShipmentDraft & {
  id: string;
  receiverGroups: Array<ReceiverGroupDraft & { id: string }>;
};

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，万能导入 API 直接开放使用。
  return null;
}

function parsePagination(searchParams: URLSearchParams) {
  const page = Math.max(Number.parseInt(searchParams.get("page") ?? "1", 10) || 1, 1);
  const pageSize = Math.min(
    Math.max(Number.parseInt(searchParams.get("pageSize") ?? "10", 10) || 10, 1),
    1000,
  );

  return { page, pageSize };
}

function parseSubmittedDate(dateValue: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return null;
  }

  const date = new Date(`${dateValue}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

function parseSubmittedDateRange(startDateValue: string, endDateValue: string) {
  const start = parseSubmittedDate(startDateValue);
  const endBase = parseSubmittedDate(endDateValue);
  const end = endBase ? new Date(endBase.getTime() + 24 * 60 * 60 * 1000) : null;

  if (start && end && start > end) {
    return {
      start: endBase,
      end: new Date(start.getTime() + 24 * 60 * 60 * 1000),
    };
  }

  return {
    start,
    end,
  };
}

function buildReceiverRowLabel(row: Pick<UniversalImportRow, "receiverStore" | "receiverName" | "receiverPhone" | "receiverAddress">) {
  const receiverStore = row.receiverStore?.trim() ?? "";
  const receiverName = row.receiverName?.trim() ?? "";
  const receiverPhone = row.receiverPhone?.trim() ?? "";
  const receiverAddress = row.receiverAddress?.trim() ?? "";

  if (receiverStore) {
    return receiverStore;
  }

  const receiverParts = [receiverName, receiverPhone, receiverAddress].filter(Boolean);
  if (receiverParts.length > 0) {
    return receiverParts.join(" / ");
  }

  return "";
}

function getReceiverGroupKey(row: UniversalImportRow) {
  return [
    row.receiverStore.trim(),
    row.receiverName.trim(),
    row.receiverPhone.trim(),
    row.receiverAddress.trim(),
    row.note.trim(),
  ].join("\u001f");
}

function buildReceiverGroups(rows: UniversalImportRow[]) {
  const groups = new Map<string, ReceiverGroupDraft>();

  rows.forEach((row) => {
    const key = getReceiverGroupKey(row);
    const current =
      groups.get(key) ??
      {
        key,
        receiverStore: row.receiverStore.trim() || null,
        receiverName: row.receiverName.trim() || null,
        receiverPhone: row.receiverPhone.trim() || null,
        receiverAddress: row.receiverAddress.trim() || null,
        note: row.note.trim() || null,
        rows: [],
      };

    current.rows.push(row);
    groups.set(key, current);
  });

  return Array.from(groups.values());
}

function summarizeReceiverLabels(receiverLabels: string[]) {
  if (receiverLabels.length === 0) {
    return "未填写收货信息";
  }

  if (receiverLabels.length === 1) {
    return receiverLabels[0];
  }

  return `${receiverLabels[0]} 等 ${receiverLabels.length} 组收货信息`;
}

function buildReceiverLabel(shipment: ShipmentDraft) {
  const receiverLabels = Array.from(
    new Set(
      shipment.rows
        .map((row) => buildReceiverRowLabel(row))
        .filter(Boolean),
    ),
  );

  if (receiverLabels.length > 0) {
    return summarizeReceiverLabels(receiverLabels);
  }

  return summarizeReceiverLabels(
    [shipment.receiverStore, shipment.receiverName, shipment.receiverPhone, shipment.receiverAddress]
      .filter((value): value is string => Boolean(value?.trim()))
      .map((value) => value.trim()),
  );
}

export async function GET(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query")?.trim() ?? "";
    const externalCode = searchParams.get("externalCode")?.trim() ?? "";
    const receiverName = searchParams.get("receiverName")?.trim() ?? "";
    const submittedAt = searchParams.get("submittedAt")?.trim() ?? "";
    const submittedAtStart = searchParams.get("submittedAtStart")?.trim() || submittedAt;
    const submittedAtEnd = searchParams.get("submittedAtEnd")?.trim() || submittedAt;
    const { page, pageSize } = parsePagination(searchParams);

    const submittedDateRange = parseSubmittedDateRange(submittedAtStart, submittedAtEnd);

    const andFilters: Prisma.UniversalImportShipmentWhereInput[] = [];

    if (externalCode) {
      andFilters.push({
        externalCode: {
          contains: externalCode,
        },
      });
    }

    if (receiverName) {
      andFilters.push({
        OR: [
          {
            receiverName: {
              contains: receiverName,
            },
          },
          {
            receiverGroups: {
              some: {
                receiverName: {
                  contains: receiverName,
                },
              },
            },
          },
        ],
      });
    }

    if (query) {
      andFilters.push({
        OR: [
          {
            externalCode: {
              contains: query,
            },
          },
          {
            receiverName: {
              contains: query,
            },
          },
          {
            receiverStore: {
              contains: query,
            },
          },
          {
            receiverGroups: {
              some: {
                OR: [
                  {
                    receiverName: {
                      contains: query,
                    },
                  },
                  {
                    receiverStore: {
                      contains: query,
                    },
                  },
                ],
              },
            },
          },
          {
            batch: {
              batchName: {
                contains: query,
              },
            },
          },
          {
            batch: {
              originalFileName: {
                contains: query,
              },
            },
          },
        ],
      });
    }

    if (submittedDateRange) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (submittedDateRange.start) {
        createdAt.gte = submittedDateRange.start;
      }
      if (submittedDateRange.end) {
        createdAt.lt = submittedDateRange.end;
      }
      andFilters.push({
        createdAt,
      });
    }

    const where: Prisma.UniversalImportShipmentWhereInput =
      andFilters.length > 0 ? { AND: andFilters } : {};

    const total = await prisma.universalImportShipment.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages);

    const records = await prisma.universalImportShipment.findMany({
      where,
      include: {
        batch: true,
        receiverGroups: {
          orderBy: {
            createdAt: "asc",
          },
        },
        items: {
          orderBy: {
            sourceRowIndex: "asc",
          },
        },
      },
      orderBy: [
        {
          createdAt: "desc",
        },
        {
          externalCode: "asc",
        },
      ],
      skip: (currentPage - 1) * pageSize,
      take: pageSize,
    });

    return NextResponse.json({
      records,
      total,
      page: currentPage,
      pageSize,
      totalPages,
    });
  } catch (error) {
    console.error("GET /api/universal-import/shipments failed", error);
    return NextResponse.json({ error: "查询运单失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json().catch(() => ({}))) as {
      ids?: unknown;
    };
    const ids = Array.isArray(body.ids)
      ? Array.from(new Set(body.ids.map((id) => String(id ?? "").trim()).filter(Boolean)))
      : [];

    if (ids.length === 0) {
      return NextResponse.json({ error: "请选择要删除的历史运单。" }, { status: 400 });
    }

    const result = await prisma.universalImportShipment.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (error) {
    console.error("DELETE /api/universal-import/shipments failed", error);
    return NextResponse.json({ error: "批量删除历史运单失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const body = (await request.json()) as {
      batchName?: string;
      originalFileName?: string;
      fileType?: string;
      sheetName?: string;
      headers?: unknown[];
      rows?: UniversalImportRow[];
      mapping?: Record<string, number | null>;
      fingerprint?: string;
      ruleId?: string;
    };

    const rows = body.rows ?? [];

    const importExternalCodes = Array.from(
      new Set(
        rows
          .map((row) => row.externalCode.trim())
          .filter(Boolean),
      ),
    );

    const existingShipments =
      importExternalCodes.length === 0
        ? []
        : await prisma.universalImportShipment.findMany({
            where: {
              externalCode: {
                in: importExternalCodes,
              },
            },
            select: {
              externalCode: true,
              batch: {
                select: {
                  batchName: true,
                  createdAt: true,
                },
              },
            },
          });

    const existingExternalCodes = existingShipments.map((record) => ({
      externalCode: record.externalCode,
      batchName: record.batch.batchName,
      batchCreatedAt: record.batch.createdAt.toISOString(),
    }));

    const { issues } = validateImportRows(rows, existingExternalCodes);

    if (issues.length > 0) {
      await sendDingTalkAlert({
        title: "万能导入提交校验失败",
        message: `本次提交存在 ${issues.length} 个未修正问题，系统已阻止入库。`,
        tags: {
          module: "shipment-submit",
          fileName: body.originalFileName,
          rowCount: rows.length,
          firstIssue: issues[0] ? formatIssueLabel(issues[0]) : "",
        },
      });
      return NextResponse.json(
        {
          error: "存在未修正的错误行，无法提交。",
          issues: issues.map(formatIssueLabel),
        },
        { status: 400 },
      );
    }

    const operatorName = await getOperatorNameFromSession();
    const batchName = body.batchName?.trim() || body.originalFileName?.trim() || "万能导入批次";

    const shipmentMap = new Map<string, ShipmentDraft>();

    // 外部编码为空的行，每行生成独立运单（独立 key）
    let emptyCodeCounter = 0;
    function nextEmptyCodeKey(): string {
      emptyCodeCounter += 1;
      return `__empty__${emptyCodeCounter}`;
    }

    rows.forEach((row) => {
      const rawExternalCode = row.externalCode.trim();
      // 空外部编码 → 生成唯一 key；非空 → 按外部编码聚合
      const mapKey = rawExternalCode || nextEmptyCodeKey();

      const current = shipmentMap.get(mapKey);

      if (current) {
        current.rows.push(row);
        current.sourceRowCount += 1;
        if (!current.receiverStore && row.receiverStore.trim()) {
          current.receiverStore = row.receiverStore.trim();
        }
        if (!current.receiverName && row.receiverName.trim()) {
          current.receiverName = row.receiverName.trim();
        }
        if (!current.receiverPhone && row.receiverPhone.trim()) {
          current.receiverPhone = row.receiverPhone.trim();
        }
        if (!current.receiverAddress && row.receiverAddress.trim()) {
          current.receiverAddress = row.receiverAddress.trim();
        }
        if (!current.note && row.note.trim()) {
          current.note = row.note.trim();
        }
        return;
      }

      shipmentMap.set(mapKey, {
        // DB 中 externalCode 仍存储真实值（空即空字符串）
        externalCode: rawExternalCode,
        receiverStore: row.receiverStore.trim() || null,
        receiverName: row.receiverName.trim() || null,
        receiverPhone: row.receiverPhone.trim() || null,
        receiverAddress: row.receiverAddress.trim() || null,
        note: row.note.trim() || null,
        sourceRowCount: 1,
        rows: [row],
      });
    });

    let ruleId: string | null = null;
    let ruleVersion: number | null = null;

    if (body.ruleId?.trim()) {
      const rule = await prisma.universalImportRule.findUnique({
        where: {
          id: body.ruleId.trim(),
        },
        select: {
          id: true,
          version: true,
        },
      });
      if (rule) {
        ruleId = rule.id;
        ruleVersion = rule.version;
      }
    }

    const batch = await prisma.universalImportBatch.create({
      data: {
        batchName,
        originalFileName: body.originalFileName?.trim() || "",
        sourceSheetName: body.sheetName?.trim() || "",
        fileType: body.fileType?.trim() || "excel",
        ruleId,
        ruleVersion,
        totalRows: rows.length,
        successRows: 0,
        failedRows: rows.length,
        status: "PROCESSING",
        parseSummary: {
          headers: (body.headers ?? []).map((header) => String(header ?? "")),
          fingerprint: body.fingerprint ?? "",
          mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
          shipmentCount: shipmentMap.size,
        } as Prisma.InputJsonValue,
        createdBy: operatorName,
      },
    });

    const preparedShipments: PreparedShipmentDraft[] = Array.from(shipmentMap.values()).map((shipment) => ({
      ...shipment,
      id: crypto.randomUUID(),
      receiverGroups: buildReceiverGroups(shipment.rows).map((group) => ({
        ...group,
        id: crypto.randomUUID(),
      })),
    }));

    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.universalImportShipment.createMany({
            data: preparedShipments.map((shipment) => ({
              id: shipment.id,
              batchId: batch.id,
              externalCode: shipment.externalCode,
              receiverStore: shipment.receiverStore,
              receiverName: shipment.receiverName,
              receiverPhone: shipment.receiverPhone,
              receiverAddress: shipment.receiverAddress,
              note: shipment.note,
              sourceRowCount: shipment.sourceRowCount,
              raw: shipment.rows,
            })),
          });

          const receiverGroups = preparedShipments.flatMap((shipment) =>
            shipment.receiverGroups.map((group) => ({
              id: group.id,
              shipmentId: shipment.id,
              receiverStore: group.receiverStore,
              receiverName: group.receiverName,
              receiverPhone: group.receiverPhone,
              receiverAddress: group.receiverAddress,
              note: group.note,
              sourceRowCount: group.rows.length,
              raw: group.rows,
            })),
          );

          if (receiverGroups.length > 0) {
            await tx.universalImportShipmentReceiverGroup.createMany({
              data: receiverGroups,
            });
          }

          const itemRows = preparedShipments.flatMap((shipment) => {
            const receiverGroupIdByKey = new Map(shipment.receiverGroups.map((group) => [group.key, group.id] as const));

            return shipment.rows.map((row) => ({
              shipmentId: shipment.id,
              receiverGroupId: receiverGroupIdByKey.get(getReceiverGroupKey(row)),
              sourceRowIndex: row.rowIndex,
              skuCode: row.skuCode.trim(),
              skuName: row.skuName.trim(),
              skuQuantity: Number.parseFloat(row.skuQuantity.trim()),
              skuSpec: row.skuSpec.trim() || null,
              raw: row,
            }));
          });

          if (itemRows.length > 0) {
            await tx.universalImportShipmentItem.createMany({
              data: itemRows,
            });
          }
        },
        { timeout: 120_000 },
      );
    } catch (shipmentError) {
      const message = shipmentError instanceof Error ? shipmentError.message : "运单批量入库失败";
      await prisma.universalImportBatch.update({
        where: {
          id: batch.id,
        },
        data: {
          status: "FAILED",
          successRows: 0,
          failedRows: rows.length,
          parseSummary: {
            headers: (body.headers ?? []).map((header) => String(header ?? "")),
            fingerprint: body.fingerprint ?? "",
            mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
            shipmentCount: shipmentMap.size,
            successShipmentCount: 0,
            failedShipmentCount: preparedShipments.length,
            shipmentResults: preparedShipments.map((shipment) => ({
              externalCode: shipment.externalCode,
              receiverLabel: buildReceiverLabel(shipment),
              sourceRowCount: shipment.sourceRowCount,
              status: "failed",
              rowIndexes: shipment.rows.map((row) => row.rowIndex),
              error: message,
            })),
          } as Prisma.InputJsonValue,
        },
      });

      return NextResponse.json(
        {
          error: message,
          summary: {
            successCount: 0,
            failCount: rows.length,
            shipmentCount: 0,
            failedShipmentCount: preparedShipments.length,
          },
          results: preparedShipments.map((shipment) => ({
            externalCode: shipment.externalCode,
            receiverLabel: buildReceiverLabel(shipment),
            sourceRowCount: shipment.sourceRowCount,
            status: "failed",
            rowIndexes: shipment.rows.map((row) => row.rowIndex),
            error: message,
          })),
        },
        { status: 500 },
      );
    }

    const shipmentResults: ShipmentSubmitResult[] = preparedShipments.map((shipment) => ({
      externalCode: shipment.externalCode,
      receiverLabel: buildReceiverLabel(shipment),
      sourceRowCount: shipment.sourceRowCount,
      status: "success",
      shipmentId: shipment.id,
      rowIndexes: shipment.rows.map((row) => row.rowIndex),
    }));

    const successShipments = shipmentResults.filter((item) => item.status === "success");
    const failedShipments = shipmentResults.filter((item) => item.status === "failed");
    const successCount = successShipments.reduce((total, item) => total + item.sourceRowCount, 0);
    const failCount = failedShipments.reduce((total, item) => total + item.sourceRowCount, 0);

    const result = await prisma.universalImportBatch.update({
      where: {
        id: batch.id,
      },
      data: {
        successRows: successCount,
        failedRows: failCount,
        status: failedShipments.length === 0 ? "COMPLETED" : successShipments.length === 0 ? "FAILED" : "PARTIAL_FAILED",
        parseSummary: {
          headers: (body.headers ?? []).map((header) => String(header ?? "")),
          fingerprint: body.fingerprint ?? "",
          mapping: (body.mapping ?? {}) as Prisma.InputJsonValue,
          shipmentCount: shipmentMap.size,
          successShipmentCount: successShipments.length,
          failedShipmentCount: failedShipments.length,
          shipmentResults,
        } as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json({
      batch: result,
      summary: {
        successCount,
        failCount,
        shipmentCount: successShipments.length,
        failedShipmentCount: failedShipments.length,
      },
      results: shipmentResults,
    });
  } catch (error) {
    console.error("POST /api/universal-import/shipments failed", error);
    await sendDingTalkAlert({
      title: "万能导入提交异常",
      message: error instanceof Error ? error.message : "提交失败，请稍后重试。",
      tags: {
        module: "shipment-submit",
      },
    });
    return NextResponse.json({ error: "提交失败，请稍后重试。" }, { status: 500 });
  }
}
