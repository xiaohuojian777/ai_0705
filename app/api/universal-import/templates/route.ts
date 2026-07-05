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
  // 考试模式不包含登录模块，规则管理 API 直接开放使用。
  return null;
}

function buildSampleMeta(headers: unknown[]) {
  return {
    headers: headers.map((header) => String(header ?? "")),
    source: "manual-mapping",
  } as Prisma.InputJsonValue;
}

function createRuleFingerprint(sheetName: string, headers: unknown[]) {
  return `${buildTemplateFingerprint(sheetName, headers)}::${crypto.randomUUID()}`;
}

export async function GET() {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const templates = await prisma.universalImportRule.findMany({
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        _count: {
          select: {
            batches: true,
          },
        },
      },
    });

    return NextResponse.json({ templates });
  } catch (error) {
    console.error("GET /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "查询规则失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();

    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

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
    const fingerprint = createRuleFingerprint(body.sheetName ?? "Sheet1", headers);
    const inferredMapping = inferMappingFromHeaders(headers);
    const operatorName = await getOperatorNameFromSession();
    const fileType = (body.fileType?.trim() || "excel") as SupportedImportFileType;
    const mapping = body.mapping ?? inferredMapping;
    const ruleDsl = body.ruleDsl ?? (createDefaultRuleDsl(mapping, fileType) as Prisma.InputJsonValue);
    const sampleMeta = buildSampleMeta(headers);

    const template = await prisma.universalImportRule.create({
      data: {
        fingerprint,
        ruleName: body.ruleName?.trim() || body.sheetName?.trim() || "导入规则",
        fileType,
        status: body.status?.trim() || "ACTIVE",
        mapping,
        ruleDsl,
        sampleMeta,
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
    console.error("POST /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "保存规则失败，请稍后重试。" }, { status: 500 });
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
      return NextResponse.json({ error: "请选择要删除的规则。" }, { status: 400 });
    }

    const referencedRules = await prisma.universalImportRule.findMany({
      where: {
        id: {
          in: ids,
        },
        batches: {
          some: {},
        },
      },
      select: {
        id: true,
        ruleName: true,
      },
    });

    if (referencedRules.length > 0) {
      return NextResponse.json(
        {
          error: `已选规则中有 ${referencedRules.length} 条被导入批次引用，暂不允许删除。`,
          blockedIds: referencedRules.map((rule) => rule.id),
          blockedNames: referencedRules.map((rule) => rule.ruleName),
        },
        { status: 400 },
      );
    }

    const result = await prisma.universalImportRule.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });

    return NextResponse.json({ success: true, deletedCount: result.count });
  } catch (error) {
    console.error("DELETE /api/universal-import/templates failed", error);
    return NextResponse.json({ error: "批量删除规则失败，请稍后重试。" }, { status: 500 });
  }
}
