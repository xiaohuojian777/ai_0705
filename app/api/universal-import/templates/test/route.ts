import {
  buildTemplateFingerprint,
  inferMappingFromHeaders,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  executeUniversalImportRule,
  parseImportDocument,
  type SupportedImportFileType,
  type UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";
import { resolveImportFileType } from "@/lib/universal-import-file-type";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
import { NextResponse } from "next/server";

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，试解析 API 直接开放使用。
  return null;
}

function parseJsonField<T>(rawValue: string, fieldName: string) {
  try {
    return JSON.parse(rawValue) as T;
  } catch {
    throw new Error(`${fieldName} 不是合法 JSON，请检查规则编辑器中的配置。`);
  }
}

export async function POST(request: Request) {
  try {
    const unauthorizedResponse = await ensureExamModeAccess();
    if (unauthorizedResponse) {
      return unauthorizedResponse;
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const requestedFileType = (formData.get("fileType")?.toString() || "excel") as SupportedImportFileType;
    const mappingRaw = formData.get("mapping")?.toString() ?? "";
    const ruleDslRaw = formData.get("ruleDsl")?.toString() ?? "";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传样例文件后再试解析。" }, { status: 400 });
    }

    if (file.size <= 0) {
      return NextResponse.json({ error: "文件为空，请重新上传包含出库单内容的文件。" }, { status: 400 });
    }

    const fileType = resolveImportFileType(file.name, requestedFileType);
    const arrayBuffer = await file.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const document = await parseImportDocument({
      fileBuffer,
      fileType,
      originalFileName: file.name,
    });

    const inferredMapping = inferMappingFromHeaders(document.headers);
    const mapping = mappingRaw
      ? parseJsonField<UniversalImportMapping>(mappingRaw, "字段映射")
      : inferredMapping;
    const ruleDsl = ruleDslRaw
      ? parseJsonField<UniversalImportRuleDsl>(ruleDslRaw, "解析规则 DSL")
      : createDefaultRuleDsl(mapping, fileType);

    const result = await executeUniversalImportRule({
      fileBuffer,
      fileType,
      originalFileName: file.name,
      rule: ruleDsl,
    });

    if ((result.rowCount ?? result.previewRows.length) === 0) {
      return NextResponse.json(
        {
          error: "未解析出任何有效下单数据，请检查样例文件、字段映射和 Transform Config 后重试。",
          document,
          summary: result.summary,
          inferredMapping,
          fingerprint: buildTemplateFingerprint(document.sheetName, document.headers),
        },
        { status: 422 },
      );
    }

    return NextResponse.json({
      ...result,
      fingerprint: buildTemplateFingerprint(document.sheetName, document.headers),
      inferredMapping,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "试解析失败，请稍后重试。";
    console.error("POST /api/universal-import/templates/test failed", error);
    await sendDingTalkAlert({
      title: "万能导入试解析失败",
      message,
      tags: {
        module: "rule-test",
      },
    });
    return NextResponse.json({ error: message }, { status: message.includes("JSON") ? 400 : 500 });
  }
}
