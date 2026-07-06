import * as XLSX from "xlsx";
import mammoth from "mammoth";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createEmptyRow,
  formatIssueLabel,
  inferMappingFromHeaders,
  normalizeNumericImportValue,
  UNIVERSAL_IMPORT_FIELDS,
  type UniversalImportField,
  type UniversalImportMapping,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import { ensurePdfRuntimePolyfills } from "@/lib/pdf-runtime-polyfills";

function suppressImageErrors<T>(fn: () => T): T {
  const originalError = console.error;
  const originalWarn = console.warn;
  const suppressedPatterns = [
    "Cannot read",
    "does not support image",
    "model does not support",
    "Inform the user",
  ];
  console.error = (...args: unknown[]) => {
    const message = args.map((a) => String(a)).join(" ");
    if (suppressedPatterns.some((p) => message.includes(p))) return;
    originalError.apply(console, args);
  };
  console.warn = (...args: unknown[]) => {
    const message = args.map((a) => String(a)).join(" ");
    if (suppressedPatterns.some((p) => message.includes(p))) return;
    originalWarn.apply(console, args);
  };
  function restore() {
    console.error = originalError;
    console.warn = originalWarn;
  }
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (e) {
    restore();
    throw e;
  }
}

export type SupportedImportFileType = "excel" | "word" | "pdf";

export type ParsedDocument = {
  fileType: SupportedImportFileType;
  sheetName: string;
  headers: string[];
  rawRows: string[][];
  textContent: string;
  sections: Array<{
    title: string;
    rows: string[][];
    text: string;
  }>;
};

export type RuleTransformType =
  | "header_mapping"
  | "multisheet_merge"
  | "group_by_external_code"
  | "matrix_pivot"
  | "split_multiline_cell"
  | "tail_text_extract"
  | "card_split"
  | "text_record_split";

export type UniversalImportRuleDsl = {
  fileType: SupportedImportFileType;
  mode: "mapping" | "text" | "structured";
  defaults?: Partial<Record<UniversalImportField, string>>;
  transforms: Array<{
    type: RuleTransformType;
    enabled: boolean;
    config?: Record<string, unknown>;
  }>;
  mapping: UniversalImportMapping;
  aiConfidenceReport?: Array<{
    field: UniversalImportField;
    confidence: number;
    source: string;
  }>;
};

export type RuleExecutionResult = {
  document: ParsedDocument;
  previewRows: UniversalImportRow[];
  issues: string[];
  issueCount: number;
  rowCount: number;
  summary: string[];
};

type PdfParseTextResult = {
  text?: string;
};

type PdfParseClass = new (options: { data: Buffer }) => {
  getText: () => Promise<PdfParseTextResult>;
  destroy?: () => Promise<void> | void;
};

type FieldRegexConfig = Partial<Record<UniversalImportField, string>>;

type TextItemConfig = {
  regex?: string;
  skuCode?: number | string;
  skuName?: number | string;
  skuSpec?: number | string;
  skuQuantity?: number | string;
  skuCodeGroup?: number | string;
  skuNameGroup?: number | string;
  skuSpecGroup?: number | string;
  skuQuantityGroup?: number | string;
};

type MatrixPivotConfig = {
  headerRowIndex?: number;
  dataStartRowIndex?: number;
  rowFieldColumns?: Partial<Record<UniversalImportField, number>>;
  matrixStartColumn?: number;
  matrixEndColumn?: number;
  excludeHeaderRegex?: string;
  externalCodeTemplate?: string;
};

type CardSplitConfig = {
  startRegex?: string;
  itemHeaderRegex?: string;
  fieldRegex?: FieldRegexConfig;
  keyValueLabels?: Partial<Record<UniversalImportField, string[]>>;
  itemColumns?: Partial<Record<UniversalImportField, number>>;
  excludeRowRegex?: string;
  externalCodeTemplate?: string;
};

type TextRecordSplitConfig = {
  recordSeparatorRegex?: string;
  fieldRegex?: FieldRegexConfig;
  item?: TextItemConfig;
};

type SplitMultilineCellConfig = {
  headerRowIndex?: number;
  dataStartRowIndex?: number;
  dataEndRowIndex?: number;
  rowFieldColumns?: Partial<Record<UniversalImportField, number>>;
  matrixStartColumn?: number;
  matrixEndColumn?: number;
  columnValueField?: UniversalImportField;
  itemRegex?: string;
  itemDelimiterRegex?: string;
  item?: TextItemConfig;
  skuCodeGroup?: number | string;
  skuNameGroup?: number | string;
  skuSpecGroup?: number | string;
  skuQuantityGroup?: number | string;
  skuCodeTemplate?: string;
  defaultSkuCodePrefix?: string;
  externalCodeTemplate?: string;
  excludeHeaderRegex?: string;
};

type GroupByExternalCodeConfig = {
  keyField?: UniversalImportField;
  inheritBlankKey?: boolean;
  inheritedFields?: UniversalImportField[];
};

function normalizeCell(value: unknown) {
  return String(value ?? "").trim();
}

function isNonEmptyRow(row: unknown[]) {
  return row.some((cell) => normalizeCell(cell) !== "");
}

function splitLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function rowToSearchText(row: string[]) {
  return row.map((cell) => normalizeCell(cell)).join(" | ");
}

function normalizeRows(rows: unknown[][]) {
  return rows.filter(isNonEmptyRow).map((row) => row.map((cell) => normalizeCell(cell)));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureUniqueExternalCode(prefix: string, index: number) {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function toExternalCodePart(value: string) {
  return value.replace(/\s+/g, "").replace(/[\\/:*?"<>|]+/g, "").slice(0, 40) || "AUTO";
}

function isPositiveQuantity(value: string) {
  return /^\d+(?:\.\d+)?$/.test(value.trim()) && Number(value) > 0;
}

function isSkuCodeLike(value: string) {
  return /[A-Za-z]{2,}[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*/.test(value.trim());
}

function findSkuCodeMatch(value: string) {
  return value.trim().match(/([A-Za-z]{2,}[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*)\s*(.*)/);
}

function isUnitLike(value: string) {
  return /^(?:件|瓶|包|箱|盒|袋|桶|套|个|支|条|片|斤|kg|g|l|ml)$/i.test(value.trim());
}

function isRepeatedTableHeaderValue(value: string) {
  return /^(?:物品编码|商品编码|SKU编码|编码|物品名称|商品名称|SKU名称|品名|规格型号|规格|订货单位|发货数量|数量|备注)$/i.test(value.trim());
}

function isRepeatedTableHeaderRow(values: Partial<Record<UniversalImportField, string>>) {
  const populated = [values.skuCode, values.skuName, values.skuQuantity]
    .map((value) => normalizeCell(value))
    .filter(Boolean);

  return populated.length > 0 && populated.every(isRepeatedTableHeaderValue);
}

function splitNameAndSpec(value: string) {
  const normalized = value.trim();
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) {
    return {
      skuName: normalized,
      skuSpec: "",
    };
  }

  const maybeSpec = parts.at(-1) ?? "";
  if (!/(?:\d|kg|g|l|ml|码|件|包|瓶|桶|盒|箱|袋|套|个)/i.test(maybeSpec)) {
    return {
      skuName: normalized,
      skuSpec: "",
    };
  }

  return {
    skuName: parts.slice(0, -1).join(" "),
    skuSpec: maybeSpec,
  };
}

function isMetricLikeMatrixHeader(value: string) {
  return /^(?:\d+(?:\.\d+)?)$/.test(value) || /(合计|结余|库存|数量|在库|可用|冻结|分配|待移入)/.test(value);
}

function normalizeKeyValueLabel(value: unknown) {
  return String(value ?? "")
    .replace(/^[\[\【].*?[\]\】]\s*/g, "")
    .replace(/[：:]\s*$/g, "")
    .trim();
}

function normalizeKeyValueToken(value: unknown) {
  return normalizeKeyValueLabel(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[*＊]/g, "")
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}<>【】“”"'`‘’、，。；：！？,.!?/\\|]/g, "");
}

function isLikelyKeyValueLabel(value: unknown) {
  if (/^【[^】]+】\S{1,24}$/.test(normalizeCell(value))) {
    return true;
  }

  const normalized = normalizeKeyValueToken(value);
  if (!normalized) {
    return false;
  }

  const extraLabels = ["备用联系人", "备用联系电话", "创建日期", "创建人", "审核人", "制单人", "签字"];
  return [...UNIVERSAL_IMPORT_FIELDS.flatMap((field) => field.aliases), ...extraLabels].some(
    (alias) => normalizeKeyValueToken(alias) === normalized,
  );
}

function findAdjacentKeyValue(row: string[], index: number) {
  for (let currentIndex = index + 1; currentIndex < Math.min(row.length, index + 8); currentIndex += 1) {
    const value = normalizeCell(row[currentIndex]);
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

function isSameKeyValueLabel(left: unknown, right: unknown) {
  const normalizedLeft = normalizeKeyValueToken(left);
  const normalizedRight = normalizeKeyValueToken(right);
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
}

function isKeyValueSummaryRow(row: string[]) {
  const populated = row.map((cell) => normalizeCell(cell)).filter(Boolean);
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
  const populated = row.map((cell) => normalizeCell(cell)).filter(Boolean);
  if (populated.length < 8) {
    return false;
  }

  const labelLikeCount = populated.filter((cell) => {
    const normalized = normalizeKeyValueToken(cell);
    return (
      isLikelyKeyValueLabel(cell) ||
      /(?:序号|行号|分类|品牌|单位|仓库|日期|备注|状态|批次|规格|型号|金额|单价|成本|体积|重量|数量|电话|地址|联系人|机构|单号)/.test(
        normalized,
      )
    );
  }).length;

  return labelLikeCount / populated.length >= 0.45;
}

function cleanExtractedField(field: UniversalImportField, value: string) {
  const normalized = value
    .replace(/\s+/g, " ")
    .replace(/\s+(?:收货电话|收货地址|收货人|电话|地址|门店|机构)[:：].*$/i, "")
    .trim();
  if (!normalized) {
    return "";
  }

  if (field === "receiverPhone") {
    return normalized.match(/(?:1\d{10}|(?:0\d{2,3}-?)?\d{7,8})/)?.[0] ?? normalized;
  }

  const segments = normalized
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/^[^:：]{1,12}[:：]$/.test(segment));

  if (segments.length > 0) {
    return segments[0];
  }

  return normalized === "|" ? "" : normalized;
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

function rowFromValues(values: Partial<UniversalImportRow>, rowIndex: number): UniversalImportRow {
  const normalizedValues = { ...values };
  if (normalizedValues.skuQuantity) {
    normalizedValues.skuQuantity = normalizeNumericImportValue(normalizedValues.skuQuantity);
  }

  return {
    ...createEmptyRow(rowIndex),
    ...normalizedValues,
    rowIndex,
  };
}

function normalizeFieldList(value: unknown, fallback: UniversalImportField[]) {
  if (!Array.isArray(value)) {
    return fallback;
  }

  const fields = value
    .map((item) => String(item))
    .filter(isImportField);

  return fields.length > 0 ? fields : fallback;
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isImportField(value: string): value is UniversalImportField {
  return UNIVERSAL_IMPORT_FIELDS.some((field) => field.key === value);
}

function normalizeColumnIndex(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }

  return null;
}

function normalizeFieldColumnMap(value: unknown) {
  const output: Partial<Record<UniversalImportField, number>> = {};

  if (isRecord(value)) {
    Object.entries(value).forEach(([field, column]) => {
      const columnIndex = normalizeColumnIndex(column);
      if (isImportField(field) && columnIndex !== null) {
        output[field] = columnIndex;
      }
    });
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (!isRecord(item)) {
        return;
      }

      const field = String(item.field ?? item.key ?? item.targetField ?? "");
      const columnIndex = normalizeColumnIndex(item.columnIndex ?? item.column ?? item.index);
      if (isImportField(field) && columnIndex !== null) {
        output[field] = columnIndex;
      }
    });
  }

  return output;
}

function hasAnyColumn(columns: Partial<Record<UniversalImportField, number>>) {
  return Object.keys(columns).length > 0;
}

function normalizeFieldRegexMap(value: unknown) {
  const output: FieldRegexConfig = {};

  if (isRecord(value)) {
    Object.entries(value).forEach(([field, pattern]) => {
      if (isImportField(field) && typeof pattern === "string" && pattern.trim()) {
        output[field] = pattern;
      }
    });
  }

  if (Array.isArray(value)) {
    value.forEach((item) => {
      if (typeof item === "string") {
        const namedGroups = Array.from(item.matchAll(/\?<([A-Za-z]\w*)>/g));
        namedGroups.forEach((match) => {
          const field = match[1];
          if (isImportField(field) && !output[field]) {
            output[field] = item;
          }
        });
        return;
      }

      if (!isRecord(item)) {
        return;
      }

      const field = String(item.field ?? item.key ?? item.targetField ?? "");
      const pattern = item.regex ?? item.pattern;
      if (isImportField(field) && typeof pattern === "string" && pattern.trim()) {
        output[field] = pattern;
      }
    });
  }

  return output;
}

function normalizeTransformConfig(config: Record<string, unknown> | undefined) {
  if (!isRecord(config)) {
    return {};
  }

  const nested = isRecord(config.config) ? normalizeTransformConfig(config.config) : {};
  const output: Record<string, unknown> = {};

  Object.entries(config).forEach(([key, value]) => {
    if (key !== "config" && key !== "type") {
      output[key] = value;
    }
  });

  Object.assign(output, nested);

  if ("fieldColumns" in output) {
    output.fieldColumns = normalizeFieldColumnMap(output.fieldColumns);
  }

  if ("rowFieldColumns" in output) {
    output.rowFieldColumns = normalizeFieldColumnMap(output.rowFieldColumns);
  }

  if ("itemColumns" in output) {
    output.itemColumns = normalizeFieldColumnMap(output.itemColumns);
  }

  if ("fieldRegex" in output) {
    output.fieldRegex = normalizeFieldRegexMap(output.fieldRegex);
  }

  if (isRecord(output.item)) {
    output.item = {
      ...output.item,
      skuCodeGroup: output.item.skuCode ?? output.item.skuCodeGroup,
      skuNameGroup: output.item.skuName ?? output.item.skuNameGroup,
      skuSpecGroup: output.item.skuSpec ?? output.item.skuSpecGroup,
      skuQuantityGroup: output.item.skuQuantity ?? output.item.skuQuantityGroup,
    };
  }

  return output;
}

function normalizeRuleDsl(rule: UniversalImportRuleDsl) {
  return {
    ...rule,
    transforms: rule.transforms.map((transform) => ({
      ...transform,
      config: normalizeTransformConfig(transform.config),
    })),
  } satisfies UniversalImportRuleDsl;
}

function getTransform(rule: UniversalImportRuleDsl, type: RuleTransformType) {
  return rule.transforms.find((transform) => transform.type === type && transform.enabled);
}

function getCompositeTransformConfig(rule: UniversalImportRuleDsl, key: string) {
  const multiSheetTransform = getTransform(rule, "multisheet_merge");
  const config = multiSheetTransform?.config;
  if (!isRecord(config)) {
    return {};
  }

  return normalizeTransformConfig(config[key] as Record<string, unknown> | undefined);
}

function getFirstCompositeTransformConfig(rule: UniversalImportRuleDsl, keys: string[]) {
  for (const key of keys) {
    const config = getCompositeTransformConfig(rule, key);
    if (Object.keys(config).length > 0) {
      return config;
    }
  }

  return {};
}

function getFieldColumns(config: Record<string, unknown> | undefined, rule: UniversalImportRuleDsl) {
  const configured = normalizeFieldColumnMap(config?.fieldColumns);
  if (hasAnyColumn(configured)) {
    return configured;
  }

  return rule.mapping;
}

function getColumnValue(row: string[], column: unknown) {
  return typeof column === "number" && column >= 0 ? row[column] ?? "" : "";
}

function createRegex(pattern: string | undefined, flags = "i") {
  if (!pattern) {
    return null;
  }

  try {
    const dotAll = pattern.includes("(?s)");
    const normalizedPattern = pattern.replaceAll("(?s)", "");
    const normalizedFlags = dotAll && !flags.includes("s") ? `${flags}s` : flags;
    return new RegExp(normalizedPattern, normalizedFlags);
  } catch {
    return null;
  }
}

function createRelaxedKeyValueRegex(pattern: string | undefined, flags = "i") {
  if (!pattern) {
    return null;
  }

  const relaxedPattern = pattern
    .replaceAll("[:：]\\s*", "(?:[:：|])\\s*")
    .replaceAll("[:：]", "(?:[:：|])")
    .replace(/\\s\+/g, "\\s*(?:\\|\\s*)?");

  return createRegex(relaxedPattern, flags);
}

function regexMatchesText(pattern: string | undefined, text: string) {
  const regex = createRegex(pattern, "i");
  if (regex?.test(text)) {
    return true;
  }

  const compactText = text.replace(/[\s|]+/g, "");
  if (compactText && regex?.test(compactText)) {
    return true;
  }

  return Boolean(createRelaxedKeyValueRegex(pattern, "i")?.test(text));
}

function extractTextField(text: string, pattern: string | undefined) {
  const regex = createRegex(pattern, "im") ?? createRelaxedKeyValueRegex(pattern, "im");
  if (!regex) {
    return "";
  }

  let match = text.match(regex);
  if (!match) {
    match = text.match(createRelaxedKeyValueRegex(pattern, "im") ?? regex);
  }

  if (!match) {
    return "";
  }

  const namedField = match.groups ? Object.values(match.groups).find(Boolean) : "";
  return (namedField || match[1] || "").replace(/\s+/g, " ").trim();
}

function extractFieldsByRegex(text: string, fieldRegex: unknown) {
  const output: Partial<Record<UniversalImportField, string>> = {};
  const normalized = normalizeFieldRegexMap(fieldRegex);

  (Object.keys(normalized) as UniversalImportField[]).forEach((field) => {
    const regex = createRegex(normalized[field], "im") ?? createRelaxedKeyValueRegex(normalized[field], "im");
    if (!regex) {
      return;
    }

    let match = text.match(regex);
    if (!match) {
      match = text.match(createRelaxedKeyValueRegex(normalized[field], "im") ?? regex);
    }

    if (!match) {
      return;
    }

    const extractedValue = cleanExtractedField(
      field,
      match.groups?.[field]?.replace(/\s+/g, " ").trim() ?? extractTextField(text, normalized[field]),
    );
    if (shouldAcceptFieldValue(field, extractedValue)) {
      output[field] = extractedValue;
    }
  });

  return output;
}

function extractLeadingLiteral(pattern: string | undefined) {
  if (!pattern) {
    return "";
  }

  const index = pattern.search(/(?:\[:：\]|\\s|\(|\[|\.|\*|\+|\?|\^|\$|\|)/);
  return pattern
    .slice(0, index >= 0 ? index : pattern.length)
    .replace(/\\/g, "")
    .trim();
}

function isWeakExtractedValue(value: string | undefined) {
  return !value || value === "|" || /^[\s|]+$/.test(value);
}

function isPhoneLikeValue(value: unknown) {
  return /^(?:1\d{10}|(?:0\d{2,3}-?)?\d{7,8})$/.test(normalizeCell(value).replace(/\s+/g, ""));
}

function isContactPhoneLabelValue(value: unknown) {
  const normalized = normalizeKeyValueToken(value);
  return /^(?:收件人电话|收货人电话|收件人手机号|收货人手机号|联系电话|联系方式|手机号|手机|电话|号码)$/.test(normalized);
}

function shouldAcceptFieldValue(field: UniversalImportField, value: string) {
  if (
    (field === "receiverStore" || field === "receiverName" || field === "receiverPhone" || field === "receiverAddress") &&
    isLikelyKeyValueLabel(value)
  ) {
    return false;
  }

  if (field === "receiverName" && (isPhoneLikeValue(value) || isContactPhoneLabelValue(value))) {
    return false;
  }

  return true;
}

function isWeakExtractedFieldValue(field: UniversalImportField, value: string | undefined) {
  return isWeakExtractedValue(value) || !shouldAcceptFieldValue(field, value ?? "");
}

function extractAdjacentKeyValueFields(
  section: ParsedDocument["sections"][number],
  fieldRegex: unknown,
  current: Partial<Record<UniversalImportField, string>>,
) {
  const normalized = normalizeFieldRegexMap(fieldRegex);

  (Object.keys(normalized) as UniversalImportField[]).forEach((field) => {
    if (!isWeakExtractedFieldValue(field, current[field])) {
      return;
    }

    const label = extractLeadingLiteral(normalized[field]);
    if (!label) {
      return;
    }

    for (const row of section.rows) {
      const labelIndex = row.findIndex((cell) => {
        const normalizedCell = normalizeCell(cell).replace(/[:：]$/, "");
        return normalizedCell === label || regexMatchesText(normalized[field], normalizedCell);
      });
      if (labelIndex < 0) {
        continue;
      }

      const value = row.slice(labelIndex + 1).map((cell) => normalizeCell(cell)).find(Boolean);
      const extractedValue = cleanExtractedField(field, value ?? "");
      if (extractedValue && shouldAcceptFieldValue(field, extractedValue)) {
        current[field] = extractedValue;
        return;
      }
    }
  });

  return current;
}

function extractFieldsByKeyValueLabels(
  rows: string[][],
  keyValueLabels: unknown,
  current: Partial<Record<UniversalImportField, string>>,
) {
  if (!isRecord(keyValueLabels)) {
    return current;
  }

  (Object.keys(keyValueLabels) as UniversalImportField[]).forEach((field) => {
    if (!isImportField(field) || !isWeakExtractedFieldValue(field, current[field])) {
      return;
    }

    const labels = asStringArray(keyValueLabels[field]);
    if (labels.length === 0) {
      return;
    }

    for (const row of rows) {
      const labelIndex = row.findIndex((cell) => {
        return labels.some((label) => isSameKeyValueLabel(cell, label));
      });

      if (labelIndex < 0) {
        continue;
      }

      const value = row.slice(labelIndex + 1).map((cell) => normalizeCell(cell)).find(Boolean);
      const extractedValue = cleanExtractedField(field, value ?? "");
      if (extractedValue && shouldAcceptFieldValue(field, extractedValue)) {
        current[field] = extractedValue;
        return current;
      }
    }

    return;
  });

  return current;
}

function interpolate(template: string | undefined, values: Record<string, string>) {
  if (!template) {
    return "";
  }

  return template.replace(/\{(\w+)\}/g, (_token, key: string) => values[key] ?? "");
}

async function loadPdfParseModule() {
  ensurePdfRuntimePolyfills();

  return (await import("pdf-parse")) as unknown as {
    PDFParse?: PdfParseClass;
    default?: (buffer: Buffer) => Promise<PdfParseTextResult>;
  };
}

async function parseExcelDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const workbook = suppressImageErrors(() => XLSX.read(fileBuffer, { type: "buffer" }));
  const sections: ParsedDocument["sections"] = [];

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      return;
    }

    const matrix = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][];
    const rows = normalizeRows(matrix);

    sections.push({
      title: sheetName,
      rows,
      text: rows.map((row) => row.join(" | ")).join("\n"),
    });
  });

  const firstSection = sections[0];
  const headers = firstSection?.rows[asNumber(undefined, 0)] ?? [];

  return {
    fileType: "excel",
    sheetName: workbook.SheetNames[0] ?? originalFileName ?? "Sheet1",
    headers,
    rawRows: firstSection?.rows.slice(1) ?? [],
    textContent: sections.map((section) => section.text).join("\n\n"),
    sections,
  };
}

async function parseWordDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const result = await suppressImageErrors(() => mammoth.extractRawText({ buffer: fileBuffer }));
  const text = result.value ?? "";
  const rows = splitLines(text).map((line) => line.split(/[|\t]/).map((cell) => cell.trim()).filter(Boolean));

  return {
    fileType: "word",
    sheetName: originalFileName || "Word Document",
    headers: rows[0] ?? [],
    rawRows: rows.slice(1),
    textContent: text,
    sections: [
      {
        title: "document",
        rows,
        text,
      },
    ],
  };
}

async function parsePdfDocument(fileBuffer: Buffer, originalFileName: string): Promise<ParsedDocument> {
  const pdfParseModule = await loadPdfParseModule();
  const moduleWithCtor = pdfParseModule as unknown as { PDFParse?: PdfParseClass };
  const moduleWithDefault = pdfParseModule;

  let text = await suppressImageErrors(async () => {
    if (moduleWithCtor.PDFParse) {
      if (typeof (moduleWithCtor.PDFParse as PdfParseClass & { setWorker?: (value: string) => void }).setWorker === "function") {
        const workerPath = path.resolve(process.cwd(), "node_modules", "pdf-parse", "dist", "pdf-parse", "cjs", "pdf.worker.mjs");
        (moduleWithCtor.PDFParse as PdfParseClass & { setWorker?: (value: string) => void }).setWorker?.(
          pathToFileURL(workerPath).href,
        );
      }

      const parser = new moduleWithCtor.PDFParse({ data: fileBuffer });

      try {
        const result = await parser.getText();
        return result.text ?? "";
      } finally {
        await parser.destroy?.();
      }
    } else if (typeof moduleWithDefault.default === "function") {
      const result = await moduleWithDefault.default(fileBuffer);
      return result.text ?? "";
    } else {
      throw new Error("Unsupported pdf-parse module shape");
    }
  });

  const lines = splitLines(text);
  const rows = lines.map((line) => line.split(/\t+|\s{2,}/).map((cell) => cell.trim()).filter(Boolean));

  return {
    fileType: "pdf",
    sheetName: originalFileName || "PDF Document",
    headers: [],
    rawRows: [],
    textContent: text,
    sections: [
      {
        title: "pdf",
        rows,
        text,
      },
    ],
  };
}

export async function parseImportDocument(options: {
  fileBuffer: Buffer;
  fileType: SupportedImportFileType;
  originalFileName: string;
}) {
  if (options.fileType === "word") {
    return parseWordDocument(options.fileBuffer, options.originalFileName);
  }

  if (options.fileType === "pdf") {
    return parsePdfDocument(options.fileBuffer, options.originalFileName);
  }

  return parseExcelDocument(options.fileBuffer, options.originalFileName);
}

function findConfiguredHeaderIndex(rows: string[][], config: Record<string, unknown> | undefined) {
  const explicit = config?.headerRowIndex;
  if (typeof explicit === "number" && explicit >= 0) {
    return explicit;
  }

  const requiredHeaders = asStringArray(config?.requiredHeaders);
  if (requiredHeaders.length > 0) {
    const required = requiredHeaders.map((item) => item.toLowerCase());
    const index = rows.findIndex((row) => {
      const joined = row.join(" ").toLowerCase();
      return required.every((item) => joined.includes(item.toLowerCase()));
    });

    if (index >= 0) {
      return index;
    }
  }

  return 0;
}

function extractTailFields(
  document: ParsedDocument,
  section: ParsedDocument["sections"][number],
  config: Record<string, unknown> | undefined,
) {
  const source = asString(config?.source || config?.scope, "section_text");
  const text = source === "full_text" || source === "document" ? document.textContent : section.text;
  const output: Partial<Record<UniversalImportField, string>> = extractFieldsByRegex(text, config?.fieldRegex);
  extractAdjacentKeyValueFields(section, config?.fieldRegex, output);

  const keyValueLabels = config?.keyValueLabels;
  if (keyValueLabels && typeof keyValueLabels === "object" && !Array.isArray(keyValueLabels)) {
    const labels = keyValueLabels as Partial<Record<UniversalImportField, string[]>>;
    const keyValueRows = source === "full_text" || source === "document"
      ? document.sections.flatMap((documentSection) => documentSection.rows)
      : section.rows;

    keyValueRows.forEach((row) => {
      if (isDenseTableHeaderRow(row) && !isKeyValueSummaryRow(row)) {
        return;
      }

      row.forEach((cell, index) => {
        (Object.keys(labels) as UniversalImportField[]).forEach((field) => {
          const candidates = labels[field] ?? [];
          const inlineKeyValue = parseInlineKeyValueCell(cell);
          const inlineMatched = inlineKeyValue
            ? candidates.some((label) => isSameKeyValueLabel(inlineKeyValue.label, label))
            : false;
          if (isWeakExtractedFieldValue(field, output[field]) && inlineMatched) {
            const extractedValue = cleanExtractedField(field, inlineKeyValue?.value ?? "");
            if (shouldAcceptFieldValue(field, extractedValue)) {
              output[field] = extractedValue;
            }
            return;
          }

          if (isWeakExtractedFieldValue(field, output[field]) && candidates.some((label) => isSameKeyValueLabel(cell, label))) {
            const extractedValue = cleanExtractedField(field, findAdjacentKeyValue(row, index));
            if (shouldAcceptFieldValue(field, extractedValue)) {
              output[field] = extractedValue;
            }
          }
        });
      });
    });
  }

  return output;
}

function parseRowsByMapping(
  section: ParsedDocument["sections"][number],
  rule: UniversalImportRuleDsl,
  config: Record<string, unknown> | undefined,
  baseValues: Partial<Record<UniversalImportField, string>>,
  rowOffset: number,
) {
  const rows = section.rows;
  const headerIndex = findConfiguredHeaderIndex(rows, config);
  const dataStartRowIndex = asNumber(config?.dataStartRowIndex, headerIndex + 1);
  const dataEndRowIndex = asNumber(config?.dataEndRowIndex, rows.length);
  const columns = getFieldColumns(config, rule);
  const skipRowRegex = createRegex(asString(config?.skipRowRegex), "i");
  const requiredFields = asStringArray(config?.requiredRowFields) as UniversalImportField[];
  const output: UniversalImportRow[] = [];
  const sourceRows = rows.slice(dataStartRowIndex, dataEndRowIndex);

  sourceRows.forEach((sourceRow, relativeIndex) => {
    const joined = sourceRow.join(" ");
    if (!joined.trim() || skipRowRegex?.test(joined) || isKeyValueSummaryRow(sourceRow)) {
      return;
    }

    const values: Partial<Record<UniversalImportField, string>> = { ...baseValues };
    const rowContext = toInterpolationValues({
      sectionTitle: section.title,
      rowIndex: rowOffset + output.length + 1,
      sourceRowIndex: dataStartRowIndex + relativeIndex + 1,
    });
    (Object.keys(columns) as UniversalImportField[]).forEach((field) => {
      const value = getColumnValue(sourceRow, columns[field]);
      if (value && shouldAcceptFieldValue(field, value)) {
        values[field] = value;
      }
    });

    const mappedSkuCodeMatch = findSkuCodeMatch(normalizeCell(values.skuCode));
    if (mappedSkuCodeMatch?.[2]) {
      const split = splitNameAndSpec(mappedSkuCodeMatch[2]);
      const currentSkuName = normalizeCell(values.skuName);
      values.skuCode = mappedSkuCodeMatch[1];
      if (!currentSkuName || isUnitLike(currentSkuName)) {
        values.skuName = split.skuName;
      }
      if (!normalizeCell(values.skuSpec) || isPositiveQuantity(normalizeCell(values.skuSpec))) {
        values.skuSpec = split.skuSpec;
      }
    }

    if (!normalizeCell(values.skuCode) || !normalizeCell(values.skuName)) {
      const skuCell = sourceRow.find((cell) => isSkuCodeLike(cell));
      const skuMatch = skuCell ? findSkuCodeMatch(skuCell) : null;
      if (skuMatch) {
        const split = splitNameAndSpec(skuMatch[2] ?? "");
        values.skuCode = normalizeCell(values.skuCode) || skuMatch[1];
        values.skuName = normalizeCell(values.skuName) || split.skuName;
        values.skuSpec = normalizeCell(values.skuSpec) || split.skuSpec;
      }
    }

    if (!isPositiveQuantity(normalizeCell(values.skuQuantity))) {
      const quantityCandidates = sourceRow.length > 1 ? sourceRow.slice(1) : sourceRow;
      const lastPositiveQuantity = quantityCandidates.slice().reverse().find((cell) => isPositiveQuantity(cell));
      const nextRow = sourceRows[relativeIndex + 1] ?? [];
      const nextRowContinuationQuantity = nextRow.some(isSkuCodeLike)
        ? ""
        : nextRow.slice().reverse().find((cell) => isPositiveQuantity(cell));
      if (lastPositiveQuantity) {
        values.skuQuantity = lastPositiveQuantity;
      } else if (nextRowContinuationQuantity) {
        values.skuQuantity = nextRowContinuationQuantity;
      }
    }

    if (isRepeatedTableHeaderRow(values)) {
      return;
    }

    if (!normalizeCell(values.externalCode)) {
      values.externalCode = interpolate(asString(config?.externalCodeTemplate), rowContext);
    }

    const hasRequiredValues = requiredFields.length
      ? requiredFields.every((field) => normalizeCell(values[field]))
      : Boolean(values.skuCode || values.skuName || values.skuQuantity);

    if (!hasRequiredValues) {
      return;
    }

    output.push(rowFromValues(values, rowOffset + output.length + 1));
  });

  return output;
}

function parseMatrix(section: ParsedDocument["sections"][number], config: MatrixPivotConfig, rowOffset: number) {
  const rows = section.rows;
  const headerRowIndex = asNumber(config.headerRowIndex, 0);
  const headerRowCandidates = headerRowIndex > 0 ? [headerRowIndex, headerRowIndex - 1] : [headerRowIndex];
  const output: UniversalImportRow[] = [];

  for (const candidateHeaderRowIndex of headerRowCandidates) {
    const candidateRows = parseMatrixWithHeader(section, config, rowOffset, candidateHeaderRowIndex);
    if (candidateRows.length > 0) {
      return candidateRows;
    }
  }

  return output;
}

function parseMatrixWithHeader(
  section: ParsedDocument["sections"][number],
  config: MatrixPivotConfig,
  rowOffset: number,
  headerRowIndex: number,
) {
  const rows = section.rows;
  const header = rows[headerRowIndex] ?? [];
  const dataStart = asNumber(config.dataStartRowIndex, headerRowIndex + 1);
  const matrixStart = asNumber(config.matrixStartColumn, 0);
  const matrixEnd = asNumber(config.matrixEndColumn, header.length - 1);
  const configuredRowColumns = normalizeFieldColumnMap(config.rowFieldColumns);
  const inferredRowColumns = inferMappingFromHeaders(header);
  const rowColumns = hasAnyColumn(configuredRowColumns) ? configuredRowColumns : inferredRowColumns;
  const excludeRegex = createRegex(config.excludeHeaderRegex, "i");
  const output: UniversalImportRow[] = [];

  rows.slice(dataStart).forEach((sourceRow) => {
    const baseValues: Partial<Record<UniversalImportField, string>> = {};
    (Object.keys(rowColumns) as UniversalImportField[]).forEach((field) => {
      baseValues[field] = getColumnValue(sourceRow, rowColumns[field]);
    });

    for (let columnIndex = matrixStart; columnIndex <= matrixEnd; columnIndex += 1) {
      const receiverStore = normalizeCell(header[columnIndex]);
      const quantity = normalizeCell(sourceRow[columnIndex]);
      if (!receiverStore || isMetricLikeMatrixHeader(receiverStore) || excludeRegex?.test(receiverStore) || !isPositiveQuantity(quantity)) {
        continue;
      }

      output.push(
        rowFromValues(
          {
            ...baseValues,
            externalCode:
              interpolate(config.externalCodeTemplate, { receiverStore, columnIndex: String(columnIndex) }) ||
              `MATRIX-${toExternalCodePart(receiverStore)}`,
            receiverStore,
            skuQuantity: quantity,
          },
          rowOffset + output.length + 1,
        ),
      );
    }
  });

  return output;
}

function getCapture(match: RegExpExecArray, group: number | string | undefined, fallbackGroup: number) {
  if (typeof group === "string") {
    return match.groups?.[group] ?? "";
  }

  return match[asNumber(group, fallbackGroup)] ?? "";
}

function getOptionalCapture(match: RegExpExecArray, group: number | string | undefined) {
  if (typeof group === "string") {
    return match.groups?.[group] ?? "";
  }

  return typeof group === "number" ? match[group] ?? "" : "";
}

function toInterpolationValues(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, String(value ?? "")]));
}

function parseSplitMultilineCells(
  section: ParsedDocument["sections"][number],
  config: SplitMultilineCellConfig,
  rowOffset: number,
) {
  const rows = section.rows;
  const headerRowIndex = asNumber(config.headerRowIndex, 0);
  const header = rows[headerRowIndex] ?? [];
  const dataStart = asNumber(config.dataStartRowIndex, headerRowIndex + 1);
  const dataEnd = asNumber(config.dataEndRowIndex, rows.length);
  const matrixStart = asNumber(config.matrixStartColumn, 0);
  const matrixEnd = asNumber(config.matrixEndColumn, header.length - 1);
  const rowColumns = normalizeFieldColumnMap(config.rowFieldColumns);
  const excludeRegex = createRegex(config.excludeHeaderRegex, "i");
  const itemConfig = isRecord(config.item) ? config.item as TextItemConfig : {};
  const itemRegexPattern =
    itemConfig.regex ||
    config.itemRegex ||
    "([^\\n\\r,，;；|]+?)\\s*(?:x|X|×|\\*)\\s*(\\d+(?:\\.\\d+)?)";
  const itemRegex = createRegex(itemRegexPattern, "gim");
  const delimiterRegex = createRegex(config.itemDelimiterRegex, "g");
  const output: UniversalImportRow[] = [];

  if (!itemRegex) {
    return output;
  }

  rows.slice(dataStart, dataEnd).forEach((sourceRow) => {
    const baseValues: Partial<Record<UniversalImportField, string>> = {};
    (Object.keys(rowColumns) as UniversalImportField[]).forEach((field) => {
      const value = getColumnValue(sourceRow, rowColumns[field]);
      if (value) {
        baseValues[field] = value;
      }
    });

    for (let columnIndex = matrixStart; columnIndex <= matrixEnd; columnIndex += 1) {
      const columnHeader = normalizeCell(header[columnIndex]);
      const cellValue = normalizeCell(sourceRow[columnIndex]);
      if (!cellValue || excludeRegex?.test(columnHeader)) {
        continue;
      }

      const cellChunks = delimiterRegex
        ? cellValue.split(delimiterRegex).filter((chunk) => chunk.trim())
        : [cellValue];

      cellChunks.forEach((chunk) => {
        itemRegex.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = itemRegex.exec(chunk)) !== null) {
          const skuName = getOptionalCapture(match, itemConfig.skuNameGroup ?? config.skuNameGroup) || match[1] || "";
          const skuQuantity = getOptionalCapture(match, itemConfig.skuQuantityGroup ?? config.skuQuantityGroup) || match[2] || "";
          const skuSpec = getOptionalCapture(match, itemConfig.skuSpecGroup ?? config.skuSpecGroup);
          const context = toInterpolationValues({
            ...baseValues,
            sectionTitle: section.title,
            columnHeader,
            columnIndex,
            cellValue,
            skuName,
            skuQuantity,
            skuSpec,
            itemIndex: output.length + 1,
          });
          const skuCode =
            getOptionalCapture(match, itemConfig.skuCodeGroup ?? config.skuCodeGroup) ||
            interpolate(config.skuCodeTemplate, context) ||
            `${asString(config.defaultSkuCodePrefix, "AUTO-SKU")}-${toExternalCodePart(skuName)}`;

          if (!skuName || !isPositiveQuantity(skuQuantity)) {
            continue;
          }

          const values: Partial<Record<UniversalImportField, string>> = {
            ...baseValues,
            externalCode:
              baseValues.externalCode ||
              interpolate(config.externalCodeTemplate, context) ||
              `CELL-${toExternalCodePart(baseValues.receiverStore || section.title)}-${toExternalCodePart(columnHeader || String(columnIndex))}`,
            skuCode,
            skuName,
            skuSpec,
            skuQuantity,
          };

          if (config.columnValueField && isImportField(config.columnValueField) && columnHeader) {
            values[config.columnValueField] = columnHeader;
          }

          output.push(rowFromValues(values, rowOffset + output.length + 1));
        }
      });
    }
  });

  return output;
}

function parseTextItems(
  text: string,
  itemConfig: TextItemConfig | undefined,
  baseValues: Partial<Record<UniversalImportField, string>>,
  rowOffset: number,
) {
  const regex = createRegex(itemConfig?.regex, "gim");
  if (!regex) {
    return [];
  }

  const output: UniversalImportRow[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const skuCode = getCapture(match, itemConfig?.skuCodeGroup, 1);
    const skuName = getCapture(match, itemConfig?.skuNameGroup, 2);
    const skuSpec = getCapture(match, itemConfig?.skuSpecGroup, 3);
    const skuQuantity = getCapture(match, itemConfig?.skuQuantityGroup, 4);

    if (!isSkuCodeLike(skuCode) || !skuName || !isPositiveQuantity(skuQuantity)) {
      continue;
    }

    output.push(
      rowFromValues(
        {
          ...baseValues,
          skuCode,
          skuName,
          skuSpec,
          skuQuantity,
        },
        rowOffset + output.length + 1,
      ),
    );
  }

  return output;
}

function parseCards(section: ParsedDocument["sections"][number], config: CardSplitConfig, rowOffset: number) {
  const startRegex = createRegex(config.startRegex, "i");
  if (!startRegex) {
    return [];
  }

  const cards: string[][][] = [];
  let current: string[][] = [];
  section.rows.forEach((row) => {
    if (regexMatchesText(config.startRegex, rowToSearchText(row))) {
      if (current.length > 0) {
        cards.push(current);
      }
      current = [row];
      return;
    }
    current.push(row);
  });
  if (current.length > 0) {
    cards.push(current);
  }

  const output: UniversalImportRow[] = [];
  const itemHeaderRegex = createRegex(config.itemHeaderRegex, "i");

  cards.forEach((card, cardIndex) => {
    const text = card.map((row) => rowToSearchText(row)).join("\n");
    const cardContext = toInterpolationValues({
      sectionTitle: section.title,
      cardIndex: cardIndex + 1,
    });
    const baseValues: Partial<Record<UniversalImportField, string>> = {
      externalCode: interpolate(config.externalCodeTemplate, cardContext) || ensureUniqueExternalCode("CARD", cardIndex),
    };

    Object.assign(baseValues, extractFieldsByRegex(text, config.fieldRegex));
    extractFieldsByKeyValueLabels(card, config.keyValueLabels, baseValues);
    extractAdjacentKeyValueFields(
      {
        title: `card-${cardIndex + 1}`,
        rows: card,
        text,
      },
      config.fieldRegex,
      baseValues,
    );

    const itemHeaderIndex = itemHeaderRegex ? card.findIndex((row) => regexMatchesText(config.itemHeaderRegex, rowToSearchText(row))) : -1;
    const itemColumns = normalizeFieldColumnMap(config.itemColumns);
    const excludeRowRegex = createRegex(config.excludeRowRegex, "i");

    if (itemHeaderIndex < 0) {
      return;
    }

    card.slice(itemHeaderIndex + 1).forEach((itemRow) => {
      if (excludeRowRegex?.test(rowToSearchText(itemRow))) {
        return;
      }

      const quantity = getColumnValue(itemRow, itemColumns.skuQuantity);
      const skuCode = getColumnValue(itemRow, itemColumns.skuCode);
      const skuName = getColumnValue(itemRow, itemColumns.skuName);
      if (!isPositiveQuantity(quantity)) {
        return;
      }

      if (!skuCode || !skuName) {
        return;
      }

      output.push(
        rowFromValues(
          {
            ...baseValues,
            skuCode,
            skuName,
            skuSpec: getColumnValue(itemRow, itemColumns.skuSpec),
            skuQuantity: quantity,
          },
          rowOffset + output.length + 1,
        ),
      );
    });
  });

  return output;
}

function parseTextRecords(
  document: ParsedDocument,
  config: TextRecordSplitConfig,
  rowOffset: number,
  globalBaseValues: Partial<Record<UniversalImportField, string>> = {},
) {
  const separator = createRegex(config.recordSeparatorRegex, "im");
  const chunks = separator ? document.textContent.split(separator).filter((chunk) => chunk.trim()) : [document.textContent];
  const output: UniversalImportRow[] = [];

  chunks.forEach((chunk, index) => {
    const baseValues: Partial<Record<UniversalImportField, string>> = {
      ...globalBaseValues,
      externalCode: globalBaseValues.externalCode || ensureUniqueExternalCode("TXT", index),
    };
    Object.assign(baseValues, extractFieldsByRegex(chunk, config.fieldRegex));
    output.push(...parseTextItems(chunk, config.item, baseValues, rowOffset + output.length));
  });

  return output;
}

function getFirstNonEmptyGroupValue(rows: UniversalImportRow[], field: UniversalImportField) {
  return rows.map((row) => normalizeCell(row[field])).find(Boolean) ?? "";
}

function applyGroupByExternalCode(rows: UniversalImportRow[], config: GroupByExternalCodeConfig | undefined) {
  const keyField = config?.keyField && isImportField(config.keyField) ? config.keyField : "externalCode";
  const inheritedFields = normalizeFieldList(config?.inheritedFields, [
    "receiverStore",
    "receiverName",
    "receiverPhone",
    "receiverAddress",
    "note",
  ]);
  const groups = new Map<string, UniversalImportRow[]>();
  let lastSeenKey = "";

  rows.forEach((row) => {
    const explicitKey = normalizeCell(row[keyField]);
    const groupKey = explicitKey || (config?.inheritBlankKey ? lastSeenKey : "");

    if (!groupKey) {
      return;
    }

    if (!explicitKey && config?.inheritBlankKey && keyField === "externalCode") {
      row.externalCode = groupKey;
    }

    lastSeenKey = groupKey;
    const current = groups.get(groupKey) ?? [];
    current.push(row);
    groups.set(groupKey, current);
  });

  groups.forEach((groupRows) => {
    inheritedFields.forEach((field) => {
      const value = getFirstNonEmptyGroupValue(groupRows, field);
      if (!value) {
        return;
      }

      groupRows.forEach((row) => {
        if (!normalizeCell(row[field])) {
          row[field] = value;
        }
      });
    });
  });

  return rows;
}

function executeConfiguredRule(document: ParsedDocument, rawRule: UniversalImportRuleDsl) {
  const rule = normalizeRuleDsl(rawRule);
  const rows: UniversalImportRow[] = [];
  const summaries: string[] = [];
  const headerTransform = getTransform(rule, "header_mapping");
  const tailTransform = getTransform(rule, "tail_text_extract");
  const matrixTransform = getTransform(rule, "matrix_pivot");
  const splitCellTransform = getTransform(rule, "split_multiline_cell");
  const cardTransform = getTransform(rule, "card_split");
  const textTransform = getTransform(rule, "text_record_split");
  const groupTransform = getTransform(rule, "group_by_external_code");
  const useAllSheets = Boolean(getTransform(rule, "multisheet_merge"));
  const sections = useAllSheets ? document.sections : document.sections.slice(0, 1);
  const compositeHeaderConfig = getFirstCompositeTransformConfig(rule, ["headerMapping", "header_mapping"]);
  const compositeTailConfig = getFirstCompositeTransformConfig(rule, ["tailTextExtract", "tail_text_extract"]);
  const effectiveHeaderConfig = headerTransform?.config ?? compositeHeaderConfig;
  const effectiveTailConfig = tailTransform?.config ?? compositeTailConfig;
  const hasEffectiveHeader = headerTransform || Object.keys(compositeHeaderConfig).length > 0;
  const hasEffectiveTail = tailTransform || Object.keys(compositeTailConfig).length > 0;
  const globalTailValues = hasEffectiveTail ? extractTailFields(document, document.sections[0] ?? {
    title: "document",
    rows: [],
    text: document.textContent,
  }, effectiveTailConfig) : {};
  let textRowCount = 0;

  if (textTransform) {
    const textRows = parseTextRecords(document, textTransform.config as TextRecordSplitConfig, rows.length, globalTailValues);
    textRowCount = textRows.length;
    rows.push(...textRows);
    summaries.push(textRowCount > 0 ? "rule:text_record_split" : "rule:text_record_split:no_rows");
  }

  sections.forEach((section) => {
    const tailValues = hasEffectiveTail ? extractTailFields(document, section, effectiveTailConfig) : {};

    if (cardTransform) {
      rows.push(...parseCards(section, cardTransform.config as CardSplitConfig, rows.length));
      summaries.push(`rule:card_split:${section.title}`);
    }

    if (matrixTransform) {
      rows.push(...parseMatrix(section, matrixTransform.config as MatrixPivotConfig, rows.length));
      summaries.push(`rule:matrix_pivot:${section.title}`);
    }

    if (splitCellTransform) {
      rows.push(...parseSplitMultilineCells(section, splitCellTransform.config as SplitMultilineCellConfig, rows.length));
      summaries.push(`rule:split_multiline_cell:${section.title}`);
    }

    const canEmitHeaderWithMatrix = !matrixTransform || Boolean(effectiveHeaderConfig?.emitWithMatrix);
    const canEmitHeaderWithSplitCell = !splitCellTransform || Boolean(effectiveHeaderConfig?.emitWithSplitMultilineCell);
    const canEmitHeaderWithCard = !cardTransform || Boolean(effectiveHeaderConfig?.emitWithCard);
    const canEmitHeaderWithText = !textTransform || textRowCount === 0 || Boolean(effectiveHeaderConfig?.emitWithText);

    if (hasEffectiveHeader && canEmitHeaderWithMatrix && canEmitHeaderWithSplitCell && canEmitHeaderWithCard && canEmitHeaderWithText) {
      rows.push(...parseRowsByMapping(section, rule, effectiveHeaderConfig, tailValues, rows.length));
      summaries.push(`rule:header_mapping:${section.title}`);
    }
  });

  if (rows.length === 0 && document.fileType !== "excel") {
    const fallbackItemConfig: TextItemConfig = {
      regex: "([A-Za-z0-9_-]{3,})\\s+[|\\s]+(.+?)\\s+[|\\s]+([^|\\n\\r]*?)\\s+[|\\s]+(\\d+(?:\\.\\d+)?)",
      skuCodeGroup: 1,
      skuNameGroup: 2,
      skuSpecGroup: 3,
      skuQuantityGroup: 4,
    };
    rows.push(...parseTextItems(document.textContent, fallbackItemConfig, globalTailValues, 0));
    summaries.push("rule:text_fallback");
  }

  if (groupTransform) {
    applyGroupByExternalCode(rows, groupTransform.config as GroupByExternalCodeConfig | undefined);
    summaries.push("rule:group_by_external_code");
  }

  const configuredDefaults = isRecord(rule.defaults)
    ? (Object.keys(rule.defaults) as UniversalImportField[]).filter((field) => normalizeCell(rule.defaults?.[field]))
    : [];

  if (configuredDefaults.length > 0) {
    rows.forEach((row) => {
      configuredDefaults.forEach((field) => {
        const rawValue = normalizeCell(rule.defaults?.[field]);
        const value = field === "skuQuantity" ? normalizeNumericImportValue(rawValue) : rawValue;
        if (value && !normalizeCell(row[field])) {
          row[field] = value;
        }
      });
    });
    summaries.push("rule:defaults");
  }

  return {
    rows,
    summary: summaries.length ? summaries : ["rule:no_rows"],
  };
}

export function createDefaultRuleDsl(mapping: UniversalImportMapping, fileType: SupportedImportFileType): UniversalImportRuleDsl {
  const commonTransforms: UniversalImportRuleDsl["transforms"] = [
    { type: "multisheet_merge", enabled: fileType === "excel" },
    {
      type: "header_mapping",
      enabled: fileType === "excel",
      config: {
        headerRowIndex: 0,
        dataStartRowIndex: 1,
        fieldColumns: mapping,
        requiredRowFields: ["skuCode", "skuName", "skuQuantity"],
      },
    },
    { type: "group_by_external_code", enabled: true },
    { type: "matrix_pivot", enabled: false },
    { type: "split_multiline_cell", enabled: false },
    { type: "tail_text_extract", enabled: false },
    { type: "card_split", enabled: false },
    { type: "text_record_split", enabled: fileType !== "excel" },
  ];

  return {
    fileType,
    mode: fileType === "excel" ? "structured" : "text",
    defaults: {},
    mapping,
    transforms: commonTransforms,
  };
}

export async function executeUniversalImportRule(options: {
  fileBuffer: Buffer;
  fileType: SupportedImportFileType;
  originalFileName: string;
  rule: UniversalImportRuleDsl;
}) {
  const document = await parseImportDocument({
    fileBuffer: options.fileBuffer,
    fileType: options.fileType,
    originalFileName: options.originalFileName,
  });

  const { rows, summary } = executeConfiguredRule(document, options.rule);
  const validation = validateImportRows(rows);

  return {
    document,
    previewRows: rows,
    issues: validation.issues.map(formatIssueLabel),
    issueCount: validation.issues.length,
    rowCount: rows.length,
    summary,
  } satisfies RuleExecutionResult;
}
