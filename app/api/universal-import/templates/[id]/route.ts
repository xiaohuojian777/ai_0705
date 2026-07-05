import {
  buildTemplateFingerprint,
  inferMappingFromHeaders,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  type SupportedImportFileType,
} from "@/lib/universal-import-engine";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，规则维护 API 直接开放使用。
  return null;
}

function buildSampleMeta(headers: unknown[]) {
  return {
    headers: headers.map((header) => String(header ?? "")),
    source: "manual-mapping",
  } as Prisma.InputJsonValue;
}

function createCopiedFingerprint(sourceFingerprint: string) {
  return `${sourceFingerprint}::copy::${crypto.randomUUID()}`;
}

function createUpdatedFingerprint(ruleId: string, sheetName: string, headers: unknown[]) {
  return `${buildTemplateFingerprint(sheetName, headers)}::rule::${ruleId}`;
}

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;
    const template = await prisma.universalImportRule.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    if (!template) {
      return NextResponse.json({ error: "规则不存在。" }, { status: 404 });
    }

    return NextResponse.json({ template });
  } catch (error) {
    console.error("GET /api/universal-import/templates/[id] failed", error);
    return NextResponse.json({ error: "查询规则失败，请稍后重试。" }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;
    const body = (await request.json()) as {
      ruleName?: string;
      sheetName?: string;
      headers?: unknown[];
      mapping?: UniversalImportMapping;
      fileType?: SupportedImportFileType;
      status?: string;
      ruleDsl?: Prisma.InputJsonValue;
    };

    const headers = body.headers ?? [];
    const operatorName = await getOperatorNameFromSession();
    const inferredMapping = inferMappingFromHeaders(headers);
    const fileType = (body.fileType?.trim() || "excel") as SupportedImportFileType;
    const mapping = body.mapping ?? inferredMapping;
    const ruleDsl = body.ruleDsl ?? (createDefaultRuleDsl(mapping, fileType) as Prisma.InputJsonValue);

    const existing = await prisma.universalImportRule.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "规则不存在。" }, { status: 404 });
    }

    const template = await prisma.universalImportRule.update({
      where: { id },
      data: {
        fingerprint: createUpdatedFingerprint(id, body.sheetName ?? "Sheet1", headers),
        ruleName: body.ruleName?.trim() || body.sheetName?.trim() || "导入规则",
        fileType,
        status: body.status?.trim() || "ACTIVE",
        mapping,
        ruleDsl,
        sampleMeta: buildSampleMeta(headers),
        updatedBy: operatorName,
        version: {
          increment: 1,
        },
      },
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("PUT /api/universal-import/templates/[id] failed", error);
    return NextResponse.json({ error: "更新规则失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      ruleName?: string;
    };
    const operatorName = await getOperatorNameFromSession();
    const source = await prisma.universalImportRule.findUnique({
      where: { id },
    });

    if (!source) {
      return NextResponse.json({ error: "规则不存在。" }, { status: 404 });
    }

    const template = await prisma.universalImportRule.create({
      data: {
        fingerprint: createCopiedFingerprint(source.fingerprint),
        ruleName: body.ruleName?.trim() || `${source.ruleName} 副本`,
        fileType: source.fileType,
        version: 1,
        status: source.status,
        mapping: source.mapping as Prisma.InputJsonValue,
        ruleDsl: source.ruleDsl as Prisma.InputJsonValue,
        sampleMeta: source.sampleMeta as Prisma.InputJsonValue,
        createdBy: operatorName,
        updatedBy: operatorName,
      },
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    return NextResponse.json({ template });
  } catch (error) {
    console.error("POST /api/universal-import/templates/[id] failed", error);
    return NextResponse.json({ error: "复制规则失败，请稍后重试。" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const { id } = await context.params;
    const batchCount = await prisma.universalImportBatch.count({
      where: { ruleId: id },
    });

    if (batchCount > 0) {
      return NextResponse.json(
        { error: "该规则已被导入批次引用，暂不允许删除。" },
        { status: 400 },
      );
    }

    await prisma.universalImportRule.delete({
      where: { id },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("DELETE /api/universal-import/templates/[id] failed", error);
    return NextResponse.json({ error: "删除规则失败，请稍后重试。" }, { status: 500 });
  }
}
