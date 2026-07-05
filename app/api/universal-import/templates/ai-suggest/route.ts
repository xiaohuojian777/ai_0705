import {
  inferMappingFromHeaders,
  UNIVERSAL_IMPORT_FIELDS,
  type UniversalImportField,
  type UniversalImportMapping,
} from "@/lib/universal-import";
import {
  createDefaultRuleDsl,
  parseImportDocument,
  type SupportedImportFileType,
  type UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";
import { resolveImportFileType } from "@/lib/universal-import-file-type";
import {
  createLlmChatCompletion,
  getConfiguredLlmModel,
  getConfiguredLlmProvider,
  isLlmConfigured,
} from "@/lib/siliconflow";
import { sendDingTalkAlert } from "@/lib/dingtalk-alert";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

const AI_SUGGEST_TIMEOUT_MS = 45_000;

type AiConfidenceItem = {
  field: UniversalImportField;
  confidence: number;
  source: string;
};

type AiRuleSuggestion = {
  summary: string;
  mode?: UniversalImportRuleDsl["mode"];
  mapping?: Partial<Record<UniversalImportField, number | null>>;
  enabledTransforms?: string[];
  transformConfigs?: Record<string, Record<string, unknown>>;
  confidenceReport?: AiConfidenceItem[];
  riskNotes?: string[];
};

type AiSuggestSuccessResponse = {
  documentSummary: {
    fileType: SupportedImportFileType;
    sheetName: string;
    headers: string[];
    headerRowIndex: number;
    columnOptions: Array<{
      index: number;
      header: string;
      samples: string[];
    }>;
    tailSourceOptions: Partial<Record<UniversalImportField, Array<{ label: string; sample: string }>>>;
    rowCount: number;
    sectionCount: number;
    textPreview: string;
  };
  suggestedRule: UniversalImportRuleDsl;
  confidenceReport: AiConfidenceItem[];
  riskNotes: string[];
  provider: "deepseek" | "siliconflow" | "fallback";
  model: string;
  aiSummary: string;
};

const SUPPORTED_TRANSFORMS = new Set<UniversalImportRuleDsl["transforms"][number]["type"]>([
  "header_mapping",
  "multisheet_merge",
  "group_by_external_code",
  "matrix_pivot",
  "split_multiline_cell",
  "tail_text_extract",
  "card_split",
  "text_record_split",
]);

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
      properties: Object.fromEntries(
        UNIVERSAL_IMPORT_FIELDS.map((field) => [
          field.key,
          {
            anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }],
          },
        ]),
      ),
    },
    enabledTransforms: {
      type: "array",
      items: { type: "string" },
    },
    transformConfigs: {
      type: "object",
      additionalProperties: {
        type: "object",
      },
    },
    confidenceReport: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: {
            type: "string",
            enum: UNIVERSAL_IMPORT_FIELDS.map((field) => field.key),
          },
          confidence: {
            type: "number",
            minimum: 0,
            maximum: 1,
          },
          source: { type: "string" },
        },
        required: ["field", "confidence", "source"],
      },
    },
    riskNotes: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["summary", "mode", "mapping", "enabledTransforms", "transformConfigs", "confidenceReport", "riskNotes"],
} as const;

async function ensureExamModeAccess() {
  // 考试模式不包含登录模块，AI 规则建议 API 直接开放使用。
  return null;
}

function normalizeHeaderText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}<>【】“”"'`’‘、，。；：！？,.!?/\\|]/g, "");
}

function scoreHeaderRow(row: string[]) {
  const normalizedCells = row.map((cell) => normalizeHeaderText(cell)).filter(Boolean);
  if (normalizedCells.length === 0) {
    return 0;
  }

  const aliasScore = UNIVERSAL_IMPORT_FIELDS.reduce((score, field) => {
    const aliases = field.aliases.map((alias) => normalizeHeaderText(alias)).filter(Boolean);
    const matched = normalizedCells.some((cell) =>
      aliases.some((alias) => cell === alias || cell.includes(alias) || alias.includes(cell)),
    );
    return score + (matched ? 4 : 0);
  }, 0);

  return normalizedCells.length + aliasScore;
}

function inferBestHeaderRowIndex(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const rows = document.sections[0]?.rows ?? [];
  const candidates = rows.slice(0, 12);
  if (candidates.length === 0) {
    return 0;
  }

  return candidates.reduce(
    (best, row, index) => {
      const score = scoreHeaderRow(row);
      return score > best.score ? { index, score } : best;
    },
    { index: 0, score: 0 },
  ).index;
}

function getTransformConfig(rule: UniversalImportRuleDsl, transformType: string) {
  return rule.transforms.find((transform) => transform.type === transformType)?.config;
}

function getRecommendedHeaderRowIndex(document: Awaited<ReturnType<typeof parseImportDocument>>, rule: UniversalImportRuleDsl) {
  const headerConfig = getTransformConfig(rule, "header_mapping");
  const matrixConfig = getTransformConfig(rule, "matrix_pivot");
  const explicit = headerConfig?.headerRowIndex ?? matrixConfig?.headerRowIndex;

  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  if (typeof explicit === "string" && /^\d+$/.test(explicit.trim())) {
    return Number(explicit);
  }

  return inferBestHeaderRowIndex(document);
}

function buildColumnOptions(document: Awaited<ReturnType<typeof parseImportDocument>>, headerRowIndex: number) {
  const rows = document.sections[0]?.rows ?? [];
  const headers = rows[headerRowIndex] ?? document.headers ?? [];
  const allRows = document.sections.flatMap((section) => section.rows);
  const maxColumnCount = allRows.reduce((max, row) => Math.max(max, row.length), headers.length);
  const sampleRows = allRows.filter((row, index) => index !== headerRowIndex);

  return Array.from({ length: maxColumnCount }, (_, index) => ({
    index,
    header: headers[index] || "",
    samples: sampleRows
      .map((row) => row[index])
      .filter((value): value is string => Boolean(value?.trim()))
      .filter((value, valueIndex, list) => list.indexOf(value) === valueIndex)
      .slice(0, 8),
  }));
}

function buildDocumentSummary(
  fileType: SupportedImportFileType,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
  rule: UniversalImportRuleDsl,
) {
  const headerRowIndex = getRecommendedHeaderRowIndex(document, rule);
  const columnOptions = buildColumnOptions(document, headerRowIndex);
  const tailSourceOptions = inferKeyValueExtractionConfig(document)?.samples ?? {};

  return {
    fileType,
    sheetName: document.sheetName,
    headers: columnOptions.map((option) => option.header),
    headerRowIndex,
    columnOptions,
    tailSourceOptions,
    rowCount: document.rawRows.length,
    sectionCount: document.sections.length,
    textPreview: document.textContent.slice(0, 800),
  };
}

function getAiConfiguredFieldColumns(configs: Record<string, Record<string, unknown>> | undefined) {
  if (!configs) {
    return undefined;
  }

  const headerConfig = normalizeAiTransformConfig(configs.header_mapping ?? configs.headerMapping);
  const candidate = headerConfig.fieldColumns;
  if (!isRecord(candidate)) {
    return undefined;
  }

  return candidate as Partial<Record<UniversalImportField, number | null>>;
}

function mergeMappingCandidates(
  primary: Partial<Record<UniversalImportField, number | null>> | undefined,
  secondary: Partial<Record<UniversalImportField, number | null>> | undefined,
  fallback: UniversalImportMapping,
) {
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const primaryValue = primary?.[field.key];
      const secondaryValue = secondary?.[field.key];
      return [
        field.key,
        typeof primaryValue === "number"
          ? primaryValue
          : typeof secondaryValue === "number"
            ? secondaryValue
            : fallback[field.key],
      ];
    }),
  ) as UniversalImportMapping;
}

function applyHeaderRecommendation(rule: UniversalImportRuleDsl, headerRowIndex: number, mapping: UniversalImportMapping) {
  const nextDataStartRowIndex = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > headerRowIndex
      ? value
      : headerRowIndex + 1;

  return {
    ...rule,
    mapping,
    transforms: rule.transforms.map((transform) =>
      transform.type === "header_mapping"
        ? {
            ...transform,
            enabled: transform.enabled || rule.fileType === "excel",
            config: {
              ...(transform.config ?? {}),
              headerRowIndex,
              dataStartRowIndex: nextDataStartRowIndex(transform.config?.dataStartRowIndex),
              fieldColumns: mapping,
              externalCodeTemplate: typeof mapping.externalCode === "number" ? "" : "SHEET-{sectionTitle}",
            },
          }
        : transform,
    ),
  };
}

function maxMappedColumn(mapping: Partial<Record<UniversalImportField, number | null>>) {
  return Math.max(
    -1,
    ...Object.values(mapping).filter((value): value is number => typeof value === "number"),
  );
}

function isPositiveCell(value: unknown) {
  return /^\d+(?:\.\d+)?$/.test(String(value ?? "").trim()) && Number(value) > 0;
}

function isMetricLikeMatrixHeader(value: unknown) {
  return /^(?:\d+(?:\.\d+)?)$/.test(String(value ?? "").trim()) ||
    /(合计|总计|库存|结余|可用|待移入|分配|冻结|下单后|在库|数量)/.test(String(value ?? ""));
}

function findMatrixStartColumn(header: string[], mapping: UniversalImportMapping) {
  const fixedEnd = maxMappedColumn({
    skuCode: mapping.skuCode,
    skuName: mapping.skuName,
    skuSpec: mapping.skuSpec,
    externalCode: mapping.externalCode,
  });
  const firstBusinessDimension = header.findIndex((cell, index) =>
    index > fixedEnd && Boolean(normalizeHeaderText(cell)) && !isMetricLikeMatrixHeader(cell),
  );

  return firstBusinessDimension >= 0 ? firstBusinessDimension : Math.max(fixedEnd + 1, 0);
}

function updateTransform(
  rule: UniversalImportRuleDsl,
  type: UniversalImportRuleDsl["transforms"][number]["type"],
  patch: Partial<UniversalImportRuleDsl["transforms"][number]>,
) {
  return {
    ...rule,
    transforms: rule.transforms.map((transform) =>
      transform.type === type
        ? {
            ...transform,
            ...patch,
            config: {
              ...(transform.config ?? {}),
              ...(patch.config ?? {}),
            },
          }
        : transform,
    ),
  };
}

function detectMatrixRecommendation(
  document: Awaited<ReturnType<typeof parseImportDocument>>,
  mapping: UniversalImportMapping,
  headerRowIndex: number,
) {
  if (typeof mapping.skuQuantity === "number") {
    return null;
  }

  const rows = document.sections[0]?.rows ?? [];
  const header = rows[headerRowIndex] ?? [];
  const sampleRows = rows.slice(headerRowIndex + 1, headerRowIndex + 8);
  const matrixStartColumn = findMatrixStartColumn(header, mapping);
  const candidateHeaders = header
    .slice(matrixStartColumn)
    .filter((cell) => normalizeHeaderText(cell) && !isMetricLikeMatrixHeader(cell));
  const positiveCells = sampleRows.reduce(
    (count, row) =>
      count +
      row
        .slice(matrixStartColumn)
        .filter((cell, offset) => !isMetricLikeMatrixHeader(header[matrixStartColumn + offset]) && isPositiveCell(cell))
        .length,
    0,
  );

  if (candidateHeaders.length < 2 || positiveCells < 2) {
    return null;
  }

  return {
    headerRowIndex,
    dataStartRowIndex: headerRowIndex + 1,
    rowFieldColumns: {
      skuCode: mapping.skuCode,
      skuName: mapping.skuName,
      skuSpec: mapping.skuSpec,
      externalCode: mapping.externalCode,
    },
    matrixStartColumn,
    matrixEndColumn: Math.max(header.length - 1, matrixStartColumn),
    excludeHeaderRegex: "合计|总计|库存|结余|可用|待移入|分配|冻结|下单后",
    externalCodeTemplate: "MATRIX-{receiverStore}",
  };
}

function detectSplitMultilineCellRecommendation(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const rows = document.sections[0]?.rows ?? [];
  const headerRowIndex = inferBestHeaderRowIndex(document);
  const header = rows[headerRowIndex] ?? [];
  const sampleRows = rows.slice(headerRowIndex + 1, headerRowIndex + 8);
  const hasMultilineItems = sampleRows.some((row) =>
    row.some((cell) => /[\n\r]/.test(cell) && /(?:x|X|×|\*)\s*\d/.test(cell)),
  );

  if (!hasMultilineItems) {
    return null;
  }

  return {
    headerRowIndex,
    dataStartRowIndex: headerRowIndex + 1,
    rowFieldColumns: {
      receiverStore: 0,
      externalCode: 0,
    },
    matrixStartColumn: 1,
    matrixEndColumn: Math.max(header.length - 1, 1),
    columnValueField: "note",
    itemRegex: "([^\\n\\r,，;；|]+?)\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?)",
    skuNameGroup: 1,
    skuQuantityGroup: 2,
    defaultSkuCodePrefix: "AUTO-SKU",
    externalCodeTemplate: "PLAN-{receiverStore}-{columnHeader}",
  };
}

function detectCardSplitRecommendation(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const rows = document.sections[0]?.rows ?? [];
  const startIndex = rows.findIndex((row) => /调拨记录|▶|card/i.test(row.join(" ")));

  if (startIndex < 0) {
    return null;
  }

  const itemHeaderIndex = rows.findIndex((row, index) =>
    index > startIndex && scoreHeaderRow(row) >= 12 && /编码|名称|数量|SKU/i.test(row.join(" ")),
  );
  const itemHeader = itemHeaderIndex >= 0 ? rows[itemHeaderIndex] : [];

  return {
    startRegex: "调拨记录|▶|card",
    itemHeaderRegex: "编码|名称|数量|SKU",
    fieldRegex: {
      receiverStore: "(?:调入门店|收货门店|门店)[:：\\s]*([^|\\n\\r]+)",
      receiverName: "(?:收货人|联系人|收件人)[:：\\s]*([^|\\n\\r]+)",
      receiverPhone: "(?:电话|手机|联系电话)[:：\\s]*(1\\d{10}|(?:0\\d{2,3}-?)?\\d{7,8})",
      receiverAddress: "(?:收货地址|地址)[:：\\s]*([^|\\n\\r]+)",
    },
    keyValueLabels: {
      receiverStore: ["调入门店", "收货门店", "门店"],
      receiverName: ["收货人", "联系人"],
      receiverPhone: ["电话", "联系电话", "手机"],
      receiverAddress: ["收货地址", "地址"],
    },
    itemColumns: inferMappingFromHeaders(itemHeader),
    excludeRowRegex: "合计|小计|备注",
  };
}

function applyLocalComplexRecommendations(
  rule: UniversalImportRuleDsl,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
  mapping: UniversalImportMapping,
  headerRowIndex: number,
) {
  let nextRule = rule;

  const cardConfig = detectCardSplitRecommendation(document);
  if (cardConfig) {
    nextRule = updateTransform(nextRule, "card_split", {
      enabled: true,
      config: {
        ...cardConfig,
        externalCodeTemplate: "CARD-{cardIndex}",
      },
    });
    nextRule = updateTransform(nextRule, "matrix_pivot", {
      enabled: false,
      config: {},
    });
    nextRule = updateTransform(nextRule, "header_mapping", {
      config: { emitWithCard: false },
    });
    return nextRule;
  }

  const splitMultilineConfig = detectSplitMultilineCellRecommendation(document);
  if (splitMultilineConfig) {
    nextRule = updateTransform(nextRule, "split_multiline_cell", {
      enabled: true,
      config: splitMultilineConfig,
    });
    nextRule = updateTransform(nextRule, "header_mapping", {
      config: { emitWithSplitMultilineCell: false },
    });
  }

  const matrixConfig = detectMatrixRecommendation(document, mapping, headerRowIndex);
  if (matrixConfig) {
    nextRule = updateTransform(nextRule, "matrix_pivot", {
      enabled: true,
      config: matrixConfig,
    });
    nextRule = updateTransform(nextRule, "header_mapping", {
      config: { emitWithMatrix: false },
    });
  }

  return nextRule;
}

const KEY_VALUE_FIELD_ALIASES: Record<UniversalImportField, string[]> = {
  externalCode: ["外部编码", "订单号", "配送单号", "配送汇总单号", "单据编号", "单据号", "单号"],
  receiverStore: ["收货门店", "门店", "门店名称", "收货机构", "收货单位"],
  receiverName: ["收货人姓名", "收件人姓名", "收货人", "收件人"],
  receiverPhone: ["收货人电话", "收件人电话", "收货电话", "联系电话", "备用联系电话", "手机"],
  receiverAddress: ["收货地址", "收件人地址", "收货人地址", "地址"],
  skuCode: [],
  skuName: [],
  skuQuantity: [],
  skuSpec: [],
  note: ["备注", "收货机构备注", "附加说明", "说明"],
};

function normalizeKeyValueLabel(value: unknown) {
  return String(value ?? "")
    .replace(/^[【\[].*?[】\]]\s*/g, "")
    .replace(/[：:]\s*$/g, "")
    .trim();
}

function parseInlineKeyValueCell(value: unknown) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(.{1,24}?)[：:]\s*(.+)$/);
  if (!match) {
    return null;
  }

  const label = normalizeKeyValueLabel(match[1]);
  const inlineValue = String(match[2] ?? "").trim();
  if (!label || !inlineValue) {
    return null;
  }

  return {
    label,
    value: inlineValue,
  };
}

function hasNearbyValue(row: string[], cellIndex: number) {
  if (parseInlineKeyValueCell(row[cellIndex])) {
    return true;
  }

  for (let currentIndex = cellIndex + 1; currentIndex < Math.min(row.length, cellIndex + 8); currentIndex += 1) {
    const value = String(row[currentIndex] ?? "").trim();
    if (!value) {
      continue;
    }

    if (isLikelyKeyValueLabel(value)) {
      return false;
    }

    return true;
  }

  return false;
}

function findNearbyValue(row: string[], cellIndex: number) {
  const inlineKeyValue = parseInlineKeyValueCell(row[cellIndex]);
  if (inlineKeyValue?.value) {
    return inlineKeyValue.value;
  }

  for (let currentIndex = cellIndex + 1; currentIndex < Math.min(row.length, cellIndex + 8); currentIndex += 1) {
    const value = String(row[currentIndex] ?? "").trim();
    if (!value) {
      continue;
    }

    if (isLikelyKeyValueLabel(value)) {
      return "";
    }

    return value;
  }

  return "";
}

function isLikelyKeyValueLabel(value: unknown) {
  if (/^【[^】]+】\S{1,24}$/.test(String(value ?? "").trim())) {
    return true;
  }

  const normalized = normalizeHeaderText(normalizeKeyValueLabel(value)).replace(/[*＊]/g, "");
  if (!normalized) {
    return false;
  }

  const extraLabels = ["备用联系人", "备用联系电话", "创建日期", "创建人", "审核人", "制单人", "签字"];
  return [...UNIVERSAL_IMPORT_FIELDS.flatMap((field) => field.aliases), ...extraLabels].some(
    (alias) => normalizeHeaderText(alias) === normalized,
  );
}

function isKeyValueSummaryRow(row: string[]) {
  const populated = row.map((cell) => String(cell ?? "").trim()).filter(Boolean);
  if (populated.length < 2) {
    return false;
  }

  const labelCount = populated.filter((cell) => {
    const inlineKeyValue = parseInlineKeyValueCell(cell);
    return isLikelyKeyValueLabel(inlineKeyValue?.label ?? cell);
  }).length;

  return labelCount >= 2;
}

function isDenseTableHeaderRow(row: string[]) {
  const populated = row.map((cell) => String(cell ?? "").trim()).filter(Boolean);
  if (populated.length < 8) {
    return false;
  }

  const labelLikeCount = populated.filter((cell) => {
    const normalized = normalizeHeaderText(cell);
    return (
      isLikelyKeyValueLabel(cell) ||
      /(?:序号|行号|分类|品牌|单位|仓库|日期|备注|状态|批次|规格|型号|金额|单价|成本|体积|重量|数量|电话|地址|联系人|机构|单号)/.test(
        normalized,
      )
    );
  }).length;

  return labelLikeCount / populated.length >= 0.45;
}

function inferKeyValueExtractionConfig(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const labels: Partial<Record<UniversalImportField, string[]>> = {};
  const samples: Partial<Record<UniversalImportField, Array<{ label: string; sample: string }>>> = {};
  const matchedRowIndexes = new Set<number>();
  let rowOffset = 0;

  document.sections.forEach((section) => {
    const rows = section.rows ?? [];

    rows.forEach((row, rowIndex) => {
      if (isDenseTableHeaderRow(row) && !isKeyValueSummaryRow(row)) {
        return;
      }

      row.forEach((cell, cellIndex) => {
        const inlineKeyValue = parseInlineKeyValueCell(cell);
        const normalizedCell = normalizeHeaderText(inlineKeyValue?.label ?? normalizeKeyValueLabel(cell));
        if (!normalizedCell || !hasNearbyValue(row, cellIndex)) {
          return;
        }

        (Object.keys(KEY_VALUE_FIELD_ALIASES) as UniversalImportField[]).forEach((field) => {
          const aliases = KEY_VALUE_FIELD_ALIASES[field];
          if (aliases.length === 0) {
            return;
          }

          const matched = aliases.some((alias) => {
            const normalizedAlias = normalizeHeaderText(alias);
            return normalizedAlias && normalizedCell === normalizedAlias;
          });

          if (!matched) {
            return;
          }

          const exactLabel = inlineKeyValue?.label ?? normalizeKeyValueLabel(cell);
          if (!exactLabel) {
            return;
          }

          labels[field] = Array.from(new Set([...(labels[field] ?? []), exactLabel]));
          const sample = findNearbyValue(row, cellIndex);
          if (sample) {
            const currentSamples = samples[field] ?? [];
            if (!currentSamples.some((item) => item.label === exactLabel && item.sample === sample)) {
              samples[field] = [...currentSamples, { label: exactLabel, sample }].slice(0, 4);
            }
          }
          matchedRowIndexes.add(rowOffset + rowIndex);
        });
      });
    });

    rowOffset += rows.length;
  });

  const matchedFields = (Object.keys(labels) as UniversalImportField[]).filter((field) => (labels[field]?.length ?? 0) > 0);
  if (matchedFields.length === 0) {
    return null;
  }

  const config: Record<string, unknown> = {
    source: "document",
    keyValueLabels: labels,
  };

  return {
    config,
    samples,
    matchedFields,
    matchedRowIndexes: Array.from(matchedRowIndexes.values()),
  };
}

function applyKeyValueExtractionRecommendation(
  rule: UniversalImportRuleDsl,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
) {
  const inferred = inferKeyValueExtractionConfig(document);
  if (!inferred) {
    return { rule, extractedFields: [] as UniversalImportField[], matchedRowIndexes: [] as number[] };
  }

  return {
    extractedFields: inferred.matchedFields,
    matchedRowIndexes: inferred.matchedRowIndexes,
    rule: {
      ...rule,
      transforms: rule.transforms.map((transform) =>
        transform.type === "tail_text_extract"
          ? {
              ...transform,
              enabled: true,
              config: {
                ...(transform.config ?? {}),
                ...inferred.config,
              },
            }
          : transform,
      ),
    },
  };
}

function createFallbackSuggestion(
  fileType: SupportedImportFileType,
  suggestedMapping: UniversalImportMapping,
  document: Awaited<ReturnType<typeof parseImportDocument>>,
): AiSuggestSuccessResponse {
  const suggestedRule = createDefaultRuleDsl(suggestedMapping, fileType);
  const headerRowIndex = inferBestHeaderRowIndex(document);
  const columnOptions = buildColumnOptions(document, headerRowIndex);
  const effectiveHeaders = columnOptions.map((option) => option.header);
  const effectiveMapping = fileType === "excel"
    ? mergeMappingCandidates(undefined, inferMappingFromHeaders(effectiveHeaders), suggestedMapping)
    : suggestedMapping;
  const headerRecommendedRule = applyHeaderRecommendation(suggestedRule, headerRowIndex, effectiveMapping);
  const complexRecommendedRule = applyLocalComplexRecommendations(
    headerRecommendedRule,
    document,
    effectiveMapping,
    headerRowIndex,
  );
  const tailRecommended = applyKeyValueExtractionRecommendation(complexRecommendedRule, document);
  const recommendedRule = ensureGroupByExternalCode(tailRecommended.rule);
  const confidenceReport = UNIVERSAL_IMPORT_FIELDS.map((field) => ({
    field: field.key,
    confidence:
      typeof effectiveMapping[field.key] === "number"
        ? 0.92
        : tailRecommended.extractedFields.includes(field.key)
          ? 0.82
          : 0.45,
    source:
      typeof effectiveMapping[field.key] === "number"
        ? "header-match"
        : tailRecommended.extractedFields.includes(field.key)
          ? "tail-key-value"
          : "heuristic-fallback",
  }));

  return {
    documentSummary: buildDocumentSummary(fileType, document, recommendedRule),
    suggestedRule: {
      ...recommendedRule,
      aiConfidenceReport: confidenceReport,
    },
    confidenceReport,
    riskNotes: [
      fileType !== "excel" ? "当前为非 Excel 文档，部分字段来自文本结构推断，建议人工确认。" : "",
      document.sections.length > 1 ? "检测到多段或多 Sheet 内容，建议开启多 Sheet 合并或卡片拆分规则。" : "",
      document.rawRows.length === 0 ? "未识别到标准表格数据，建议切换到纯文本解析模式。" : "",
      tailRecommended.extractedFields.length > 0
        ? `检测到文档键值信息区，已建议通过 tail_text_extract 提取字段：${tailRecommended.extractedFields.map((field) => UNIVERSAL_IMPORT_FIELDS.find((item) => item.key === field)?.label ?? field).join("、")}。`
        : "",
      "当前结果来自本地兜底规则，并非大模型输出。",
    ].filter(Boolean),
    provider: "fallback",
    model: "local-heuristic",
    aiSummary: "本次 AI 建议走了本地兜底逻辑，未使用远程大模型输出。",
  };
}

function normalizeMapping(candidate: Partial<Record<UniversalImportField, number | null>> | undefined, fallback: UniversalImportMapping) {
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => {
      const value = candidate?.[field.key];
      return [field.key, typeof value === "number" ? value : fallback[field.key]];
    }),
  ) as UniversalImportMapping;
}

function parseAiJson(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    return JSON.parse(trimmed) as AiRuleSuggestion;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1)) as AiRuleSuggestion;
    }

    throw new Error("LLM returned non-JSON content");
  }
}

function normalizeEnabledTransforms(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  return typeof value === "string"
    ? value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean)
    : undefined;
}

function normalizeConfidenceReport(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is AiConfidenceItem => {
    if (!isRecord(item)) {
      return false;
    }

    return typeof item.field === "string" && typeof item.confidence === "number";
  });
}

function normalizeRiskNotes(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter(Boolean);
  }

  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function mergeTransforms(baseRule: UniversalImportRuleDsl, enabledTransforms: string[] | undefined) {
  if (!enabledTransforms?.length) {
    return baseRule;
  }

  const enabledSet = new Set(
    enabledTransforms.filter(
      (transform): transform is UniversalImportRuleDsl["transforms"][number]["type"] =>
        SUPPORTED_TRANSFORMS.has(transform as UniversalImportRuleDsl["transforms"][number]["type"]),
    ),
  );

  return {
    ...baseRule,
    transforms: baseRule.transforms.map((transform) => ({
      ...transform,
      enabled: enabledSet.has(transform.type),
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAiTransformConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!isRecord(config)) {
    return {};
  }

  const nested = isRecord(config.config) ? normalizeAiTransformConfig(config.config) : {};
  const output: Record<string, unknown> = {};

  Object.entries(config).forEach(([key, value]) => {
    if (key !== "config" && key !== "type") {
      output[key] = value;
    }
  });

  return {
    ...output,
    ...nested,
  };
}

function mergeTransformConfigs(baseRule: UniversalImportRuleDsl, configs: Record<string, Record<string, unknown>> | undefined) {
  if (!configs) {
    return baseRule;
  }

  return {
    ...baseRule,
    transforms: baseRule.transforms.map((transform) => ({
      ...transform,
      config: {
        ...(transform.config ?? {}),
        ...normalizeAiTransformConfig(configs[transform.type]),
      },
    })),
  };
}

function ensureMultiSectionMerge(rule: UniversalImportRuleDsl, sectionCount: number) {
  if (sectionCount <= 1) {
    return rule;
  }

  return {
    ...rule,
    transforms: rule.transforms.map((transform) =>
      transform.type === "multisheet_merge"
        ? {
            ...transform,
            enabled: true,
            config: {
              ...(transform.config ?? {}),
              mergeAllSheets: true,
            },
          }
        : transform,
    ),
  };
}

function ensureGroupByExternalCode(rule: UniversalImportRuleDsl) {
  const rowProducerTypes: UniversalImportRuleDsl["transforms"][number]["type"][] = [
    "header_mapping",
    "matrix_pivot",
    "split_multiline_cell",
    "card_split",
    "text_record_split",
  ];
  const hasRowProducer = rule.transforms.some((transform) => transform.enabled && rowProducerTypes.includes(transform.type));

  if (!hasRowProducer) {
    return rule;
  }

  return {
    ...rule,
    transforms: rule.transforms.map((transform) =>
      transform.type === "group_by_external_code"
        ? {
            ...transform,
            enabled: true,
            config: {
              ...(transform.config ?? {}),
              inheritedFields: [
                "receiverStore",
                "receiverName",
                "receiverPhone",
                "receiverAddress",
                "note",
              ],
            },
          }
        : transform,
    ),
  };
}

function summarizeDocumentStructure(document: Awaited<ReturnType<typeof parseImportDocument>>) {
  const firstSection = document.sections[0];
  const headRows = firstSection?.rows.slice(0, 8) ?? [];
  const tailRows = firstSection?.rows.slice(-8) ?? [];
  const detailRows = firstSection?.rows
    .filter((row) => row.filter(Boolean).length >= 3)
    .slice(0, 12) ?? [];
  const headerCandidates = (firstSection?.rows ?? [])
    .slice(0, 12)
    .map((row, index) => ({
      rowIndex: index,
      score: scoreHeaderRow(row),
      cells: row,
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return {
    headRows,
    detailRows,
    tailRows,
    headerCandidates,
    sectionTitles: document.sections.map((section) => section.title).slice(0, 8),
  };
}

function buildPrompt(document: Awaited<ReturnType<typeof parseImportDocument>>, fileType: SupportedImportFileType) {
  const sectionPreview = document.sections.slice(0, 4).map((section, index) => ({
    index,
    title: section.title,
    rowCount: section.rows.length,
    rows: section.rows.slice(0, 8),
  }));
  const structureSummary = summarizeDocumentStructure(document);

  return JSON.stringify(
    {
      task: "根据物流批量下单文件结构生成可编辑的导入规则建议",
      fileType,
      sheetName: document.sheetName,
      headers: document.headers,
      rawRowCount: document.rawRows.length,
      sectionCount: document.sections.length,
      sectionPreview,
      structureSummary,
      textPreview: document.textContent.slice(0, 1400),
      targetFields: UNIVERSAL_IMPORT_FIELDS.map((field) => ({
        key: field.key,
        label: field.label,
        required: field.required,
      })),
      availableTransforms: [
        "header_mapping",
        "multisheet_merge",
        "group_by_external_code",
        "matrix_pivot",
        "split_multiline_cell",
        "tail_text_extract",
        "card_split",
        "text_record_split",
      ],
      constraints: [
        "不要编造不存在的列索引",
        "如无法确定映射，请返回 null 并在 riskNotes 说明",
        "Excel 更倾向 structured 或 mapping，Word/PDF 更倾向 text 或 structured",
        "confidenceReport 要逐字段返回 0 到 1 的置信度",
        "enabledTransforms 只返回需要启用的 transform type",
        "enabledTransforms 只能从给定的 availableTransforms 中选择",
        "transformConfigs 必须把每个启用 transform 的执行参数写清楚，执行器只解释这些配置，不会按文件名或样例类型自动适配",
        "transformConfigs 的 key 必须是 transform type，value 必须是直接配置对象，例如 {\"header_mapping\":{\"headerRowIndex\":1}}，禁止写成 {\"header_mapping\":{\"type\":\"header_mapping\",\"config\":{...}}}",
        "fieldColumns、rowFieldColumns、itemColumns 必须使用对象映射，例如 {\"skuCode\":2,\"skuName\":3,\"skuQuantity\":5}，禁止使用数组形式",
        "fieldRegex 必须优先使用对象映射，例如 {\"receiverName\":\"收货人[:：]\\\\s*(.+)\"}；如使用命名捕获组，命名必须等于目标字段 key",
        "text_record_split.item 的 skuCodeGroup、skuNameGroup、skuSpecGroup、skuQuantityGroup 优先返回数字捕获组序号；只有使用命名捕获组时才返回字段名字符串",
        "矩阵转置时 rowFieldColumns 必须映射 SKU 行上的固定字段，matrixStartColumn/matrixEndColumn 才是需要转置为 receiverStore + skuQuantity 的列范围",
        "如果 sectionCount 大于 1 且每个 Sheet 都是同结构订单，请启用 multisheet_merge，并为每个 Sheet 使用相同配置解释后合并",
        "如果启用了 matrix_pivot，header_mapping 通常只作为字段识别参考，不要依赖它单独生成明细行；除非确实需要双产出，否则不要设置 emitWithMatrix",
        "matrix_pivot 的 matrixStartColumn/matrixEndColumn 必须覆盖横向业务维度列（如门店、日期），不要把库存数量、可用数量、结余、合计等数值指标列当作 receiverStore",
        "tail_text_extract 可以和 text_record_split 组合使用：前者提取全局收货信息，后者提取物品行，试解析时文本物品行会继承全局字段",
        "正则要避免贪婪吞掉后续字段：电话只捕获手机号/座机号，姓名/门店/地址遇到 | 或下一个标签时应停止",
        "header_mapping.config 可包含 headerRowIndex、dataStartRowIndex、dataEndRowIndex、fieldColumns、requiredRowFields、skipRowRegex",
        "tail_text_extract.config 可包含 fieldRegex 或 keyValueLabels，用来从尾部/全文提取收货信息、外部编码等",
        "matrix_pivot.config 可包含 headerRowIndex、dataStartRowIndex、rowFieldColumns、matrixStartColumn、matrixEndColumn、excludeHeaderRegex、externalCodeTemplate",
        "split_multiline_cell.config 用于日期×门店、门店×日期等矩阵中单元格含多行物品的场景，可包含 headerRowIndex、dataStartRowIndex、dataEndRowIndex、rowFieldColumns、matrixStartColumn、matrixEndColumn、columnValueField、itemRegex、itemDelimiterRegex、skuNameGroup、skuQuantityGroup、skuSpecGroup、skuCodeGroup、skuCodeTemplate、defaultSkuCodePrefix、externalCodeTemplate、excludeHeaderRegex",
        "split_multiline_cell 的 rowFieldColumns 映射纵向固定字段，例如 receiverStore 或 externalCode；matrixStartColumn/matrixEndColumn 覆盖横向日期/门店列；columnValueField 指定横向列头落到哪个字段，通常可设为 note 或 receiverStore",
        "如果单元格内容是“物品名x数量\\n物品名x数量”，请启用 split_multiline_cell，itemRegex 可使用 \"([^\\\\n\\\\r,，;；|]+?)\\\\s*(?:x|X|×|\\\\*)\\\\s*(\\\\d+(?:\\\\.\\\\d+)?)\"，skuNameGroup=1，skuQuantityGroup=2",
        "card_split.config 可包含 startRegex、itemHeaderRegex、fieldRegex、itemColumns",
        "text_record_split.config 可包含 recordSeparatorRegex、fieldRegex、item.regex 及 skuCodeGroup、skuNameGroup、skuSpecGroup、skuQuantityGroup",
        "一个 PDF/Word 内有多张独立订单时，请用 text_record_split.recordSeparatorRegex 按分隔线或订单标题拆记录，再用 fieldRegex 和 item.regex 在每条记录内配对收货信息与物品明细",
        "如果文档是 PDF 或弱结构文本，请重点说明哪些字段需要通过尾部文本、分段或卡片拆分提取",
        "如果结构摘要里已经出现收货人、收货电话、收货地址、收货门店等键值，请优先依据这些信息给出风险说明",
        "如果明细行中 SKU 编码、名称、规格、单位、数量出现在同一行，请给出更明确的结构化建议",
        "如果 structureSummary.headerCandidates 给出了高分候选行，请优先选择该行作为 header_mapping.config.headerRowIndex，并基于该行列号输出 mapping 或 fieldColumns",
      ],
    },
    null,
    2,
  );
}

async function generateRuleWithLlm(document: Awaited<ReturnType<typeof parseImportDocument>>, fileType: SupportedImportFileType, inferredMapping: UniversalImportMapping) {
  const content = await createLlmChatCompletion({
    messages: [
      {
        role: "system",
        content:
          "你是物流万能导入规则设计助手。你要根据文档结构生成稳定、保守、可编辑的规则建议。必须返回合法 JSON，不要输出额外解释。",
      },
      {
        role: "user",
        content: buildPrompt(document, fileType),
      },
    ],
    temperature: 0.1,
    maxTokens: 2600,
    timeoutMs: AI_SUGGEST_TIMEOUT_MS,
    responseFormat: {
      type: "json_schema",
      json_schema: {
        name: "universal_import_rule_suggestion",
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });

  const parsed = parseAiJson(content);
  const confidenceReport = normalizeConfidenceReport(parsed.confidenceReport);
  const riskNotes = normalizeRiskNotes(parsed.riskNotes);
  const transformConfigs = isRecord(parsed.transformConfigs)
    ? parsed.transformConfigs as Record<string, Record<string, unknown>>
    : undefined;
  const aiMapping = mergeMappingCandidates(
    isRecord(parsed.mapping) ? parsed.mapping : undefined,
    getAiConfiguredFieldColumns(transformConfigs),
    inferredMapping,
  );
  const baseRule = createDefaultRuleDsl(aiMapping, fileType);
  const mode = parsed.mode ?? baseRule.mode;
  const mergedRule = ensureMultiSectionMerge(mergeTransformConfigs(mergeTransforms(
    {
      ...baseRule,
      mode,
      mapping: aiMapping,
    },
    normalizeEnabledTransforms(parsed.enabledTransforms),
  ), transformConfigs), document.sections.length);
  const headerRowIndex = getRecommendedHeaderRowIndex(document, mergedRule);
  const headerMapping = inferMappingFromHeaders(
    buildColumnOptions(document, headerRowIndex).map((option) => option.header),
  );
  const headerBackedMapping = mergeMappingCandidates(undefined, headerMapping, inferredMapping);
  const mapping = mergeMappingCandidates(
    isRecord(parsed.mapping) ? parsed.mapping : undefined,
    getAiConfiguredFieldColumns(transformConfigs),
    headerBackedMapping,
  );
  const headerRecommendedRule = applyHeaderRecommendation(mergedRule, headerRowIndex, mapping);
  const complexRecommendedRule = applyLocalComplexRecommendations(
    headerRecommendedRule,
    document,
    mapping,
    headerRowIndex,
  );
  const tailRecommended = applyKeyValueExtractionRecommendation(complexRecommendedRule, document);
  const suggestedRule = ensureGroupByExternalCode(tailRecommended.rule);

  const normalizedConfidenceReport =
      confidenceReport?.map((item) => ({
        field: item.field,
        confidence: Math.max(0, Math.min(1, item.confidence)),
        source: item.source || "llm",
      })) ??
      UNIVERSAL_IMPORT_FIELDS.map((field) => ({
        field: field.key,
        confidence:
          typeof mapping[field.key] === "number"
            ? 0.8
            : tailRecommended.extractedFields.includes(field.key)
              ? 0.78
              : 0.3,
        source: tailRecommended.extractedFields.includes(field.key) ? "tail-key-value" : "llm-default",
      }));

  return {
    suggestedRule: {
      ...suggestedRule,
      aiConfidenceReport: normalizedConfidenceReport,
    },
    confidenceReport: normalizedConfidenceReport,
    riskNotes: [
      ...riskNotes,
      tailRecommended.extractedFields.length > 0
        ? `检测到键值信息区，建议通过 tail_text_extract 提取：${tailRecommended.extractedFields.map((field) => UNIVERSAL_IMPORT_FIELDS.find((item) => item.key === field)?.label ?? field).join("、")}。`
        : "",
    ].filter(Boolean),
    aiSummary: parsed.summary,
  };
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

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "请上传样例文件后再生成建议。" }, { status: 400 });
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

    if (!isLlmConfigured()) {
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }

    try {
      const llmResult = await generateRuleWithLlm(document, fileType, inferredMapping);

      return NextResponse.json({
        documentSummary: buildDocumentSummary(fileType, document, llmResult.suggestedRule),
        suggestedRule: llmResult.suggestedRule,
        confidenceReport: llmResult.confidenceReport,
        riskNotes: llmResult.riskNotes,
        provider: getConfiguredLlmProvider(),
        model: getConfiguredLlmModel(),
        aiSummary: llmResult.aiSummary,
      });
    } catch (llmError) {
      console.error("LLM ai-suggest failed, fallback to heuristic", llmError);
      await sendDingTalkAlert({
        title: "万能导入 AI 规则生成降级",
        message: llmError instanceof Error ? llmError.message : "LLM 调用失败，已降级为本地兜底规则。",
        tags: {
          module: "ai-suggest",
          provider: getConfiguredLlmProvider(),
          model: getConfiguredLlmModel(),
          fileType,
          fileName: file.name,
        },
      });
      return NextResponse.json(createFallbackSuggestion(fileType, inferredMapping, document));
    }
  } catch (error) {
    console.error("POST /api/universal-import/templates/ai-suggest failed", error);
    await sendDingTalkAlert({
      title: "万能导入 AI 规则生成失败",
      message: error instanceof Error ? error.message : "AI 规则建议生成失败，请稍后重试。",
      tags: {
        module: "ai-suggest",
      },
    });
    return NextResponse.json({ error: "AI 规则建议生成失败，请稍后重试。" }, { status: 500 });
  }
}
