import fs from "node:fs/promises";
import path from "node:path";
import { parseImportDocument, type SupportedImportFileType } from "@/lib/universal-import-engine";
import { inferMappingFromHeaders } from "@/lib/universal-import";
import { createSiliconFlowChatCompletion, getSiliconFlowModel } from "@/lib/siliconflow";

async function loadEnvFile() {
  const envPath = path.join(process.cwd(), ".env.local");
  const content = await fs.readFile(envPath, "utf8");

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const normalizedValue = rawValue.replace(/^"(.*)"$/, "$1");

    if (!(key in process.env)) {
      process.env[key] = normalizedValue;
    }
  }
}

type VerificationResult = {
  fileName: string;
  fileType: SupportedImportFileType;
  sheetName: string;
  sectionCount: number;
  rowCount: number;
  summary: string;
  mode: string;
  enabledTransforms: string[];
  mappedFields: Array<{ field: string; column: number | null }>;
  riskNotes: string[];
};

const DEMO_DIR = "D:\\codex\\AITest\\demos";

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    mode: {
      type: "string",
      enum: ["mapping", "text", "structured"],
    },
    mapping: {
      type: "object",
      additionalProperties: false,
      properties: {
        externalCode: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        receiverStore: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        receiverName: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        receiverPhone: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        receiverAddress: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        skuCode: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        skuName: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        skuQuantity: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        skuSpec: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
        note: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
      },
    },
    enabledTransforms: {
      type: "array",
      items: { type: "string" },
    },
    riskNotes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "mode", "mapping", "enabledTransforms", "riskNotes"],
} as const;

function detectFileType(fileName: string): SupportedImportFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".docx" || ext === ".doc") {
    return "word";
  }
  return "excel";
}

async function generateSuggestion(filePath: string): Promise<VerificationResult> {
  const fileName = path.basename(filePath);
  const fileType = detectFileType(fileName);
  const fileBuffer = await fs.readFile(filePath);
  const document = await parseImportDocument({
    fileBuffer,
    fileType,
    originalFileName: fileName,
  });
  const inferredMapping = inferMappingFromHeaders(document.headers);

  const prompt = JSON.stringify(
    {
      task: "根据物流批量下单文件结构生成导入规则建议",
      fileType,
      sheetName: document.sheetName,
      headers: document.headers,
      rowCount: document.rawRows.length,
      sectionCount: document.sections.length,
      sectionPreview: document.sections.slice(0, 4).map((section, index) => ({
        index,
        title: section.title,
        rowCount: section.rows.length,
        rows: section.rows.slice(0, 6),
      })),
      textPreview: document.textContent.slice(0, 2200),
      inferredMapping,
      constraints: [
        "如不确定字段来源可返回 null",
        "结合文件结构选择最合适的 mode",
        "enabledTransforms 仅保留需要启用的转换",
      ],
    },
    null,
    2,
  );

  const content = await createSiliconFlowChatCompletion({
    messages: [
      {
        role: "system",
        content: "你是物流万能导入规则生成助手，只返回合法 JSON。",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.1,
    maxTokens: 2200,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "verify_universal_import_rule",
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const suggestion = JSON.parse(content) as {
    summary: string;
    mode: string;
    mapping: Record<string, number | null>;
    enabledTransforms: string[];
    riskNotes: string[];
  };

  return {
    fileName,
    fileType,
    sheetName: document.sheetName,
    sectionCount: document.sections.length,
    rowCount: document.rawRows.length,
    summary: suggestion.summary,
    mode: suggestion.mode,
    enabledTransforms: suggestion.enabledTransforms,
    mappedFields: Object.entries(suggestion.mapping).map(([field, column]) => ({
      field,
      column,
    })),
    riskNotes: suggestion.riskNotes,
  };
}

async function main() {
  await loadEnvFile();

  const requestedFile = process.argv[2]?.trim();
  const files = (await fs.readdir(DEMO_DIR))
    .filter((file) => /\.(xlsx|xls|docx|doc|pdf)$/i.test(file))
    .filter((file) => !requestedFile || file === requestedFile)
    .sort((left, right) => left.localeCompare(right, "zh-CN"));

  const results: VerificationResult[] = [];

  for (const file of files) {
    const fullPath = path.join(DEMO_DIR, file);
    console.error(`Verifying AI suggestion for: ${file}`);
    results.push(await generateSuggestion(fullPath));
  }

  console.log(
    JSON.stringify(
      {
        provider: "siliconflow",
        model: getSiliconFlowModel(),
        fileCount: results.length,
        results,
      },
      null,
      2,
    ),
  );
}

void main();
