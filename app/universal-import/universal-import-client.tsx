"use client";

import * as XLSX from "xlsx";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  countAggregatedShipments,
  getFieldDisplayLabel,
  getFieldLabelOptions,
  UNIVERSAL_IMPORT_FIELDS,
  UNIVERSAL_IMPORT_FIELD_LABELS,
  formatIssueLabel,
  type ExistingExternalCodeEntry,
  type UniversalImportField,
  type UniversalImportIssue,
  type UniversalImportMapping,
  type UniversalImportRow,
  validateImportRows,
} from "@/lib/universal-import";
import type {
  PresetReceiver,
  RuleTransformType,
  SupportedImportFileType,
  UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";

type ToastTone = "success" | "error" | "info";

type DraftRow = UniversalImportRow & {
  id: string;
};

type ShipmentHistoryRecord = {
  id: string;
  externalCode: string;
  receiverStore: string | null;
  receiverName: string | null;
  receiverPhone: string | null;
  receiverAddress: string | null;
  note: string | null;
  sourceRowCount: number;
  createdAt: string;
  raw?: UniversalImportRow[];
  receiverGroups?: Array<{
    id: string;
    receiverStore: string | null;
    receiverName: string | null;
    receiverPhone: string | null;
    receiverAddress: string | null;
    note: string | null;
    sourceRowCount: number;
    raw: UniversalImportRow[];
  }>;
  items: Array<{
    id: string;
    receiverGroupId?: string | null;
    sourceRowIndex: number;
    skuCode: string;
    skuName: string;
    skuQuantity: number;
    skuSpec: string | null;
  }>;
  batch: {
    batchName: string;
    originalFileName: string;
    sourceSheetName: string;
    fileType: string;
    status: string;
    totalRows: number;
    createdBy: string;
    createdAt: string;
  };
};

type ShipmentHistoryResponse = {
  records?: ShipmentHistoryRecord[];
  total?: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
  error?: string;
};

type RuleRecord = {
  id: string;
  fingerprint: string;
  ruleName: string;
  fileType: string;
  version: number;
  status: string;
  mapping: UniversalImportMapping;
  ruleDsl?: UniversalImportRuleDsl | null;
  sampleMeta?: unknown;
  updatedAt: string;
  createdAt: string;
  _count?: {
    batches: number;
  };
};

type RuleListResponse = {
  templates?: RuleRecord[];
  error?: string;
};

type RuleUpsertResponse = {
  template?: RuleRecord | null;
  error?: string;
};

type BatchDeleteResponse = {
  success?: boolean;
  deletedCount?: number;
  error?: string;
};

type DeleteConfirmTarget =
  | {
      type: "history-batch";
      ids: string[];
    }
  | {
      type: "rule-batch";
      ids: string[];
    }
  | {
      type: "rule-single";
      id: string;
    };

type RuleTestResponse = {
  previewRows?: UniversalImportRow[];
  issues?: string[];
  issueCount?: number;
  rowCount?: number;
  summary?: string[];
  fingerprint?: string;
  inferredMapping?: UniversalImportMapping;
  document?: {
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
  error?: string;
};

type ColumnOption = {
  index: number;
  header: string;
  samples: string[];
};

type TailSourceOption = {
  value: string;
  labels: string[];
  samples: string[];
  kind: "keyValue";
};

type TailSourceCandidate = string | {
  label?: unknown;
  sample?: unknown;
};

type AiSuggestResponse = {
  documentSummary?: {
    fileType: SupportedImportFileType;
    sheetName: string;
    headers: string[];
    headerRowIndex?: number;
    columnOptions?: ColumnOption[];
    tailSourceOptions?: Partial<Record<UniversalImportField, TailSourceCandidate[]>>;
    rowCount: number;
    sectionCount: number;
  };
  suggestedRule?: UniversalImportRuleDsl;
  confidenceReport?: AiConfidenceItem[];
  riskNotes?: string[];
  provider?: string;
  model?: string;
  aiSummary?: string;
  error?: string;
};

type AiConfidenceItem = {
  field: UniversalImportField;
  confidence: number;
  source: string;
};

type HistoryFilters = {
  query: string;
  externalCode: string;
  receiverName: string;
  submittedAtStart: string;
  submittedAtEnd: string;
  page: number;
  pageSize: number;
};

type SidebarMenuItem = {
  label: string;
  href?: string;
  children?: SidebarMenuItem[];
};

type ProgressState = {
  active: boolean;
  value: number;
  label: string;
  processed: number;
  total: number;
};

function getProcessedCountFromProgress(value: number, total: number) {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(total, Math.floor((value / 100) * total)));
}

type ParseFailureState = {
  message: string;
  fileName: string;
  fileType: SupportedImportFileType;
  ruleName: string;
  fileSize: number;
  lastModified: number;
};

type PerformanceSnapshot = {
  parseMs: number;
  totalRows: number;
  renderedRows: number;
  issueCount: number;
  renderMode: "full" | "batched";
};

type SubmitSummary = {
  successCount: number;
  failCount: number;
  shipmentCount: number;
  failedShipmentCount: number;
  submittedAt: string;
  failedResults: SubmitResult[];
  blockingIssues: string[];
};

type SubmitResult = {
  externalCode: string;
  receiverLabel: string;
  sourceRowCount: number;
  status: "success" | "failed";
  shipmentId?: string;
  rowIndexes: number[];
  error?: string;
};

async function readJsonResponse<T>(response: Response): Promise<T & { error?: string }> {
  const contentType = response.headers.get("content-type") ?? "";
  const rawText = await response.text();

  if (!rawText) {
    return {} as T & { error?: string };
  }

  if (!contentType.includes("application/json")) {
    return {
      error: rawText.slice(0, 240) || `接口返回非 JSON 响应（HTTP ${response.status}）。`,
    } as T & { error?: string };
  }

  try {
    return JSON.parse(rawText) as T & { error?: string };
  } catch {
    return {
      error: `接口响应 JSON 解析失败（HTTP ${response.status}）。`,
    } as T & { error?: string };
  }
}

type AggregatedPreviewShipment = {
  key: string;
  externalCode: string;
  receiverLabel: string;
  receiverGroupCount: number;
  rowCount: number;
  skuCount: number;
  quantityTotal: number;
  rowIndexes: number[];
};

type SameBatchDuplicateExternalCodeReport = {
  summaries: string[];
  noticesByRowId: Map<string, string>;
};

type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

const DEFAULT_MAPPING = Object.fromEntries(
  UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, null]),
) as UniversalImportMapping;

const DEFAULT_HISTORY_FILTERS: HistoryFilters = {
  query: "",
  externalCode: "",
  receiverName: "",
  submittedAtStart: "",
  submittedAtEnd: "",
  page: 1,
  pageSize: 10,
};

const PREVIEW_INITIAL_RENDER_COUNT = 160;
const PREVIEW_RENDER_BATCH_SIZE = 160;
const TAIL_SOURCE_PREFIX = "__tail__:";
const TAIL_REGEX_SOURCE_PREFIX = "__tail_regex__:";
const SUPPORTED_FILE_EXTENSIONS = [".xlsx", ".xls", ".docx", ".pdf"] as const;
const TRANSFORM_TYPE_LABELS: Record<RuleTransformType, string> = {
  header_mapping: "表头映射",
  multisheet_merge: "多 Sheet 合并",
  group_by_external_code: "按外部编码聚合",
  matrix_pivot: "矩阵转置",
  split_multiline_cell: "复合单元格拆分",
  tail_text_extract: "尾部信息提取",
  card_split: "卡片式拆分",
  text_record_split: "文本记录拆分",
};

const UNIVERSAL_SIDEBAR_MENUS: SidebarMenuItem[] = [
  {
    label: "万能导入",
    children: [
      { label: "万能导入", href: "/universal-import" },
      { label: "规则管理", href: "/universal-import?tab=rules" },
      { label: "运单管理", href: "/universal-import?tab=history" },
    ],
  },
];

function resolveTabParam(tab?: string | null): "import" | "history" | "rules" {
  if (tab === "history" || tab === "rules") {
    return tab;
  }
  return "import";
}

function createRowId() {
  return globalThis.crypto.randomUUID();
}


function createEmptyDraftRow(rowIndex: number): DraftRow {
  return {
    externalCode: "",
    receiverStore: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
    skuCode: "",
    skuName: "",
    skuQuantity: "",
    skuSpec: "",
    note: "",
    rowIndex,
    id: createRowId(),
  };
}

function toDraftRows(rows: UniversalImportRow[]) {
  return rows.map((row, index) => ({
    ...row,
    rowIndex: index + 1,
    id: createRowId(),
  }));
}

function getDraftReceiverLabel(row: UniversalImportRow) {
  return formatReceiverLine(row);
}

function formatReceiverLine(source: {
  receiverStore?: string | null;
  receiverName?: string | null;
  receiverPhone?: string | null;
  receiverAddress?: string | null;
}) {
  const receiverStore = source.receiverStore?.trim() ?? "";
  const receiverName = source.receiverName?.trim() ?? "";
  const receiverPhone = source.receiverPhone?.trim() ?? "";
  const receiverAddress = source.receiverAddress?.trim() ?? "";

  if (receiverStore) {
    return receiverStore;
  }

  const receiverParts = [receiverName, receiverPhone, receiverAddress].filter(Boolean);
  if (receiverParts.length > 0) {
    return receiverParts.join(" / ");
  }

  return "-";
}

function buildReceiverSummaryFromLines(lines: string[]) {
  if (lines.length === 0) {
    return "-";
  }

  if (lines.length === 1) {
    return lines[0];
  }

  return `${lines[0]} 等 ${lines.length} 组收货信息`;
}

function collectUniqueReceiverLines(
  sources: Array<{
    receiverStore?: string | null;
    receiverName?: string | null;
    receiverPhone?: string | null;
    receiverAddress?: string | null;
  }>,
) {
  return Array.from(
    new Set(
      sources
        .map((source) => formatReceiverLine(source))
        .filter((line) => line !== "-"),
    ),
  );
}

function buildAggregatedPreviewShipments(rows: DraftRow[]): AggregatedPreviewShipment[] {
  const grouped = new Map<string, AggregatedPreviewShipment & { receiverLines: string[] }>();

  rows.forEach((row, index) => {
    const externalCode = row.externalCode.trim();
    const key = externalCode ? `external:${externalCode.toLowerCase()}` : `row:${row.id}`;
    const quantity = Number.parseFloat(row.skuQuantity.trim());
    const receiverLine = getDraftReceiverLabel(row);
    const current =
      grouped.get(key) ??
      {
        key,
        externalCode: externalCode || "未填写外部编码",
        receiverLabel: receiverLine,
        receiverGroupCount: receiverLine === "-" ? 0 : 1,
        receiverLines: receiverLine === "-" ? [] : [receiverLine],
        rowCount: 0,
        skuCount: 0,
        quantityTotal: 0,
        rowIndexes: [],
      };

    current.rowCount += 1;
    current.skuCount += row.skuCode.trim() || row.skuName.trim() ? 1 : 0;
    current.quantityTotal += Number.isFinite(quantity) ? quantity : 0;
    current.rowIndexes.push(row.rowIndex || index + 1);

    if (receiverLine !== "-" && !current.receiverLines.includes(receiverLine)) {
      current.receiverLines.push(receiverLine);
    }

    current.receiverGroupCount = current.receiverLines.length;
    current.receiverLabel = buildReceiverSummaryFromLines(current.receiverLines);

    grouped.set(key, current);
  });

  return Array.from(grouped.values()).map(({ receiverLines: _, ...shipment }) => shipment);
}

function buildSameBatchDuplicateExternalCodeReport(rows: DraftRow[]): SameBatchDuplicateExternalCodeReport {
  const grouped = new Map<string, { externalCode: string; rowNumbers: number[]; rowIds: string[] }>();

  rows.forEach((row, index) => {
    const externalCode = row.externalCode.trim();

    if (!externalCode) {
      return;
    }

    const normalized = externalCode.toLowerCase();
    const current = grouped.get(normalized) ?? { externalCode, rowNumbers: [], rowIds: [] };
    current.rowNumbers.push(row.rowIndex || index + 1);
    current.rowIds.push(row.id);
    grouped.set(normalized, current);
  });

  const summaries: string[] = [];
  const noticesByRowId = new Map<string, string>();

  grouped.forEach((item) => {
    if (item.rowNumbers.length <= 1) {
      return;
    }

    const notice = `同批次外部编码「${item.externalCode}」重复：第 ${item.rowNumbers.join(
      "、",
    )} 行将按同一运单聚合，请确认不是误填。`;

    summaries.push(notice);
    item.rowIds.forEach((rowId) => noticesByRowId.set(rowId, notice));
  });

  return { summaries, noticesByRowId };
}

function toSafeSheetName(name: string) {
  return name.trim().slice(0, 30) || "Sheet1";
}

function downloadWorkbook(rows: DraftRow[], sheetName: string) {
  const workbook = XLSX.utils.book_new();
  const exportRows = rows.map((row) =>
    Object.fromEntries(
      UNIVERSAL_IMPORT_FIELDS.map((field) => [
        UNIVERSAL_IMPORT_FIELD_LABELS[field.key],
        row[field.key],
      ]),
    ),
  );
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  XLSX.utils.book_append_sheet(workbook, worksheet, toSafeSheetName(sheetName));
  XLSX.writeFile(workbook, `${toSafeSheetName(sheetName)}_预览导出.xlsx`);
}

function normalizeMapping(raw: unknown): UniversalImportMapping | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  return Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, typeof candidate[field.key] === "number" ? candidate[field.key] : null]),
  ) as UniversalImportMapping;
}

function getSampleHeaders(sampleMeta: unknown) {
  if (!sampleMeta || typeof sampleMeta !== "object") {
    return [];
  }

  const headers = (sampleMeta as { headers?: unknown }).headers;
  if (!Array.isArray(headers)) {
    return [];
  }

  return headers.map((header) => String(header ?? ""));
}

function toColumnOptions(headers: string[]): ColumnOption[] {
  return headers.map((header, index) => ({
    index,
    header,
    samples: [],
  }));
}

function getRuleHeaderRowIndex(rule: UniversalImportRuleDsl) {
  const config = rule.transforms.find((transform) => transform.type === "header_mapping")?.config;
  const value = config?.headerRowIndex;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value);
  }
  return 0;
}

function buildColumnOptionsFromDocument(document: RuleTestResponse["document"], rule: UniversalImportRuleDsl): ColumnOption[] {
  if (!document) {
    return [];
  }

  const rows = document.sections[0]?.rows ?? [];
  const headerRowIndex = getRuleHeaderRowIndex(rule);
  const headers = rows[headerRowIndex] ?? document.headers ?? [];
  const allRows = document.sections.flatMap((section) => section.rows);
  const maxColumnCount = allRows.reduce((max, row) => Math.max(max, row.length), headers.length);
  const sampleRows = allRows.filter((_, index) => index !== headerRowIndex);

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

function formatColumnOption(option: ColumnOption) {
  const header = option.header || "未命名列";
  const visibleSamples = option.samples.slice(0, 4);
  const samples = visibleSamples.length > 0
    ? `｜样例：${visibleSamples.join(" / ")}${option.samples.length > visibleSamples.length ? " ..." : ""}`
    : "";
  return `${option.index + 1}. ${header}${samples}`;
}

function createEmptyPreset(): PresetReceiver {
  return {
    id: crypto.randomUUID(),
    label: "",
    receiverStore: "",
    receiverName: "",
    receiverPhone: "",
    receiverAddress: "",
  };
}

function buildDefaultRuleDsl(mapping: UniversalImportMapping, fileType: SupportedImportFileType): UniversalImportRuleDsl {
  return {
    fileType,
    mode: fileType === "excel" ? "structured" : "text",
    defaults: {},
    fieldLabels: {},
    presetReceivers: [],
    mapping,
    transforms: [
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
      { type: "multisheet_merge", enabled: fileType === "excel" },
      { type: "group_by_external_code", enabled: true },
      { type: "matrix_pivot", enabled: false },
      { type: "split_multiline_cell", enabled: false },
      { type: "tail_text_extract", enabled: false },
      { type: "card_split", enabled: false },
      { type: "text_record_split", enabled: fileType !== "excel" },
    ],
  };
}

function makeFormData(file: File, fileType: SupportedImportFileType, mapping: UniversalImportMapping, ruleDsl: UniversalImportRuleDsl) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("fileType", fileType);
  formData.append("mapping", JSON.stringify(mapping));
  formData.append("ruleDsl", JSON.stringify(ruleDsl));
  return formData;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

function detectFileTypeFromName(fileName: string): SupportedImportFileType | null {
  const extension = getFileExtension(fileName);

  if (extension === ".xlsx" || extension === ".xls") {
    return "excel";
  }

  if (extension === ".docx") {
    return "word";
  }

  if (extension === ".pdf") {
    return "pdf";
  }

  return null;
}

function formatFileTypeLabel(value: string) {
  if (value === "pdf") {
    return "PDF";
  }

  if (value === "word") {
    return "Word";
  }

  return "Excel";
}

function formatTransformConfig(config: Record<string, unknown> | undefined) {
  return JSON.stringify(config ?? {}, null, 2);
}

function getTransformTypeLabel(type: RuleTransformType) {
  return TRANSFORM_TYPE_LABELS[type] ?? type;
}

function getTransformConfigSummary(config: Record<string, unknown> | undefined) {
  if (!config || Object.keys(config).length === 0) {
    return "未配置参数";
  }

  const summaryParts: string[] = [];

  if (typeof config.headerRowIndex === "number") {
    summaryParts.push(`表头第 ${config.headerRowIndex + 1} 行`);
  }

  if (typeof config.dataStartRowIndex === "number") {
    summaryParts.push(`数据第 ${config.dataStartRowIndex + 1} 行起`);
  }

  if (typeof config.groupField === "string" && config.groupField.trim()) {
    summaryParts.push(`按 ${config.groupField.trim()} 分组`);
  }

  if (typeof config.recordDelimiter === "string" && config.recordDelimiter.trim()) {
    summaryParts.push("已设记录分隔");
  }

  if (typeof config.cardStartPattern === "string" && config.cardStartPattern.trim()) {
    summaryParts.push("已设卡片边界");
  }

  if (typeof config.valueField === "string" && config.valueField.trim()) {
    summaryParts.push(`值字段 ${config.valueField.trim()}`);
  }

  if (summaryParts.length > 0) {
    return summaryParts.join(" / ");
  }

  return `已配置 ${Object.keys(config).length} 项参数`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getTailTransform(rule: UniversalImportRuleDsl) {
  return rule.transforms.find((transform) => transform.type === "tail_text_extract");
}

function normalizeTailLabels(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function encodeTailSourceValue(labels: string[]) {
  return `${TAIL_SOURCE_PREFIX}${encodeURIComponent(JSON.stringify(labels))}`;
}

function encodeTailRegexSourceValue(field: UniversalImportField, regex: string) {
  return `${TAIL_REGEX_SOURCE_PREFIX}${encodeURIComponent(JSON.stringify({ field, regex }))}`;
}

function decodeTailSourceValue(value: string) {
  if (!value.startsWith(TAIL_SOURCE_PREFIX)) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(TAIL_SOURCE_PREFIX.length))) as unknown;
    return normalizeTailLabels(parsed);
  } catch {
    return [];
  }
}

function decodeTailRegexSourceValue(value: string) {
  if (!value.startsWith(TAIL_REGEX_SOURCE_PREFIX)) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(TAIL_REGEX_SOURCE_PREFIX.length))) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const field = String(parsed.field ?? "");
    const regex = String(parsed.regex ?? "").trim();
    if (!UNIVERSAL_IMPORT_FIELDS.some((item) => item.key === field) || !regex) {
      return null;
    }

    return { field: field as UniversalImportField, regex };
  } catch {
    return null;
  }
}

function getTailSourceOption(rule: UniversalImportRuleDsl, field: UniversalImportField): TailSourceOption | null {
  const tailTransform = getTailTransform(rule);
  if (!tailTransform || !isRecord(tailTransform.config)) {
    return null;
  }

  const labelsConfig = tailTransform.config.keyValueLabels;
  if (!isRecord(labelsConfig)) {
    return null;
  }

  const labels = normalizeTailLabels(labelsConfig[field]);
  if (labels.length === 0) {
    return null;
  }

  return {
    value: encodeTailSourceValue(labels),
    labels,
    samples: [],
    kind: "keyValue",
  };
}

function normalizeTailSourceCandidates(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        const label = item.trim();
        return label ? { label, sample: "" } : null;
      }

      if (!isRecord(item)) {
        return null;
      }

      const label = String(item.label ?? "").trim();
      const sample = String(item.sample ?? "").trim();
      return label ? { label, sample } : null;
    })
    .filter((item): item is { label: string; sample: string } => Boolean(item));
}

function getAvailableTailSourceOptions(
  rule: UniversalImportRuleDsl,
  field: UniversalImportField,
  discoveredTailSources: Partial<Record<UniversalImportField, TailSourceCandidate[]>>,
) {
  const configured = getTailSourceOption(rule, field);
  const discoveredCandidates = normalizeTailSourceCandidates(discoveredTailSources[field]);
  const discoveredLabels = discoveredCandidates.map((item) => item.label);
  const options = new Map<string, TailSourceOption>();

  if (configured) {
    options.set(configured.value, configured);
  }

  if (discoveredLabels.length > 0) {
    const discovered = {
      value: encodeTailSourceValue(discoveredLabels),
      labels: discoveredLabels,
      samples: discoveredCandidates.map((item) => item.sample).filter(Boolean),
      kind: "keyValue" as const,
    };
    options.set(discovered.value, discovered);
  }

  return Array.from(options.values());
}

function getTailSourceOptionLabel(option: TailSourceOption) {
  const samples = option.samples.length > 0 ? `｜样例：${option.samples.slice(0, 2).join(" / ")}` : "";
  return `文件尾部字段：${option.labels.join(" / ")}${samples}`;
}

function getMappingSelectValue(
  rule: UniversalImportRuleDsl,
  field: UniversalImportField,
  currentColumn: number | null,
) {
  if (typeof currentColumn === "number") {
    return String(currentColumn);
  }

  return getTailSourceOption(rule, field)?.value ?? "";
}

function getRuleDefaultValue(rule: UniversalImportRuleDsl, field: UniversalImportField) {
  return String(rule.defaults?.[field] ?? "");
}

function updateRuleDefaultValue(
  rule: UniversalImportRuleDsl,
  field: UniversalImportField,
  value: string,
) {
  const defaults = { ...(rule.defaults ?? {}) } as Partial<Record<UniversalImportField, string>>;
  const normalizedValue = value.trim();

  if (normalizedValue) {
    defaults[field] = normalizedValue;
  } else {
    delete defaults[field];
  }

  return {
    ...rule,
    defaults,
  };
}

function updateTailSourceField(
  rule: UniversalImportRuleDsl,
  field: UniversalImportField,
  nextLabels: string[],
) {
  const normalizedLabels = normalizeTailLabels(nextLabels);
  let transformMatched = false;

  const nextTransforms = rule.transforms.map((transform) => {
    if (transform.type !== "tail_text_extract") {
      return transform;
    }

    transformMatched = true;
    const currentConfig = isRecord(transform.config) ? transform.config : {};
    const rawLabelMap = isRecord(currentConfig.keyValueLabels) ? currentConfig.keyValueLabels : {};
    const nextLabelMap = { ...rawLabelMap } as Record<string, unknown>;

    if (normalizedLabels.length > 0) {
      nextLabelMap[field] = normalizedLabels;
    } else {
      delete nextLabelMap[field];
    }

    return {
      ...transform,
      enabled: normalizedLabels.length > 0 ? true : transform.enabled,
      config: {
        ...currentConfig,
        keyValueLabels: nextLabelMap,
      },
    };
  });

  if (!transformMatched && normalizedLabels.length > 0) {
    nextTransforms.push({
      type: "tail_text_extract",
      enabled: true,
      config: {
        keyValueLabels: {
          [field]: normalizedLabels,
        },
      },
    });
  }

  return {
    ...rule,
    transforms: nextTransforms,
  };
}

function updateTailRegexSourceField(
  rule: UniversalImportRuleDsl,
  field: UniversalImportField,
  nextRegex: string,
) {
  const normalizedRegex = nextRegex.trim();
  let transformMatched = false;

  const nextTransforms = rule.transforms.map((transform) => {
    if (transform.type !== "tail_text_extract") {
      return transform;
    }

    transformMatched = true;
    const currentConfig = isRecord(transform.config) ? transform.config : {};
    const rawRegexMap = isRecord(currentConfig.fieldRegex) ? currentConfig.fieldRegex : {};
    const nextRegexMap = { ...rawRegexMap } as Record<string, unknown>;

    if (normalizedRegex) {
      nextRegexMap[field] = normalizedRegex;
    } else {
      delete nextRegexMap[field];
    }

    return {
      ...transform,
      enabled: normalizedRegex ? true : transform.enabled,
      config: {
        ...currentConfig,
        fieldRegex: nextRegexMap,
      },
    };
  });

  if (!transformMatched && normalizedRegex) {
    nextTransforms.push({
      type: "tail_text_extract",
      enabled: true,
      config: {
        fieldRegex: {
          [field]: normalizedRegex,
        },
      },
    });
  }

  return {
    ...rule,
    transforms: nextTransforms,
  };
}

function getAiMappingStatus(item: AiConfidenceItem | undefined) {
  if (!item) {
    return {
      label: "需确认",
      tone: "warning",
      detail: "AI 未返回置信度，请人工确认",
      strategy: "unconfirmed",
    };
  }

  if (item.source === "tail-key-value") {
    return {
      label: "尾部提取",
      tone: "info",
      detail: `${Math.round(item.confidence * 100)}% / 文档键值区提取，不走列表头映射`,
      strategy: "tail",
    };
  }

  if (item.confidence >= 0.85) {
    return {
      label: "高置信",
      tone: "success",
      detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
      strategy: "column",
    };
  }

  if (item.confidence >= 0.55) {
    return {
      label: "AI推测",
      tone: "info",
      detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
      strategy: "column",
    };
  }

  return {
    label: "需确认",
    tone: "warning",
    detail: `${Math.round(item.confidence * 100)}% / ${item.source}`,
    strategy: "unconfirmed",
  };
}

function formatReceiverSummary(record: ShipmentHistoryRecord) {
  const receiverLines =
    record.receiverGroups && record.receiverGroups.length > 0
      ? collectUniqueReceiverLines(record.receiverGroups)
      : collectUniqueReceiverLines(record.raw ?? [record]);
  return buildReceiverSummaryFromLines(receiverLines);
}

function buildHistoryReceiverDetail(record: ShipmentHistoryRecord) {
  const receiverLines =
    record.receiverGroups && record.receiverGroups.length > 0
      ? collectUniqueReceiverLines(record.receiverGroups)
      : collectUniqueReceiverLines(record.raw ?? [record]);

  if (receiverLines.length <= 1) {
    return {
      title: receiverLines[0] ?? "-",
      detail: record.note || "无补充信息",
    };
  }

  return {
    title: `共 ${receiverLines.length} 组收货信息`,
    detail: receiverLines.join("；"),
  };
}

function buildHistoryReceiverLookup(record: ShipmentHistoryRecord) {
  if (record.receiverGroups && record.receiverGroups.length > 0) {
    return new Map(
      record.receiverGroups.flatMap((group) =>
        (group.raw ?? []).map((row) => [row.rowIndex, formatReceiverLine(group)] as const),
      ),
    );
  }

  return new Map(
    (record.raw ?? []).map((row) => [row.rowIndex, formatReceiverLine(row)] as const),
  );
}

export function UniversalImportClient({
  operatorName,
  initialTab = "import",
}: {
  operatorName: string;
  initialTab?: "import" | "history" | "rules";
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLInputElement>());
  const toastTimerRef = useRef<number | null>(null);
  const autoPreviewTimerRef = useRef<number | null>(null);
  const lastAutoPreviewSignatureRef = useRef("");
  const autoPreviewBusyRef = useRef(false);
  const historyAbortRef = useRef<AbortController | null>(null);
  const historyRequestIdRef = useRef(0);
  const historyLoadedOnceRef = useRef(false);
  const historyCodesLoadedRef = useRef(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<SupportedImportFileType>("excel");
  const [fileName, setFileName] = useState("");
  const [sheetName, setSheetName] = useState("Sheet1");
  const [fingerprint, setFingerprint] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [columnOptions, setColumnOptions] = useState<ColumnOption[]>([]);
  const [tailSourceOptions, setTailSourceOptions] = useState<Partial<Record<UniversalImportField, TailSourceCandidate[]>>>({});
  const [draftRows, setDraftRows] = useState<DraftRow[]>([]);
  const [mapping, setMapping] = useState<UniversalImportMapping>(DEFAULT_MAPPING);
  const [ruleDsl, setRuleDsl] = useState<UniversalImportRuleDsl>(buildDefaultRuleDsl(DEFAULT_MAPPING, "excel"));
  const [status, setStatus] = useState("");
  const [historyStatus, setHistoryStatus] = useState("");
  const [parseProgress, setParseProgress] = useState<ProgressState>({
    active: false,
    value: 0,
    label: "",
    processed: 0,
    total: 0,
  });
  const [submitProgress, setSubmitProgress] = useState<ProgressState>({
    active: false,
    value: 0,
    label: "",
    processed: 0,
    total: 0,
  });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyDeleting, setHistoryDeleting] = useState(false);
  const [historyData, setHistoryData] = useState<ShipmentHistoryResponse>({});
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<string[]>([]);
  const [deleteConfirmTarget, setDeleteConfirmTarget] = useState<DeleteConfirmTarget | null>(null);
  const [presetEditorOpen, setPresetEditorOpen] = useState(false);
  const [presetEditorData, setPresetEditorData] = useState<PresetReceiver>(createEmptyPreset());
  const [presetEditorMode, setPresetEditorMode] = useState<"add" | "edit">("add");
  const [presetEditingIndex, setPresetEditingIndex] = useState<number | null>(null);
  const [newRuleDialogOpen, setNewRuleDialogOpen] = useState(false);
  const [newRuleForm, setNewRuleForm] = useState({ receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "" });
  const [editRuleDialogOpen, setEditRuleDialogOpen] = useState(false);
  const [editRuleForm, setEditRuleForm] = useState({ ruleName: "", receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "" });
  const [editingRuleId, setEditingRuleId] = useState("");
  const [historyFilters, setHistoryFilters] = useState<HistoryFilters>(DEFAULT_HISTORY_FILTERS);
  const [templateInfo, setTemplateInfo] = useState("");
  const [lastSavedAt, setLastSavedAt] = useState("");
  const [existingCodeRows, setExistingCodeRows] = useState<ExistingExternalCodeEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"import" | "history" | "rules">(initialTab);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [previewRenderLimit, setPreviewRenderLimit] = useState(PREVIEW_INITIAL_RENDER_COUNT);
  const [ruleList, setRuleList] = useState<RuleRecord[]>([]);
  const [ruleLoading, setRuleLoading] = useState(false);
  const [ruleDeleting, setRuleDeleting] = useState(false);
  const [ruleStatus, setRuleStatus] = useState("");
  const [ruleNameInput, setRuleNameInput] = useState("");
  const [selectedRuleId, setSelectedRuleId] = useState("");
  const [selectedRuleIds, setSelectedRuleIds] = useState<string[]>([]);
  const [ruleTestSummary, setRuleTestSummary] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiSuggesting, setAiSuggesting] = useState(false);
  const [aiRiskNotes, setAiRiskNotes] = useState<string[]>([]);
  const [aiConfidenceReport, setAiConfidenceReport] = useState<AiConfidenceItem[]>([]);
  const [aiProviderLabel, setAiProviderLabel] = useState("");
  const [aiModelLabel, setAiModelLabel] = useState("");
  const [parseFailure, setParseFailure] = useState<ParseFailureState | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [performanceSnapshot, setPerformanceSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [submitSummary, setSubmitSummary] = useState<SubmitSummary | null>(null);
  const [submitBlockingIssues, setSubmitBlockingIssues] = useState<string[]>([]);
  const [transformConfigDrafts, setTransformConfigDrafts] = useState<Record<string, string>>({});
  const [expandedMenuPaths, setExpandedMenuPaths] = useState<string[]>([
    "万能导入",
  ]);
  const [activeMenuPath, setActiveMenuPath] = useState("万能导入/万能导入");
  const deferredDraftRows = useDeferredValue(draftRows);

  const existingExternalCodes = useMemo(
    () =>
      new Map(
        existingCodeRows
          .map((record) => [record.externalCode.trim().toLowerCase(), record] as const)
          .filter(([value]) => Boolean(value)),
      ),
    [existingCodeRows],
  );

  const validation = useMemo(
    () => validateImportRows(deferredDraftRows, existingExternalCodes),
    [deferredDraftRows, existingExternalCodes],
  );

  const errorRowCount = useMemo(
    () => new Set(validation.issues.map((issue) => issue.rowIndex)).size,
    [validation.issues],
  );

  const rowErrorsById = useMemo(() => {
    const map = new Map<string, UniversalImportIssue[]>();
    validation.issues.forEach((issue) => {
      const row = deferredDraftRows[issue.rowIndex - 1];
      if (!row) {
        return;
      }
      const current = map.get(row.id) ?? [];
      current.push(issue);
      map.set(row.id, current);
    });
    return map;
  }, [deferredDraftRows, validation.issues]);

  const rowErrorSummary = useMemo(
    () => validation.issues.map((issue) => formatIssueLabel(issue)),
    [validation.issues],
  );
  const sameBatchDuplicateReport = useMemo(
    () => buildSameBatchDuplicateExternalCodeReport(deferredDraftRows),
    [deferredDraftRows],
  );

  const historyShipmentCount = historyData.total ?? 0;
  const currentHistoryRecords = historyData.records ?? [];
  const historyItemCount = useMemo(
    () => currentHistoryRecords.reduce((sum, record) => sum + record.items.length, 0),
    [currentHistoryRecords],
  );
  const [selectedHistoryId, setSelectedHistoryId] = useState("");
  const selectedHistoryRecord = useMemo(
    () => historyData.records?.find((record) => record.id === selectedHistoryId) ?? historyData.records?.[0] ?? null,
    [historyData.records, selectedHistoryId],
  );
  const currentHistoryIds = useMemo(() => currentHistoryRecords.map((record) => record.id), [currentHistoryRecords]);
  const selectedHistoryIdSet = useMemo(() => new Set(selectedHistoryIds), [selectedHistoryIds]);
  const allHistoryRecordsSelected =
    currentHistoryIds.length > 0 && currentHistoryIds.every((id) => selectedHistoryIdSet.has(id));
  const selectedRuleIdSet = useMemo(() => new Set(selectedRuleIds), [selectedRuleIds]);
  const allRulesSelected = ruleList.length > 0 && ruleList.every((rule) => selectedRuleIdSet.has(rule.id));
  const selectedErrorCount = useMemo(() => {
    if (selectedIds.length === 0) return null;
    return selectedIds.filter((id) => rowErrorsById.has(id)).length;
  }, [selectedIds, rowErrorsById]);
  const hasBlockingErrors = selectedIds.length > 0
    ? (selectedErrorCount ?? 0) > 0
    : validation.issues.length > 0;
  const hasSameBatchDuplicateExternalCodes = sameBatchDuplicateReport.summaries.length > 0;
  const allRowsSelected = draftRows.length > 0 && selectedIds.length === draftRows.length;
  const selectedCount = selectedIds.length;
  const totalCount = draftRows.length;
  const visibleDraftRows = useMemo(
    () => draftRows.slice(0, previewRenderLimit),
    [draftRows, previewRenderLimit],
  );
  const hiddenPreviewRowCount = Math.max(draftRows.length - visibleDraftRows.length, 0);
  const groupedPreviewCount = useMemo(() => countAggregatedShipments(draftRows), [draftRows]);
  const aggregatedPreviewShipments = useMemo(
    () => buildAggregatedPreviewShipments(draftRows),
    [draftRows],
  );
  const visibleAggregatedPreviewShipments = aggregatedPreviewShipments.slice(0, 80);
  const hiddenAggregatedPreviewCount = Math.max(
    aggregatedPreviewShipments.length - visibleAggregatedPreviewShipments.length,
    0,
  );
  const activeColumnOptions = columnOptions.length > 0 ? columnOptions : toColumnOptions(headers);
  const activeHeaderRowIndex = getRuleHeaderRowIndex(ruleDsl);
  const aiConfidenceByField = useMemo(
    () => new Map(aiConfidenceReport.map((item) => [item.field, item] as const)),
    [aiConfidenceReport],
  );

  function pushToast(message: string, tone: ToastTone = "info") {
    const id = createRowId();
    setToasts((current) => [...current, { id, message, tone }]);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 2600);
  }

  function syncRuleMapping(nextMapping: UniversalImportMapping) {
    setRuleDsl((current) => mergeRuleDslMapping(current, nextMapping));
  }

  function mergeRuleDslMapping(current: UniversalImportRuleDsl, nextMapping: UniversalImportMapping) {
    return {
      ...current,
      mapping: nextMapping,
      transforms: current.transforms.map((transform) =>
        transform.type === "header_mapping"
          ? {
              ...transform,
              config: {
                ...(transform.config ?? {}),
                fieldColumns: nextMapping,
              },
            }
          : transform,
      ),
    };
  }

  function handleMappingColumnChange(field: UniversalImportField, value: string) {
    const nextMapping = {
      ...mapping,
      [field]: null,
    } as UniversalImportMapping;
    let nextRuleDsl = mergeRuleDslMapping(ruleDsl, nextMapping);

    if (value.startsWith(TAIL_SOURCE_PREFIX)) {
      nextRuleDsl = updateTailSourceField(nextRuleDsl, field, decodeTailSourceValue(value));
      nextRuleDsl = updateTailRegexSourceField(nextRuleDsl, field, "");
    } else if (value.startsWith(TAIL_REGEX_SOURCE_PREFIX)) {
      const regexSource = decodeTailRegexSourceValue(value);
      nextRuleDsl = updateTailSourceField(nextRuleDsl, field, []);
      nextRuleDsl = updateTailRegexSourceField(nextRuleDsl, field, regexSource?.regex ?? "");
    } else {
      const columnIndex = value === "" ? null : Number(value);
      nextMapping[field] = Number.isFinite(columnIndex) ? columnIndex : null;
      nextRuleDsl = mergeRuleDslMapping(ruleDsl, nextMapping);
      nextRuleDsl = updateTailSourceField(nextRuleDsl, field, []);
      nextRuleDsl = updateTailRegexSourceField(nextRuleDsl, field, "");
    }

    setMapping(nextMapping);
    setRuleDsl(nextRuleDsl);
    setRuleStatus("映射列已更新，请确认后保存规则。");
  }

  function handleDefaultValueChange(field: UniversalImportField, value: string) {
    setRuleDsl((current) => updateRuleDefaultValue(current, field, value));
    setRuleStatus(value.trim() ? "默认值已更新，试解析时会补齐空字段。" : "默认值已清空。");
  }

  function handleFieldLabelChange(field: UniversalImportField, value: string) {
    setRuleDsl((current) => {
      const nextFieldLabels = { ...current.fieldLabels } as Record<UniversalImportField, string>;
      if (value) {
        nextFieldLabels[field] = value;
      } else {
        delete nextFieldLabels[field];
      }
      return {
        ...current,
        fieldLabels: nextFieldLabels,
      };
    });
    setRuleStatus(value ? `"${field}" 标签已更新为 "${value}"。` : `"${field}" 标签已恢复默认。`);
  }

  // ---- 新建规则弹框 ----
  function openNewRuleDialog() {
    setNewRuleForm({ receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "" });
    setNewRuleDialogOpen(true);
  }

  function closeNewRuleDialog() {
    setNewRuleDialogOpen(false);
  }

  async function confirmNewRule() {
    const { receiverStore, receiverName, receiverPhone, receiverAddress } = newRuleForm;
    const trimmed = {
      receiverStore: receiverStore.trim(),
      receiverName: receiverName.trim(),
      receiverPhone: receiverPhone.trim(),
      receiverAddress: receiverAddress.trim(),
    };

    closeNewRuleDialog();

    // 如果填写了收货信息，写入预设列表
    if (trimmed.receiverStore || trimmed.receiverName) {
      const preset: PresetReceiver = {
        id: crypto.randomUUID(),
        label: trimmed.receiverStore || trimmed.receiverName || "默认收货方",
        ...trimmed,
      };
      setRuleDsl((current) => ({
        ...current,
        presetReceivers: [...(current.presetReceivers ?? []), preset],
      }));
      setRuleStatus(`已添加预设收货信息，正在保存规则...`);
    } else {
      setRuleStatus(`正在保存空白规则...`);
    }

    try {
      await saveRule("POST");
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "保存规则失败，请稍后重试。");
    }
  }
  // ---- 新建规则弹框 END ----

  // ---- 预设收货信息 ----
  const presetReceivers = ruleDsl.presetReceivers ?? [];

  function openPresetEditor(mode: "add" | "edit", index?: number) {
    if (mode === "edit" && index !== undefined) {
      const preset = presetReceivers[index];
      if (preset) {
        setPresetEditorData({ ...preset });
        setPresetEditingIndex(index);
      }
    } else {
      setPresetEditorData(createEmptyPreset());
      setPresetEditingIndex(null);
    }
    setPresetEditorMode(mode);
    setPresetEditorOpen(true);
  }

  function closePresetEditor() {
    setPresetEditorOpen(false);
    setPresetEditorData(createEmptyPreset());
    setPresetEditingIndex(null);
  }

  function savePresetReceiver() {
    const { receiverStore, receiverName, receiverPhone, receiverAddress } = presetEditorData;
    if (!receiverStore.trim() && !receiverName.trim()) {
      setRuleStatus("请至少填写收货门店或收件人姓名。");
      return;
    }
    const saved: PresetReceiver = {
      ...presetEditorData,
      label: presetEditorData.label?.trim() || receiverStore.trim() || receiverName.trim() || "未命名",
      receiverStore: receiverStore.trim(),
      receiverName: receiverName.trim(),
      receiverPhone: receiverPhone.trim(),
      receiverAddress: receiverAddress.trim(),
    };

    setRuleDsl((current) => {
      const currentList = current.presetReceivers ?? [];
      let nextList: PresetReceiver[];
      if (presetEditorMode === "edit" && presetEditingIndex !== null) {
        nextList = [...currentList];
        nextList[presetEditingIndex] = saved;
      } else {
        nextList = [...currentList, saved];
      }
      return { ...current, presetReceivers: nextList };
    });

    closePresetEditor();
    setRuleStatus(
      presetEditorMode === "edit" ? `预设 "${saved.label}" 已更新。` : `已添加预设收货信息 "${saved.label}"。`,
    );
  }

  function deletePresetReceiver(index: number) {
    const preset = presetReceivers[index];
    setRuleDsl((current) => ({
      ...current,
      presetReceivers: (current.presetReceivers ?? []).filter((_, i) => i !== index),
    }));
    setRuleStatus(preset ? `已删除预设 "${preset.label ?? preset.receiverStore}"。` : "已删除预设。");
  }
  // ---- 预设收货信息 END ----

  function handleTransformConfigDraftChange(transformType: RuleTransformType, value: string) {
    setTransformConfigDrafts((current) => ({
      ...current,
      [transformType]: value,
    }));
  }

  function handleTransformConfigCommit(transformType: RuleTransformType) {
    const transform = ruleDsl.transforms.find((item) => item.type === transformType);
    const rawValue = transformConfigDrafts[transformType] ?? formatTransformConfig(transform?.config);
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Transform config 必须是 JSON 对象。");
      }

      setRuleDsl((current) => ({
        ...current,
        transforms: current.transforms.map((transform) =>
          transform.type === transformType
            ? {
                ...transform,
                config: parsed as Record<string, unknown>,
              }
            : transform,
        ),
      }));
      setTransformConfigDrafts((current) => ({
        ...current,
        [transformType]: JSON.stringify(parsed, null, 2),
      }));
      setRuleStatus(`${transformType} 配置已更新，请确认后保存规则。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "规则配置 JSON 格式不正确，请修正后再保存。");
    }
  }

  function buildRuleDslFromEditor() {
    const nextRuleDsl = mergeRuleDslMapping(ruleDsl, mapping);
    const transforms = nextRuleDsl.transforms.map((transform) => {
      const rawValue = transformConfigDrafts[transform.type];
      if (rawValue === undefined) {
        return transform;
      }

      const parsed = JSON.parse(rawValue) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${transform.type} 的 transform config 必须是 JSON 对象。`);
      }

      return {
        ...transform,
        config: parsed as Record<string, unknown>,
      };
    });

    return {
      ...nextRuleDsl,
      aiConfidenceReport,
      defaults: nextRuleDsl.defaults ?? {},
      transforms,
    };
  }

  function registerCellRef(rowId: string, field: UniversalImportField, node: HTMLInputElement | null) {
    const key = `${rowId}:${field}`;
    if (node) {
      cellRefs.current.set(key, node);
      return;
    }
    cellRefs.current.delete(key);
  }

  function focusCell(rowId: string, field: UniversalImportField) {
    const target = cellRefs.current.get(`${rowId}:${field}`);
    if (!target) {
      return;
    }
    target.focus();
    target.select();
  }

  function moveCellFocus(rowId: string, field: UniversalImportField, direction: "right" | "down") {
    const rowIndex = draftRows.findIndex((row) => row.id === rowId);
    const fieldIndex = UNIVERSAL_IMPORT_FIELDS.findIndex((item) => item.key === field);
    if (rowIndex < 0 || fieldIndex < 0) {
      return;
    }
    let nextRowIndex = rowIndex;
    let nextFieldIndex = fieldIndex;
    if (direction === "right") {
      if (fieldIndex < UNIVERSAL_IMPORT_FIELDS.length - 1) {
        nextFieldIndex += 1;
      } else if (rowIndex < draftRows.length - 1) {
        nextRowIndex += 1;
        nextFieldIndex = 0;
      }
    } else if (rowIndex < draftRows.length - 1) {
      nextRowIndex += 1;
    }
    const nextRow = draftRows[nextRowIndex];
    const nextField = UNIVERSAL_IMPORT_FIELDS[nextFieldIndex];
    if (!nextRow || !nextField) {
      return;
    }
    window.requestAnimationFrame(() => {
      focusCell(nextRow.id, nextField.key);
    });
  }

  function handleCellKeyDown(event: React.KeyboardEvent<HTMLInputElement>, rowId: string, field: UniversalImportField) {
    if (event.key === "Enter") {
      event.preventDefault();
      moveCellFocus(rowId, field, "down");
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      moveCellFocus(rowId, field, "right");
    }
  }

  async function loadHistory(nextFilters: HistoryFilters) {
    const requestId = historyRequestIdRef.current + 1;
    historyRequestIdRef.current = requestId;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    const timeoutId = window.setTimeout(() => controller.abort("history-timeout"), 12000);
    const normalizedFilters = {
      ...nextFilters,
      page: Math.max(nextFilters.page, 1),
      pageSize: Math.min(Math.max(nextFilters.pageSize, 1), 1000),
    };
    setHistoryLoading(true);
    setHistoryStatus("");
    try {
      const params = new URLSearchParams();
      if (normalizedFilters.query.trim()) params.set("query", normalizedFilters.query.trim());
      if (normalizedFilters.externalCode.trim()) params.set("externalCode", normalizedFilters.externalCode.trim());
      if (normalizedFilters.receiverName.trim()) params.set("receiverName", normalizedFilters.receiverName.trim());
      if (normalizedFilters.submittedAtStart.trim()) params.set("submittedAtStart", normalizedFilters.submittedAtStart.trim());
      if (normalizedFilters.submittedAtEnd.trim()) params.set("submittedAtEnd", normalizedFilters.submittedAtEnd.trim());
      params.set("page", String(normalizedFilters.page));
      params.set("pageSize", String(normalizedFilters.pageSize));
      const response = await fetch(`/api/universal-import/shipments?${params.toString()}`, {
        signal: controller.signal,
        cache: "no-store",
      });
      const data = (await response.json()) as ShipmentHistoryResponse;
      if (!response.ok || !data.records || typeof data.total !== "number") {
        throw new Error(data.error ?? "查询历史运单失败，请稍后重试。");
      }
      if (requestId !== historyRequestIdRef.current) {
        return;
      }
      setHistoryData(data);
      setHistoryFilters({
        ...normalizedFilters,
        page: data.page ?? normalizedFilters.page,
        pageSize: data.pageSize ?? normalizedFilters.pageSize,
      });
      setSelectedHistoryId((current) =>
        data.records?.some((record) => record.id === current) ? current : data.records?.[0]?.id ?? "",
      );
      setSelectedHistoryIds((current) => {
        const nextRecordIds = new Set((data.records ?? []).map((record) => record.id));
        return current.filter((id) => nextRecordIds.has(id));
      });
      historyLoadedOnceRef.current = true;
    } catch (error) {
      if (controller.signal.aborted) {
        if (requestId === historyRequestIdRef.current) {
          setHistoryStatus("历史数据加载超时，请重试。");
        }
        return;
      }
      if (requestId === historyRequestIdRef.current) {
        setHistoryStatus(error instanceof Error ? error.message : "查询历史运单失败，请稍后重试。");
      }
    } finally {
      window.clearTimeout(timeoutId);
      if (historyAbortRef.current === controller) {
        historyAbortRef.current = null;
      }
      if (requestId === historyRequestIdRef.current) {
        setHistoryLoading(false);
      }
    }
  }

  async function loadHistoryCodes() {
    if (historyCodesLoadedRef.current) {
      return;
    }
    try {
      const collected: ExistingExternalCodeEntry[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const response = await fetch(`/api/universal-import/shipments?page=${page}&pageSize=1000`);
        const data = (await response.json()) as ShipmentHistoryResponse;
        if (!response.ok || !data.records) {
          return;
        }
        collected.push(
          ...data.records
            .filter((record) => Boolean(record.externalCode?.trim()))
            .map((record) => ({
              externalCode: record.externalCode,
              batchName: record.batch.batchName,
              batchCreatedAt: record.batch.createdAt,
            })),
        );
        totalPages = data.totalPages ?? page;
        page += 1;
      } while (page <= totalPages);
      setExistingCodeRows(collected);
      historyCodesLoadedRef.current = true;
    } catch {
      // ignore warmup errors
    }
  }

  async function loadRules() {
    setRuleLoading(true);
    try {
      const response = await fetch("/api/universal-import/templates");
      const data = (await response.json()) as RuleListResponse;
      if (!response.ok || !data.templates) {
        throw new Error(data.error ?? "加载规则列表失败，请稍后重试。");
      }
      setRuleList(data.templates);
      setSelectedRuleIds((current) => {
        const nextRuleIds = new Set(data.templates?.map((rule) => rule.id) ?? []);
        return current.filter((id) => nextRuleIds.has(id));
      });
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "加载规则列表失败，请稍后重试。");
    } finally {
      setRuleLoading(false);
    }
  }

  function rejectFileSelection(message: string, file?: File) {
    setStatus(message);
    setRuleTestSummary("");
    setParseFailure({
      message,
      fileName: file?.name ?? "未识别文件",
      fileType,
      ruleName: ruleNameInput.trim() || selectedRuleId || "尚未选择规则",
      fileSize: file?.size ?? 0,
      lastModified: file?.lastModified ?? Date.now(),
    });
    pushToast(message, "error");
  }

  function handleFileSelected(file: File) {
    const detectedFileType = detectFileTypeFromName(file.name);
    const extension = getFileExtension(file.name);

    if (!detectedFileType) {
      rejectFileSelection(
        `文件格式错误：当前仅支持 ${SUPPORTED_FILE_EXTENSIONS.join("、")}，你上传的是 ${extension || "无扩展名文件"}。`,
        file,
      );
      return;
    }

    if (file.size <= 0) {
      rejectFileSelection("文件为空：请重新选择包含出库单内容的 Excel、Word 或 PDF 文件。", file);
      return;
    }

    const selectedRule = selectedRuleId ? ruleList.find((item) => item.id === selectedRuleId) : null;
    const incompatibleRuleSelected = Boolean(selectedRule && selectedRule.fileType !== detectedFileType);

    setSelectedFile(file);
    setFileName(file.name);
    setFileType(detectedFileType);
    setDraftRows([]);
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setSelectedIds([]);
    setSubmitBlockingIssues([]);
    setSubmitSummary(null);
    setHeaders([]);
    setColumnOptions([]);
    setTailSourceOptions({});
    setFingerprint("");
    setRuleTestSummary("");
    setAiSummary("");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setParseFailure(null);
    setPerformanceSnapshot(null);
    setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
    lastAutoPreviewSignatureRef.current = "";
    setParseFailure(null);
    setPerformanceSnapshot(null);
    setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
    lastAutoPreviewSignatureRef.current = "";
    setParseFailure(null);
    lastAutoPreviewSignatureRef.current = "";
    setParseProgress({
      active: true,
      value: 8,
      label: "文件已读取，等待选择解析规则",
      processed: getProcessedCountFromProgress(8, 100),
      total: 100,
    });
    setStatus(
      selectedRuleId
        ? "文件已上传，请点击「试解析选中规则」。"
        : "文件已上传，系统将使用默认规则解析，请点击「试解析选中规则」。",
    );
    if (incompatibleRuleSelected) {
      setSelectedRuleId("");
      setRuleNameInput("");
      setMapping(DEFAULT_MAPPING);
      setRuleDsl(buildDefaultRuleDsl(DEFAULT_MAPPING, detectedFileType));
      setTransformConfigDrafts({});
      setTemplateInfo("已清空与当前文件类型不匹配的规则，请重新手动选择。");
      setStatus("文件已上传，但原先选中的规则与当前文件类型不匹配，系统已为你清空规则选择。");
      pushToast("已清空不兼容的规则，请重新选择对应文件类型的解析规则。", "info");
    }
    window.setTimeout(() => {
      setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
    }, 900);
  }

  function handleRuleSelect(ruleId: string) {
    if (!ruleId) {
      setSelectedRuleId("");
      setRuleNameInput("");
      setAiRiskNotes([]);
      setAiConfidenceReport([]);
      setTailSourceOptions({});
      setAiProviderLabel("");
      setAiModelLabel("");
      setTemplateInfo("请先手动选择解析规则，不做自动匹配。");
      setStatus("已清空解析规则选择，试解析和提交前必须重新选择规则。");
      return;
    }

    const rule = ruleList.find((item) => item.id === ruleId);
    if (rule) {
      handleApplyRule(rule);
      setFileType(rule.fileType as SupportedImportFileType);
      setDraftRows([]);
      setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
      setSelectedIds([]);
      setFingerprint("");
      setRuleTestSummary("");
    }
  }

  function handleFileTypeChange(nextFileType: SupportedImportFileType) {
    setFileType(nextFileType);
    setSelectedFile(null);
    setFileName("");
    setSelectedRuleId("");
    setRuleNameInput("");
    setDraftRows([]);
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setSelectedIds([]);
    setHeaders([]);
    setColumnOptions([]);
    setTailSourceOptions({});
    setFingerprint("");
    setRuleTestSummary("");
    setMapping(DEFAULT_MAPPING);
    setRuleDsl(buildDefaultRuleDsl(DEFAULT_MAPPING, nextFileType));
    setTransformConfigDrafts({});
    setAiSummary("");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setTemplateInfo("文件类型已变更，请重新手动选择解析规则。");
    setStatus("文件类型已变更，请重新在「选择解析规则」中选择已保存规则。");
  }

  function applyRuleToState(
    rows: UniversalImportRow[],
    nextMapping: UniversalImportMapping,
    nextRuleDsl: UniversalImportRuleDsl,
    nextSheetName: string,
    nextFingerprint: string,
    nextHeaders: string[],
    nextColumnOptions = toColumnOptions(nextHeaders),
  ) {
    setDraftRows(toDraftRows(rows));
    setPreviewRenderLimit(PREVIEW_INITIAL_RENDER_COUNT);
    setMapping(nextMapping);
    setRuleDsl(nextRuleDsl);
    setSheetName(nextSheetName);
    setFingerprint(nextFingerprint);
    setHeaders(nextHeaders);
    setColumnOptions(nextColumnOptions);
    setSelectedIds([]);
    setTransformConfigDrafts({});
  }

  async function handleFileParse(file: File, nextFileType: SupportedImportFileType, nextMapping?: UniversalImportMapping, nextRuleDsl?: UniversalImportRuleDsl) {
    const startedAt = performance.now();
    setSelectedFile(file);
    setFileName(file.name);
    setFileType(nextFileType);
    setStatus("");
    setParseFailure(null);
    setPerformanceSnapshot(null);
    setSubmitSummary(null);
    setSubmitBlockingIssues([]);
    setParseProgress({
      active: true,
      value: 15,
      label: "正在上传文件并读取结构...",
      processed: getProcessedCountFromProgress(15, 100),
      total: 100,
    });

    try {
      const effectiveMapping = nextMapping ?? mapping;
      const effectiveRuleDsl = nextRuleDsl ?? ruleDsl;
      setParseProgress({
        active: true,
        value: 38,
        label: "正在按当前规则执行解析...",
        processed: getProcessedCountFromProgress(38, 100),
        total: 100,
      });
      const response = await fetch(
        "/api/universal-import/templates/test",
        {
          method: "POST",
          body: makeFormData(file, nextFileType, effectiveMapping, effectiveRuleDsl),
        },
      );
      const data = (await response.json()) as RuleTestResponse;

      if (!response.ok || !data.previewRows || !data.document || !data.fingerprint) {
        throw new Error(data.error ?? "解析失败，请稍后重试。");
      }

      setParseProgress({
        active: true,
        value: 76,
        label: "正在生成预览并执行校验...",
        processed: Math.min(data.previewRows.length, data.rowCount ?? data.previewRows.length),
        total: data.rowCount ?? data.previewRows.length,
      });
      const nextColumnOptions = buildColumnOptionsFromDocument(data.document, effectiveRuleDsl);
      applyRuleToState(
        data.previewRows,
        effectiveMapping,
        effectiveRuleDsl,
        data.document.sheetName,
        data.fingerprint,
        nextColumnOptions.map((option) => option.header),
        nextColumnOptions,
      );
      setRuleTestSummary(
        `试解析完成：输出 ${data.rowCount ?? 0} 行，发现 ${data.issueCount ?? 0} 个校验问题。`,
      );
      setTemplateInfo(`当前规则模式：${effectiveRuleDsl.mode}`);
      setStatus("文件解析成功，可继续编辑、保存规则或提交。");
      setParseFailure(null);
      setPerformanceSnapshot({
        parseMs: Math.round(performance.now() - startedAt),
        totalRows: data.rowCount ?? data.previewRows.length,
        renderedRows: Math.min(data.previewRows.length, PREVIEW_INITIAL_RENDER_COUNT),
        issueCount: data.issueCount ?? 0,
        renderMode: data.previewRows.length > PREVIEW_INITIAL_RENDER_COUNT ? "batched" : "full",
      });
      setParseProgress({ active: true, value: 100, label: "解析完成", processed: data.rowCount ?? 0, total: data.rowCount ?? 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "解析失败，请稍后重试。";
      setStatus(message);
      setParseFailure({
        message,
        fileName: file.name,
        fileType: nextFileType,
        ruleName: ruleNameInput.trim() || "未命名规则",
        fileSize: file.size,
        lastModified: file.lastModified,
      });
    } finally {
      window.setTimeout(() => {
        setParseProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  async function handleAiSuggest() {
    if (!selectedFile) {
      setAiSummary("请先上传样例文件后再生成 AI 规则建议。");
      return;
    }

    setAiSuggesting(true);
    setAiSummary("正在生成 AI 规则建议...");
    setAiRiskNotes([]);
    setAiConfidenceReport([]);
    setParseFailure(null);
    setSubmitBlockingIssues([]);
    setSubmitSummary(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("fileType", fileType);
      const response = await fetch("/api/universal-import/templates/ai-suggest", {
        method: "POST",
        body: formData,
      });
      const data = await readJsonResponse<AiSuggestResponse>(response);
      if (!response.ok || !data.suggestedRule || !data.documentSummary) {
        throw new Error(data.error ?? "AI 规则建议生成失败，请稍后重试。");
      }

      const normalizedMapping = normalizeMapping(data.suggestedRule.mapping) ?? DEFAULT_MAPPING;
      setRuleDsl(data.suggestedRule);
      setTransformConfigDrafts({});
      setSelectedRuleId("");
      setDraftRows([]);
      setSelectedIds([]);
      setFingerprint("");
      setRuleTestSummary("");
      setMapping(normalizedMapping);
      const nextColumnOptions = data.documentSummary.columnOptions?.length
        ? data.documentSummary.columnOptions
        : toColumnOptions(data.documentSummary.headers);
      setHeaders(nextColumnOptions.map((option) => option.header));
      setColumnOptions(nextColumnOptions);
      setTailSourceOptions(data.documentSummary.tailSourceOptions ?? {});
      setSheetName(data.documentSummary.sheetName);
      setAiRiskNotes(data.riskNotes ?? []);
      setAiConfidenceReport(data.confidenceReport ?? []);
      setAiProviderLabel(
        data.provider === "deepseek"
          ? "DeepSeek 官网实时生成"
          : data.provider === "siliconflow"
            ? "SiliconFlow 实时生成"
            : "本地兜底规则",
      );
      setAiModelLabel(data.model ?? "");
      setAiSummary(
        data.aiSummary ||
          `AI 已生成建议规则：文件类型 ${data.documentSummary.fileType}，识别表头 ${data.documentSummary.headers.length} 列。`,
      );
      setTemplateInfo("AI 建议规则已就绪，可直接试解析或继续人工调整。");
    } catch (error) {
      setAiProviderLabel("");
      setAiModelLabel("");
      setAiSummary(
        error instanceof TypeError && /fetch/i.test(error.message)
          ? "AI 规则建议请求未能连接到服务器，请检查网络、文件大小或稍后重试。"
          : error instanceof Error
            ? error.message
            : "AI 规则建议生成失败，请稍后重试。",
      );
    } finally {
      setAiSuggesting(false);
    }
  }

  async function saveRule(method: "POST" | "PUT", ruleId?: string) {
    const editorRuleDsl = buildRuleDslFromEditor();
    setRuleDsl(editorRuleDsl);

    const payload = {
      ruleName: ruleNameInput.trim() || sheetName || "导入规则",
      sheetName,
      headers,
      mapping,
      fileType,
      status: "ACTIVE",
      ruleDsl: editorRuleDsl,
    };

    const endpoint = method === "POST" ? "/api/universal-import/templates" : `/api/universal-import/templates/${ruleId}`;
    const response = await fetch(endpoint, {
      method,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = (await response.json()) as RuleUpsertResponse;
    if (!response.ok || !data.template) {
      throw new Error(data.error ?? "保存规则失败，请稍后重试。");
    }

    setSelectedRuleId(data.template.id);
    setRuleNameInput(data.template.ruleName);
    setLastSavedAt(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
    await loadRules();
    return data.template;
  }

  async function handleSaveCurrentRule() {
    try {
      const template = await saveRule("POST");
      setRuleStatus(
        headers.length > 0
          ? `规则"${template.ruleName}"已保存。`
          : `空白规则"${template.ruleName}"已创建，可后续上传样例文件、生成 AI 建议或编辑规则配置。`,
      );
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "保存规则失败，请稍后重试。");
    }
  }

  async function handleConfirmAiSuggestionSave() {
    if (!selectedFile || headers.length === 0) {
      setRuleStatus("请先上传样例文件，并点击 AI 生成规则建议。");
      return;
    }
    try {
      const template = await saveRule("POST");
      setRuleStatus(`AI 建议已确认，并保存为规则"${template.ruleName}"。`);
      setStatus(`AI 建议已确认，并保存为规则"${template.ruleName}"。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "确认 AI 建议失败，请稍后重试。");
    }
  }

  async function handleUpdateSelectedRule() {
    if (!selectedRuleId) {
      setRuleStatus("请先选择一条规则再更新。");
      return;
    }
    try {
      const template = await saveRule("PUT", selectedRuleId);
      setRuleStatus(`规则"${template.ruleName}"已更新到版本 ${template.version}。`);
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "更新规则失败，请稍后重试。");
    }
  }

  function handleApplyRule(rule: RuleRecord) {
    const normalizedMapping = normalizeMapping(rule.mapping) ?? DEFAULT_MAPPING;
    const nextRuleDsl = rule.ruleDsl ?? buildDefaultRuleDsl(normalizedMapping, rule.fileType as SupportedImportFileType);
    const sampleHeaders = getSampleHeaders(rule.sampleMeta);
    const savedConfidenceReport = nextRuleDsl.aiConfidenceReport ?? [];
    setSelectedRuleId(rule.id);
    setRuleNameInput(rule.ruleName);
    setMapping(normalizedMapping);
    setRuleDsl(nextRuleDsl);
    setTransformConfigDrafts({});
    setAiConfidenceReport(savedConfidenceReport);
    setAiRiskNotes([]);
    setAiProviderLabel("");
    setAiModelLabel("");
    setHeaders(sampleHeaders);
    setColumnOptions(toColumnOptions(sampleHeaders));
    setFileType(rule.fileType as SupportedImportFileType);
    setDraftRows([]);
    setSelectedIds([]);
    setSelectedPresetId("");
    setFingerprint("");
    setRuleTestSummary("");
    setTemplateInfo(`当前使用规则：${rule.ruleName}`);
    setStatus(`已选择规则：${rule.ruleName}。请上传样例文件或重新试解析。`);
  }

  function handleEditRule(rule: RuleRecord) {
    const presets = (rule.ruleDsl as UniversalImportRuleDsl | null)?.presetReceivers ?? [];
    const firstPreset = presets[0];
    setEditingRuleId(rule.id);
    setEditRuleForm({
      ruleName: rule.ruleName,
      receiverStore: firstPreset?.receiverStore ?? "",
      receiverName: firstPreset?.receiverName ?? "",
      receiverPhone: firstPreset?.receiverPhone ?? "",
      receiverAddress: firstPreset?.receiverAddress ?? "",
    });
    setEditRuleDialogOpen(true);
  }

  function closeEditRuleDialog() {
    setEditRuleDialogOpen(false);
    setEditingRuleId("");
  }

  async function confirmEditRule() {
    const { ruleName, receiverStore, receiverName, receiverPhone, receiverAddress } = editRuleForm;
    const trimmed = {
      ruleName: ruleName.trim(),
      receiverStore: receiverStore.trim(),
      receiverName: receiverName.trim(),
      receiverPhone: receiverPhone.trim(),
      receiverAddress: receiverAddress.trim(),
    };

    closeEditRuleDialog();

    try {
      const payload: Record<string, unknown> = {
        ruleName: trimmed.ruleName || "导入规则",
      };

      if (trimmed.receiverStore || trimmed.receiverName) {
        const preset: PresetReceiver = {
          id: crypto.randomUUID(),
          label: trimmed.receiverStore || trimmed.receiverName || "默认收货方",
          receiverStore: trimmed.receiverStore,
          receiverName: trimmed.receiverName,
          receiverPhone: trimmed.receiverPhone,
          receiverAddress: trimmed.receiverAddress,
        };
        payload.ruleDsl = {
          presetReceivers: [preset],
        };
      }

      const response = await fetch(`/api/universal-import/templates/${editingRuleId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { template?: RuleRecord; error?: string };
      if (!response.ok || !data.template) {
        throw new Error(data.error ?? "更新规则失败，请稍后重试。");
      }
      setRuleStatus(`规则「${data.template.ruleName}」已更新。`);
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "更新规则失败，请稍后重试。");
    }
  }

  function openDeleteConfirm(target: DeleteConfirmTarget) {
    setDeleteConfirmTarget(target);
  }

  function closeDeleteConfirm() {
    if (historyDeleting || ruleDeleting) {
      return;
    }
    setDeleteConfirmTarget(null);
  }

  async function deleteRuleById(ruleId: string) {
    setRuleDeleting(true);
    try {
      const response = await fetch(`/api/universal-import/templates/${ruleId}`, {
        method: "DELETE",
      });
      const data = (await response.json()) as { success?: boolean; error?: string };
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "删除规则失败，请稍后重试。");
      }
      if (selectedRuleId === ruleId) {
        setSelectedRuleId("");
        setRuleNameInput("");
        setTemplateInfo("请先手动选择解析规则，不做自动匹配。");
        setStatus("当前选中的规则已删除，请重新选择或新建规则。");
      }
      setRuleStatus("规则已删除。");
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "删除规则失败，请稍后重试。");
    } finally {
      setRuleDeleting(false);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    openDeleteConfirm({ type: "rule-single", id: ruleId });
  }

  function toggleHistorySelection(recordId: string, checked: boolean) {
    setSelectedHistoryIds((current) =>
      checked ? Array.from(new Set([...current, recordId])) : current.filter((id) => id !== recordId),
    );
  }

  function toggleAllHistorySelection(checked: boolean) {
    setSelectedHistoryIds((current) => {
      if (!checked) {
        return current.filter((id) => !currentHistoryIds.includes(id));
      }
      return Array.from(new Set([...current, ...currentHistoryIds]));
    });
  }

  async function deleteHistoryByIds(ids: string[]) {
    setHistoryDeleting(true);
    setHistoryStatus("");
    try {
      const response = await fetch("/api/universal-import/shipments", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids }),
      });
      const data = (await response.json()) as BatchDeleteResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "批量删除历史运单失败，请稍后重试。");
      }
      setSelectedHistoryIds([]);
      if (ids.includes(selectedHistoryId)) {
        setSelectedHistoryId("");
      }
      setHistoryStatus(`已删除 ${data.deletedCount ?? ids.length} 条历史运单。`);
      historyCodesLoadedRef.current = false;
      await loadHistory({ ...historyFilters });
      void loadHistoryCodes();
    } catch (error) {
      setHistoryStatus(error instanceof Error ? error.message : "批量删除历史运单失败，请稍后重试。");
    } finally {
      setHistoryDeleting(false);
    }
  }

  async function handleBatchDeleteHistory() {
    const ids = selectedHistoryIds;
    if (ids.length === 0) {
      setHistoryStatus("请先勾选要删除的历史运单。");
      return;
    }
    openDeleteConfirm({ type: "history-batch", ids });
  }

  function toggleRuleSelection(ruleId: string, checked: boolean) {
    setSelectedRuleIds((current) =>
      checked ? Array.from(new Set([...current, ruleId])) : current.filter((id) => id !== ruleId),
    );
  }

  function toggleAllRuleSelection(checked: boolean) {
    setSelectedRuleIds(checked ? ruleList.map((rule) => rule.id) : []);
  }

  async function deleteRulesByIds(ids: string[]) {
    setRuleDeleting(true);
    setRuleStatus("");
    try {
      const response = await fetch("/api/universal-import/templates", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids }),
      });
      const data = (await response.json()) as BatchDeleteResponse;
      if (!response.ok || !data.success) {
        throw new Error(data.error ?? "批量删除规则失败，请稍后重试。");
      }
      setSelectedRuleIds([]);
      if (ids.includes(selectedRuleId)) {
        setSelectedRuleId("");
        setRuleNameInput("");
        setTemplateInfo("请先手动选择解析规则，不做自动匹配。");
        setStatus("当前选中的规则已删除，请重新选择或新建规则。");
      }
      setRuleStatus(`已删除 ${data.deletedCount ?? ids.length} 条规则。`);
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "批量删除规则失败，请稍后重试。");
    } finally {
      setRuleDeleting(false);
    }
  }

  async function handleBatchDeleteRules() {
    const ids = selectedRuleIds;
    if (ids.length === 0) {
      setRuleStatus("请先勾选要删除的规则。");
      return;
    }
    openDeleteConfirm({ type: "rule-batch", ids });
  }

  async function handleConfirmDelete() {
    if (!deleteConfirmTarget) {
      return;
    }

    if (deleteConfirmTarget.type === "history-batch") {
      await deleteHistoryByIds(deleteConfirmTarget.ids);
    } else if (deleteConfirmTarget.type === "rule-batch") {
      await deleteRulesByIds(deleteConfirmTarget.ids);
    } else {
      await deleteRuleById(deleteConfirmTarget.id);
    }

    setDeleteConfirmTarget(null);
  }

  async function handleCopyRule(rule: RuleRecord) {
    try {
      const response = await fetch(`/api/universal-import/templates/${rule.id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ruleName: `${rule.ruleName} 副本`,
        }),
      });
      const data = (await response.json()) as RuleUpsertResponse;
      if (!response.ok || !data.template) {
        throw new Error(data.error ?? "复制规则失败，请稍后重试。");
      }

      handleApplyRule(data.template);
      setRuleStatus(`规则"${data.template.ruleName}"已复制，可继续调整后保存。`);
      setStatus(`已复制规则 ${data.template.ruleName}，当前编辑区已同步到新副本规则。`);
      await loadRules();
    } catch (error) {
      setRuleStatus(error instanceof Error ? error.message : "复制规则失败，请稍后重试。");
    }
  }

  async function handleTestCurrentRule() {
    if (!selectedFile) {
      setRuleTestSummary("请先上传样例文件。");
      return;
    }
    await handleFileParse(selectedFile, fileType, mapping, ruleDsl);
  }

  async function handleTestDraftRule() {
    if (!selectedFile) {
      setStatus("请先上传样例文件。");
      return;
    }

    try {
      const editorRuleDsl = buildRuleDslFromEditor();
      setRuleDsl(editorRuleDsl);
      setStatus("正在使用当前 AI 建议和人工调整后的映射试解析。");
      await handleFileParse(selectedFile, fileType, mapping, editorRuleDsl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "当前规则配置不正确，请检查字段映射和规则配置。");
    }
  }

  function shouldAutoPreview() {
    if (!selectedFile || aiSuggesting || activeTab === "history") {
      return false;
    }

    if (activeTab === "import" && !selectedRuleId && headers.length === 0) {
      return false;
    }

    return Boolean(selectedRuleId || headers.length > 0 || aiConfidenceReport.length > 0);
  }

  function applyPresetToRows() {
    const preset = presetReceivers.find((p) => p.id === selectedPresetId);
    if (!preset) {
      pushToast("请先选择一个预设收货信息。", "error");
      return;
    }
    const targetIds = selectedIds.length > 0 ? new Set(selectedIds) : new Set(draftRows.map((row) => row.id));

    setDraftRows((current) =>
      current.map((row) => {
        if (!targetIds.has(row.id)) return row;
        return {
          ...row,
          receiverStore: preset.receiverStore || row.receiverStore,
          receiverName: preset.receiverName || row.receiverName,
          receiverPhone: preset.receiverPhone || row.receiverPhone,
          receiverAddress: preset.receiverAddress || row.receiverAddress,
        };
      }),
    );

    const targetCount = selectedIds.length > 0 ? selectedIds.length : draftRows.length;
    pushToast(`已将预设 "${preset.label || preset.receiverStore}" 应用到 ${targetCount} 行。`, "success");
    setSelectedPresetId("");
  }

  function handleCellChange(rowId: string, field: UniversalImportField, value: string) {
    setDraftRows((current) => current.map((row) => (row.id === rowId ? { ...row, [field]: value } : row)));
  }

  function addEmptyRow() {
    const nextLength = draftRows.length + 1;
    setDraftRows((current) => {
      return [...current, createEmptyDraftRow(current.length + 1)];
    });
    setPreviewRenderLimit((currentLimit) => Math.max(currentLimit, Math.min(nextLength, currentLimit + 1)));
    setStatus("已新增空行。");
  }

  function deleteRows(ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    const nextLength = draftRows.filter((row) => !idSet.has(row.id)).length;
    setDraftRows((current) =>
      current
        .filter((row) => !idSet.has(row.id))
        .map((row, index) => ({ ...row, rowIndex: index + 1 })),
    );
    setPreviewRenderLimit((currentLimit) =>
      Math.max(PREVIEW_INITIAL_RENDER_COUNT, Math.min(currentLimit, nextLength)),
    );
    setSelectedIds((current) => current.filter((id) => !idSet.has(id)));
    setStatus("已删除所选行。");
  }

  function showMorePreviewRows() {
    setPreviewRenderLimit((current) => Math.min(current + PREVIEW_RENDER_BATCH_SIZE, draftRows.length));
  }

  function showAllPreviewRows() {
    setPreviewRenderLimit(draftRows.length);
  }

  function exportPreview() {
    if (draftRows.length === 0) {
      setStatus("当前没有可导出的数据。");
      return;
    }
    downloadWorkbook(draftRows, sheetName);
    setStatus("已导出预览文件。");
  }

  async function submitImport() {
    setSubmitBlockingIssues([]);
    if (!selectedRuleId) {
      setStatus("请先手动选择解析规则，再提交下单。");
      return;
    }

    if (draftRows.length === 0) {
      setStatus("请先导入并试解析文件。");
      return;
    }

    const rowsToSubmit = selectedIds.length > 0
      ? draftRows.filter((row) => selectedIds.includes(row.id))
      : draftRows;

    if (rowsToSubmit.length === 0) {
      setStatus("请先勾选要提交的数据行。");
      return;
    }

    const immediateValidation = validateImportRows(rowsToSubmit, existingExternalCodes);
    if (immediateValidation.issues.length > 0) {
      const issues = immediateValidation.issues.map((issue) => formatIssueLabel(issue));
      setSubmitBlockingIssues(issues);
      setStatus(`选中行存在 ${immediateValidation.issues.length} 个未修正问题，请先处理后再提交。`);
      pushToast("提交被阻止，请先查看并修正错误明细。", "error");
      return;
    }
    setSubmitting(true);
    setSubmitSummary(null);
    setSubmitProgress({
      active: true,
      value: 12,
      label: "正在提交...",
      processed: getProcessedCountFromProgress(12, rowsToSubmit.length),
      total: rowsToSubmit.length,
    });

    const timer = window.setInterval(() => {
      setSubmitProgress((current) => {
        const nextValue = Math.min(current.value + 8, 92);

        return {
          ...current,
          value: nextValue,
          processed: getProcessedCountFromProgress(nextValue, current.total),
        };
      });
    }, 180);

    try {
      const response = await fetch("/api/universal-import/shipments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          batchName: fileName || `${sheetName} 批次`,
          originalFileName: fileName,
          fileType,
          sheetName,
          headers,
          mapping,
          fingerprint,
          ruleId: selectedRuleId,
          rows: rowsToSubmit,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        issues?: string[];
        summary?: {
          successCount: number;
          failCount: number;
          shipmentCount: number;
          failedShipmentCount: number;
        };
        results?: SubmitResult[];
      };
      if (!response.ok) {
        setSubmitBlockingIssues(data.issues ?? []);
        throw new Error(data.error ?? "提交导入失败，请稍后重试。");
      }
      const summary = {
        successCount: data.summary?.successCount ?? rowsToSubmit.length,
        failCount: data.summary?.failCount ?? 0,
        shipmentCount: data.summary?.shipmentCount ?? 0,
        failedShipmentCount: data.summary?.failedShipmentCount ?? 0,
      };
      const failedResults = (data.results ?? []).filter((item) => item.status === "failed");
      const statusMessage =
        summary.failCount > 0
          ? `提交完成：成功 ${summary.successCount} 行，失败 ${summary.failCount} 行；生成 ${summary.shipmentCount} 个运单，失败 ${summary.failedShipmentCount} 个。`
          : `提交成功 ${summary.successCount} 行，生成 ${summary.shipmentCount} 个运单。`;
      setSubmitProgress({
        active: true,
        value: 100,
        label: summary.failCount > 0 ? "部分完成" : "完成",
        processed: rowsToSubmit.length,
        total: rowsToSubmit.length,
      });
      setStatus(statusMessage);
      setSubmitSummary({
        ...summary,
        failedResults,
        blockingIssues: [],
        submittedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      });
      pushToast(statusMessage, summary.failCount > 0 ? "error" : "success");
      void loadHistory({ ...historyFilters, page: 1 });
      void loadHistoryCodes();
    } catch (error) {
      const message = error instanceof Error ? error.message : "提交导入失败，请稍后重试。";
      setStatus(message);
      pushToast(message, "error");
    } finally {
      window.clearInterval(timer);
      setSubmitting(false);
      window.setTimeout(() => {
        setSubmitProgress({ active: false, value: 0, label: "", processed: 0, total: 0 });
      }, 700);
    }
  }

  function toggleExpanded(path: string) {
    setExpandedMenuPaths((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path],
    );
  }

  function handleSidebarItemClick(item: SidebarMenuItem, path: string) {
    if (item.children?.length) {
      toggleExpanded(path);
      return;
    }
    setActiveMenuPath(path);
    if (item.href === "/universal-import") {
      setActiveTab("import");
      return;
    }
    if (item.href === "/universal-import?tab=history") {
      setActiveTab("history");
      return;
    }
    if (item.href === "/universal-import?tab=rules") {
      setActiveTab("rules");
      return;
    }
  }

  function renderSidebarMenus(items: SidebarMenuItem[], parentPath = "", depth = 0) {
    return (
      <div className={`sidebar-menu-level level-${depth}`}>
        {items.map((item) => {
          const path = parentPath ? `${parentPath}/${item.label}` : item.label;
          const expanded = expandedMenuPaths.includes(path);
          const active = activeMenuPath === path || activeMenuPath.startsWith(`${path}/`);

          return (
            <div className="sidebar-menu-group" key={path}>
              <button
                type="button"
                className={`sidebar-nav-item${active ? " active" : ""}`}
                onClick={() => handleSidebarItemClick(item, path)}
              >
                <span className="sidebar-nav-icon" aria-hidden="true" />
                <span className="sidebar-nav-label">{item.label}</span>
                {item.children?.length ? <span className={`sidebar-caret${expanded ? " expanded" : ""}`}>{expanded ? "▼" : "▶"}</span> : null}
              </button>
              {item.children?.length && expanded ? <div className="sidebar-subnav">{renderSidebarMenus(item.children, path, depth + 1)}</div> : null}
            </div>
          );
        })}
      </div>
    );
  }

  useEffect(() => {
    void loadRules();
  }, []);

  useEffect(() => {
    const nextTab = resolveTabParam(searchParams?.get("tab"));
    setActiveTab((current) => (current === nextTab ? current : nextTab));
  }, [searchParams]);

  useEffect(() => {
    if (activeTab === "history") {
      setActiveMenuPath("万能导入/运单管理");
      return;
    }

    if (activeTab === "rules") {
      setActiveMenuPath("万能导入/规则管理");
      return;
    }

    setActiveMenuPath("万能导入/万能导入");
  }, [activeTab]);

  useEffect(() => {
    const currentTabParam = resolveTabParam(searchParams?.get("tab"));
    if (currentTabParam === activeTab) {
      return;
    }
    const nextUrl = activeTab === "import" ? pathname : `${pathname}?tab=${activeTab}`;
    router.replace(nextUrl, { scroll: false });
  }, [activeTab, pathname, router, searchParams]);

  useEffect(() => {
    if (activeTab !== "history" || historyLoading || historyLoadedOnceRef.current) {
      return;
    }
    void loadHistory(historyFilters);
  }, [activeTab, historyFilters, historyLoading]);

  useEffect(() => {
    if (!selectedFile || historyCodesLoadedRef.current) {
      return;
    }
    void loadHistoryCodes();
  }, [selectedFile]);

  useEffect(() => {
    setRuleDsl((current) => ({
      ...current,
      fileType,
      mode: fileType === "excel" ? "structured" : "text",
      mapping,
    }));
  }, [fileType, mapping]);

  useEffect(() => {
    if (autoPreviewTimerRef.current) {
      window.clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }

    if (!shouldAutoPreview()) {
      return;
    }

    let cancelled = false;
    autoPreviewTimerRef.current = window.setTimeout(() => {
      void (async () => {
        if (cancelled || autoPreviewBusyRef.current || !selectedFile) {
          return;
        }

        try {
          const editorRuleDsl = buildRuleDslFromEditor();
          const signature = JSON.stringify({
            fileName: selectedFile.name,
            lastModified: selectedFile.lastModified,
            fileType,
            selectedRuleId,
            mapping,
            ruleDsl: editorRuleDsl,
          });

          if (signature === lastAutoPreviewSignatureRef.current) {
            return;
          }

          autoPreviewBusyRef.current = true;
          setStatus("检测到规则变更，正在自动试解析预览...");
          await handleFileParse(selectedFile, fileType, mapping, editorRuleDsl);
          lastAutoPreviewSignatureRef.current = signature;
        } catch (error) {
          setRuleStatus(error instanceof Error ? error.message : "当前规则配置不正确，请检查字段映射和规则配置。");
        } finally {
          autoPreviewBusyRef.current = false;
        }
      })();
    }, 700);

    return () => {
      cancelled = true;
      if (autoPreviewTimerRef.current) {
        window.clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
  }, [activeTab, aiConfidenceReport, aiSuggesting, fileType, headers.length, mapping, ruleDsl, selectedFile, selectedRuleId, transformConfigDrafts]);

  useEffect(() => {
    return () => {
      historyAbortRef.current?.abort();
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
      if (autoPreviewTimerRef.current) {
        window.clearTimeout(autoPreviewTimerRef.current);
      }
    };
  }, []);

  const submitBlockedHint = !selectedRuleId
    ? "请先手动选择解析规则后再提交。"
    : hasBlockingErrors
      ? selectedIds.length > 0
        ? `选中行存在 ${selectedErrorCount ?? 0} 个未修正问题，请先修正后再提交。`
        : `存在 ${rowErrorSummary.length} 个未修正问题，请先修正后再提交。`
      : "";
  const currentMenuTitle =
    activeTab === "rules" ? "规则管理" : activeTab === "history" ? "历史运单" : "运单管理";

  return (
    <main className="dashboard-shell">
      <div className="dashboard-main">
        <header className="global-topbar">
          <div className="global-topbar-nav">
            <span className="brand-tag">AI</span>
            <strong className="brand-title">智能多格式批量下单系统</strong>
          </div>
        </header>

        <section className="workspace-shell">
          <div className="workspace-tabbar">
            <button
              type="button"
              className={`workspace-tab ${activeTab === "import" ? "active" : ""}`}
              onClick={() => setActiveTab("import")}
            >
              运单管理
            </button>
            <button
              type="button"
              className={`workspace-tab ${activeTab === "history" ? "active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              历史运单
            </button>
            <button
              type="button"
              className={`workspace-tab ${activeTab === "rules" ? "active" : ""}`}
              onClick={() => setActiveTab("rules")}
            >
              规则管理
            </button>
          </div>

          <div className="workspace-stage">
            {activeTab === "import" ? (
              <>
                <section className="workspace-card">
                  <div className="workspace-header">
                    <div className="import-stat-grid">
                      <article className="overview-card accent">
                        <p>预览行数</p>
                        <strong>{totalCount}</strong>
                        <span>当前解析出的 SKU 行</span>
                      </article>
                      <article className="overview-card warning">
                        <p>错误行数</p>
                        <strong>{errorRowCount}</strong>
                        <span>提交前必须修正</span>
                      </article>
                      <article className="overview-card success">
                        <p>预览运单</p>
                        <strong>{groupedPreviewCount || 0}</strong>
                        <span>按外部编码聚合后的运单数</span>
                      </article>
                      <article className="overview-card">
                        <p>规则模式</p>
                        <strong>{ruleDsl.mode}</strong>
                        <span>{templateInfo || "可在规则管理中保存和调试"}</span>
                      </article>
                    </div>
                  </div>
                </section>

                <section className="import-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">导入区</p>
                        <h3>多格式上传、AI 建议与试解析</h3>
                      </div>
                      <div className="toolbar">
                        <button type="button" className="secondary-button" onClick={() => fileInputRef.current?.click()}>
                          选择文件
                        </button>
                        <input
                          ref={fileInputRef}
                          hidden
                          type="file"
                          accept=".xlsx,.xls,.docx,.pdf"
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            if (file) {
                              handleFileSelected(file);
                            }
                            event.target.value = "";
                          }}
                        />
                      </div>
                    </div>

                    <div className="history-filters">
                      <label className="search-field">
                        <span>文件类型</span>
                        <select value={fileType} onChange={(event) => handleFileTypeChange(event.target.value as SupportedImportFileType)}>
                          <option value="excel">Excel</option>
                          <option value="word">Word</option>
                          <option value="pdf">PDF</option>
                        </select>
                      </label>
                      <label className="search-field">
                        <span>选择解析规则</span>
                        <select
                          value={selectedRuleId}
                          onChange={(event) => handleRuleSelect(event.target.value)}
                          disabled={ruleLoading}
                        >
                          <option value="">
                            {ruleLoading ? "正在加载规则..." : "请选择已保存规则"}
                          </option>
                          {ruleList.map((rule) => (
                            <option value={rule.id} key={rule.id}>
                              {rule.ruleName} / {rule.fileType} / v{rule.version}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="search-field">
                        <span>规则名称</span>
                        <input value={ruleNameInput} onChange={(event) => setRuleNameInput(event.target.value)} placeholder="例如：门店矩阵配送规则" />
                      </label>
                    </div>

                    <div
                      className={`upload-dropzone${dragActive ? " active" : ""}`}
                      onClick={() => fileInputRef.current?.click()}
                      onDragEnter={(event) => {
                        event.preventDefault();
                        setDragActive(true);
                      }}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragActive(true);
                      }}
                      onDragLeave={(event) => {
                        event.preventDefault();
                        setDragActive(false);
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        setDragActive(false);
                        const file = event.dataTransfer.files?.[0];
                        if (file) {
                          handleFileSelected(file);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          fileInputRef.current?.click();
                        }
                      }}
                    >
                      <strong>第 1 步：上传样例文件（Excel / Word / PDF）</strong>
                      <span>支持 .xlsx / .xls / .docx / .pdf；系统不会自动匹配规则，请在下方手动选择已有规则，或进入规则管理新建规则。</span>
                      {selectedFile ? (
                        <span>当前样例：{selectedFile.name}（{formatFileSize(selectedFile.size)}，{formatFileTypeLabel(fileType)}）</span>
                      ) : (
                        <span>当前尚未上传样例文件，请先完成第 1 步。</span>
                      )}
                    </div>

                    <div className="toolbar import-action-toolbar" style={{ marginTop: 16 }}>
                      <button type="button" className="primary-button" onClick={() => void handleAiSuggest()} disabled={!selectedFile && headers.length === 0 || aiSuggesting}>
                        {aiSuggesting ? "AI 生成中..." : "AI 生成规则建议"}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void handleTestCurrentRule()} disabled={!selectedFile && draftRows.length === 0}>
                        试解析选中规则
                      </button>
                      <button type="button" className="tool-button quiet" onClick={exportPreview} disabled={draftRows.length === 0}>
                        导出 Excel
                      </button>
                      <button type="button" className="tool-button quiet" onClick={addEmptyRow}>
                        + 新增行
                      </button>
                    </div>

                    <div className="status-panel">
                      <p className={`status-text${status ? " visible" : ""}`}>{status || " "}</p>
                      <p className="footnote">{aiSummary || ruleTestSummary || rowErrorSummary[0] || "这里会显示 AI 建议、试解析和校验结果。"}</p>
                    </div>

                    {parseFailure ? (
                      <div className="parse-failure-card">
                        <div className="card-heading compact">
                          <div>
                            <p className="section-kicker">解析失败</p>
                            <h3>请根据原始文件信息调整规则后再试解析</h3>
                          </div>
                          <button type="button" className="secondary-button" onClick={() => setActiveTab("rules")}>
                            前往规则管理
                          </button>
                          <button type="button" className="primary-button" onClick={() => void handleAiSuggest()} disabled={!selectedFile && headers.length === 0 || aiSuggesting}>
                            {aiSuggesting ? "AI 分析中..." : "重新生成 AI 规则"}
                          </button>
                        </div>
                        <div className="result-summary-grid">
                          <div>
                            <span>失败原因</span>
                            <strong>{parseFailure.message}</strong>
                          </div>
                          <div>
                            <span>原始文件</span>
                            <strong>{parseFailure.fileName}</strong>
                          </div>
                          <div>
                            <span>文件类型</span>
                            <strong>{formatFileTypeLabel(parseFailure.fileType)}</strong>
                          </div>
                          <div>
                            <span>文件大小</span>
                            <strong>{formatFileSize(parseFailure.fileSize)}</strong>
                          </div>
                          <div>
                            <span>最后修改</span>
                            <strong>{new Date(parseFailure.lastModified).toLocaleString("zh-CN", { hour12: false })}</strong>
                          </div>
                          <div>
                            <span>当前规则</span>
                            <strong>{parseFailure.ruleName}</strong>
                          </div>
                        </div>
                        <p>
                          如果是格式或编码问题，请重新上传受支持的文件；如果是规则无法解析，请进入规则管理新建规则，或先让 AI 分析当前文件生成推荐规则后再人工微调。
                        </p>
                      </div>
                    ) : null}

                    {aiProviderLabel || aiModelLabel ? (
                      <div className="overview-grid" style={{ marginTop: 16 }}>
                        <article className="overview-card">
                          <p>AI 建议来源</p>
                          <strong>{aiProviderLabel || "-"}</strong>
                          <span>用于区分真实大模型输出还是本地兜底规则</span>
                        </article>
                        <article className="overview-card">
                          <p>当前模型</p>
                          <strong>{aiModelLabel || "-"}</strong>
                          <span>本次规则建议所使用的模型标识</span>
                        </article>
                      </div>
                    ) : null}

                    {aiRiskNotes.length > 0 ? (
                      <div className="error-list">
                        {aiRiskNotes.map((item) => (
                          <div className="error-item" key={item}>
                            {item}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {headers.length > 0 ? (
                      <div className="mapping-grid">
                        <div className="mapping-source-note">
                          <strong>AI 推荐表头行：第 {activeHeaderRowIndex + 1} 行</strong>
                          <span>下拉项已按 AI 推荐规则展示列号、表头和样例值；带"需确认"的字段请人工复核后再保存。</span>
                        </div>
                        {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                          const aiStatus = getAiMappingStatus(aiConfidenceByField.get(field.key));
                          const currentColumn = mapping[field.key];
                          const availableTailSourceOptions = getAvailableTailSourceOptions(ruleDsl, field.key, tailSourceOptions);
                          const defaultValue = getRuleDefaultValue(ruleDsl, field.key);
                          const displayLabel = getFieldDisplayLabel(field.key, ruleDsl.fieldLabels);

                          return (
                            <label className="mapping-row" key={field.key}>
                              <span className="mapping-label">
                                <span>{displayLabel}{field.required ? "*" : ""}</span>
                                {getFieldLabelOptions(field.key).length > 0 && ruleDsl.fieldLabels?.[field.key] && (
                                  <small className="field-label-hint" title={`原始字段名：${field.label}`}>
                                    ({field.label})
                                  </small>
                                )}
                                <em className={`ai-confidence-badge ${aiStatus.tone}`}>{aiStatus.label}</em>
                              </span>
                              <select
                                value={getMappingSelectValue(ruleDsl, field.key, currentColumn)}
                                onChange={(event) => handleMappingColumnChange(field.key, event.target.value)}
                              >
                                <option value="">{aiStatus.strategy === "tail" ? "建议由尾部信息提取" : "未映射"}</option>
                                {activeColumnOptions.map((option) => (
                                  <option value={option.index} key={`${option.header}-${option.index}`}>
                                    {formatColumnOption(option)}
                                  </option>
                                ))}
                                {availableTailSourceOptions.map((option) => (
                                  <option value={option.value} key={option.value}>
                                    {getTailSourceOptionLabel(option)}
                                  </option>
                                ))}
                              </select>
                              <input
                                className="mapping-default-input"
                                value={defaultValue}
                                onChange={(event) => handleDefaultValueChange(field.key, event.target.value)}
                                placeholder="默认值：文件无此字段时补齐"
                              />
                              <small className="mapping-hint">
                                {aiStatus.detail}；下拉用于选择表格列/尾部信息，默认值会补齐空字段。
                              </small>
                            </label>
                          );
                        })}
                        <div className="mapping-action-row">
                          <div>
                            <strong>下一步</strong>
                            <span>先把必填字段映射到正确列，再试解析；结果确认无误后保存为规则。</span>
                          </div>
                          <div className="toolbar">
                            <button type="button" className="secondary-button" onClick={() => void handleTestDraftRule()} disabled={!selectedFile}>
                              试解析当前 AI 建议
                            </button>
                            <button type="button" className="primary-button" onClick={() => void handleConfirmAiSuggestionSave()} disabled={headers.length === 0}>
                              确认 AI 建议并保存为规则
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {aiConfidenceReport.length > 0 ? (
                      <div className="overview-grid" style={{ marginTop: 16 }}>
                        {aiConfidenceReport.map((item) => {
                          const aiStatus = getAiMappingStatus(item);

                          return (
                            <article className={`overview-card ${aiStatus.tone}`} key={item.field}>
                              <p>{UNIVERSAL_IMPORT_FIELD_LABELS[item.field]}</p>
                              <strong>{aiStatus.label}</strong>
                              <span>{aiStatus.detail}</span>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">预览区</p>
                        <h3>运单明细预览与在线编辑</h3>
                      </div>
                      <div className="pagination-summary">
                        <span>共 {draftRows.length} 行</span>
                        {hiddenPreviewRowCount > 0 ? <span>已渲染 {visibleDraftRows.length} 行</span> : null}
                        <span>已选 {selectedCount} 行</span>
                      </div>
                    </div>

                    {draftRows.length === 0 ? (
                      <div className="empty-state-card with-illustration">
                        <p className="section-kicker">空状态</p>
                        <h3>还没有可提交的结构化预览</h3>
                        <p>
                          按考试主流程依次完成样例上传、规则确认和试解析，系统才会在这里生成结构化运单预览。
                        </p>
                        <div className="empty-state-steps">
                          <span className="empty-state-step">1. 上传样例文件</span>
                          <span className="empty-state-step">2. 选择规则或生成 AI 建议</span>
                          <span className="empty-state-step">3. 试解析并确认字段映射</span>
                        </div>
                        <p className="empty-state-tip">规则始终由你手动选择，系统不会自动匹配。</p>
                        <div className="toolbar" style={{ marginBottom: 0 }}>
                          <button type="button" className="primary-button" onClick={() => fileInputRef.current?.click()}>
                            选择样例文件
                          </button>
                          <button type="button" className="secondary-button" onClick={() => setActiveTab("rules")}>
                            去规则管理新建规则
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="table-shell shipment-preview-shell">
                          <table className="data-table shipment-preview-table">
                            <thead>
                              <tr>
                                <th>出库单 / 外部编码</th>
                                <th>收货信息概况</th>
                                <th>SKU 行数</th>
                                <th>SKU 件数合计</th>
                                <th>来源行号</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleAggregatedPreviewShipments.map((shipment) => (
                                <tr key={shipment.key}>
                                  <td>{shipment.externalCode}</td>
                                  <td>
                                    <div>{shipment.receiverLabel}</div>
                                    {shipment.receiverGroupCount > 1 ? (
                                      <span className="cell-hint">共 {shipment.receiverGroupCount} 组收货信息</span>
                                    ) : null}
                                  </td>
                                  <td>{shipment.skuCount}</td>
                                  <td>{shipment.quantityTotal || "-"}</td>
                                  <td>{shipment.rowIndexes.join(", ")}</td>
                                </tr>
                              ))}
                              {hiddenAggregatedPreviewCount > 0 ? (
                                <tr>
                                  <td colSpan={5} className="empty-row">
                                    还有 {hiddenAggregatedPreviewCount} 个聚合出库单未展开，全部数据仍会参与校验、导出和提交。
                                  </td>
                                </tr>
                              ) : null}
                            </tbody>
                          </table>
                        </div>

                        {presetReceivers.length > 0 && draftRows.length > 0 ? (
                          <div className="toolbar preset-quick-toolbar" style={{ marginBottom: 12 }}>
                            <label className="preset-quick-label">
                              <span>快速填充收货信息：</span>
                              <select
                                value={selectedPresetId}
                                onChange={(event) => setSelectedPresetId(event.target.value)}
                              >
                                <option value="">— 选择预设 —</option>
                                {presetReceivers.map((preset) => (
                                  <option value={preset.id} key={preset.id}>
                                    {preset.label || preset.receiverStore || preset.receiverName}
                                    {preset.receiverStore ? `（${preset.receiverStore}）` : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={!selectedPresetId}
                              onClick={applyPresetToRows}
                              title={
                                selectedIds.length > 0
                                  ? `将选中预设应用到已勾选的 ${selectedIds.length} 行`
                                  : "将选中预设应用到全部行"
                              }
                            >
                              {selectedIds.length > 0
                                ? `应用到选中行（${selectedIds.length}）`
                                : "应用到全部行"}
                            </button>
                          </div>
                        ) : null}

                        <div className="table-shell import-table-shell">
                          <table className="data-table import-table">
                          <thead>
                            <tr>
                              <th className="checkbox-cell">
                                <input
                                  type="checkbox"
                                  checked={allRowsSelected}
                                  onChange={(event) => setSelectedIds(event.target.checked ? draftRows.map((row) => row.id) : [])}
                                />
                              </th>
                              <th>行号</th>
                              {UNIVERSAL_IMPORT_FIELDS.map((field) => (
                                <th key={field.key}>
                                  {getFieldDisplayLabel(field.key, ruleDsl.fieldLabels)}
                                  {field.required ? "*" : ""}
                                </th>
                              ))}
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visibleDraftRows.map((row, index) => {
                              const rowIssues = rowErrorsById.get(row.id) ?? [];
                              const duplicateNotice = sameBatchDuplicateReport.noticesByRowId.get(row.id);
                              return (
                                <tr
                                  key={row.id}
                                  className={[
                                    rowIssues.length > 0 ? "has-error" : "",
                                    duplicateNotice ? "has-duplicate-external-code" : "",
                                  ]
                                    .filter(Boolean)
                                    .join(" ")}
                                >
                                  <td className="checkbox-cell">
                                    <input
                                      type="checkbox"
                                      checked={selectedIds.includes(row.id)}
                                      onChange={() => {
                                        setSelectedIds((current) =>
                                          current.includes(row.id)
                                            ? current.filter((id) => id !== row.id)
                                            : [...current, row.id],
                                        );
                                      }}
                                    />
                                  </td>
                                  <td>{row.rowIndex || index + 1}</td>
                                  {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                                    const issue = rowIssues.find((item) => item.field === field.key);
                                    const showDuplicateNotice = field.key === "externalCode" && duplicateNotice;
                                    const displayLabel = getFieldDisplayLabel(field.key, ruleDsl.fieldLabels);
                                    return (
                                      <td key={field.key}>
                                        <input
                                          ref={(node) => registerCellRef(row.id, field.key, node)}
                                          className={[
                                            "cell-input",
                                            issue ? "error" : "",
                                            showDuplicateNotice ? "duplicate-warning" : "",
                                          ]
                                            .filter(Boolean)
                                            .join(" ")}
                                          value={row[field.key]}
                                          onChange={(event) => handleCellChange(row.id, field.key, event.target.value)}
                                          onKeyDown={(event) => handleCellKeyDown(event, row.id, field.key)}
                                          placeholder={displayLabel}
                                          title={issue?.message ?? duplicateNotice ?? displayLabel}
                                        />
                                        {issue ? <span className="cell-error">{issue.message}</span> : null}
                                        {showDuplicateNotice ? (
                                          <span className="cell-warning">同批次重复，将按同一运单聚合</span>
                                        ) : null}
                                      </td>
                                    );
                                  })}
                                  <td>
                                    <button type="button" className="text-link-button" onClick={() => deleteRows([row.id])}>
                                      删除
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                          </table>
                        </div>
                      </>
                    )}

                    {hiddenPreviewRowCount > 0 ? (
                      <div className="preview-render-toolbar">
                        <span>
                          为保证 1000+ 行数据渲染流畅，当前先展示前 {visibleDraftRows.length} 行，剩余 {hiddenPreviewRowCount} 行仍会参与校验、导出和提交。
                        </span>
                        <div className="toolbar">
                          <button type="button" className="secondary-button" onClick={showMorePreviewRows}>
                            继续加载 {Math.min(PREVIEW_RENDER_BATCH_SIZE, hiddenPreviewRowCount)} 行
                          </button>
                          <button type="button" className="tool-button" onClick={showAllPreviewRows}>
                            显示全部
                          </button>
                        </div>
                      </div>
                    ) : null}

                    {hasSameBatchDuplicateExternalCodes ? (
                      <div className="validation-summary-card warning">
                        <div className="card-heading compact">
                          <div>
                            <p className="section-kicker">重复提示</p>
                            <h3>同批次外部编码重复检测</h3>
                          </div>
                          <span className="warning-count-badge">{sameBatchDuplicateReport.summaries.length} 组重复</span>
                        </div>
                        <p className="footnote">
                          同一外部编码会聚合为同一运单，系统已高亮对应行；请确认这些重复不是误填。
                        </p>
                        <div className="validation-summary-list">
                          {sameBatchDuplicateReport.summaries.map((item) => (
                            <div className="validation-summary-item warning" key={item}>
                              {item}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {hasBlockingErrors ? (
                      <div className="validation-summary-card">
                        <div className="card-heading compact">
                          <div>
                            <p className="section-kicker">校验错误</p>
                            <h3>全部错误一次性展示</h3>
                          </div>
                          <span className="error-count-badge">{rowErrorSummary.length} 个问题</span>
                        </div>
                        <div className="validation-summary-list">
                          {rowErrorSummary.map((item) => (
                            <div className="validation-summary-item" key={item}>
                              {item}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </section>
                </section>

                <section className="import-grid bottom-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">进度</p>
                        <h3>导入与提交进度</h3>
                      </div>
                    </div>
                    <div className="progress-stack">
                      <div className="progress-block">
                        <div className="progress-head">
                          <span>文件试解析</span>
                          <strong>{parseProgress.active ? `${parseProgress.value}% · ${parseProgress.processed}/${parseProgress.total}` : "待处理"}</strong>
                        </div>
                        <div className="progress-track">
                          <span className="progress-bar" style={{ width: `${parseProgress.value}%` }} />
                        </div>
                      </div>
                      <div className="progress-block">
                        <div className="progress-head">
                          <span>提交下单</span>
                          <strong>{submitProgress.active ? `${submitProgress.value}% · ${submitProgress.processed}/${submitProgress.total}` : "待处理"}</strong>
                        </div>
                        <div className="progress-track">
                          <span className="progress-bar" style={{ width: `${submitProgress.value}%` }} />
                        </div>
                      </div>
                      {performanceSnapshot ? (
                        <div className="performance-metrics">
                          <div>
                            <span>解析耗时</span>
                            <strong>{performanceSnapshot.parseMs} ms</strong>
                          </div>
                          <div>
                            <span>预览数据</span>
                            <strong>{performanceSnapshot.totalRows} 行</strong>
                          </div>
                          <div>
                            <span>首屏渲染</span>
                            <strong>{performanceSnapshot.renderedRows} 行</strong>
                          </div>
                          <div>
                            <span>渲染策略</span>
                            <strong>{performanceSnapshot.renderMode === "batched" ? "分批渲染" : "一次渲染"}</strong>
                          </div>
                          <div>
                            <span>校验问题</span>
                            <strong>{performanceSnapshot.issueCount} 个</strong>
                          </div>
                          <div>
                            <span>考试目标</span>
                            <strong>{performanceSnapshot.parseMs <= 10000 ? "满足 10 秒内" : "需继续优化"}</strong>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则概览</p>
                        <h3>当前规则结构摘要</h3>
                      </div>
                    </div>
                    <div className="overview-grid">
                      <article className="overview-card">
                        <p>文件类型</p>
                        <strong>{ruleDsl.fileType}</strong>
                        <span>当前规则适用的原始文件类型</span>
                      </article>
                      <article className="overview-card">
                        <p>解析模式</p>
                        <strong>{ruleDsl.mode}</strong>
                        <span>Excel 走 mapping，Word/PDF 走 text</span>
                      </article>
                      <article className="overview-card">
                        <p>启用 Transform</p>
                        <strong>{ruleDsl.transforms.filter((item) => item.enabled).length}</strong>
                        <span>已启用的规则执行动作数</span>
                      </article>
                      <article className="overview-card">
                        <p>最近保存</p>
                        <strong>{lastSavedAt || "-"}</strong>
                        <span>可在规则管理页进一步保存和更新</span>
                      </article>
                    </div>
                  </section>
                </section>

                <div className="toolbar submit-toolbar submit-toolbar-sticky" style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void submitImport()}
                    disabled={submitting || draftRows.length === 0 || hasBlockingErrors || !selectedRuleId}
                    title={submitBlockedHint || (selectedIds.length > 0 ? `提交勾选的 ${selectedCount} 条数据下单` : "提交下单")}
                  >
                    {submitting ? "提交中..." : selectedIds.length > 0 ? `提交选中行下单 (${selectedCount}/${totalCount})` : "提交下单"}
                  </button>
                  {submitBlockedHint ? (
                    <span className="submit-blocked-hint">{submitBlockedHint}</span>
                  ) : null}
                </div>

                {(submitBlockingIssues.length > 0 || rowErrorSummary.length > 0) ? (
                  <div className="submit-failure-list">
                    <div className="card-heading compact">
                      <div>
                        <p className="section-kicker">提交阻断原因</p>
                        <h3>请先修正以下问题</h3>
                      </div>
                      <span className="warning-count-badge">
                        {(submitBlockingIssues.length > 0 ? submitBlockingIssues : rowErrorSummary).length} 个问题
                      </span>
                    </div>
                    {(submitBlockingIssues.length > 0 ? submitBlockingIssues : rowErrorSummary).map((item) => (
                      <div className="submit-failure-item" key={item}>
                        <strong>{item}</strong>
                      </div>
                    ))}
                  </div>
                ) : null}

                {submitSummary ? (
                  <div className="result-summary-card">
                    <div className="card-heading compact">
                      <div>
                        <p className="section-kicker">提交结果</p>
                        <h3>批量下单结果汇总</h3>
                      </div>
                    </div>
                    <div className="result-summary-grid">
                      <div>
                        <span>成功行数</span>
                        <strong>{submitSummary.successCount}</strong>
                      </div>
                      <div>
                        <span>失败行数</span>
                        <strong>{submitSummary.failCount}</strong>
                      </div>
                      <div>
                        <span>生成运单</span>
                        <strong>{submitSummary.shipmentCount}</strong>
                      </div>
                      <div>
                        <span>失败运单</span>
                        <strong>{submitSummary.failedShipmentCount}</strong>
                      </div>
                      <div>
                        <span>提交时间</span>
                        <strong>{submitSummary.submittedAt}</strong>
                      </div>
                    </div>
                    {submitSummary.failedResults.length > 0 ? (
                      <div className="submit-failure-list">
                        <div className="card-heading compact">
                          <div>
                            <p className="section-kicker">失败明细</p>
                            <h3>需人工处理的运单</h3>
                          </div>
                        </div>
                        {submitSummary.failedResults.map((item) => (
                          <div className="submit-failure-item" key={`${item.externalCode}-${item.rowIndexes.join("-")}`}>
                            <strong>{item.externalCode}</strong>
                            <span>来源行：{item.rowIndexes.join("、")}；收货信息：{item.receiverLabel || "-"}</span>
                            <p>{item.error || "入库失败，请检查该运单明细后重试。"}</p>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : activeTab === "history" ? (
              <section className="workspace-card">
                <div className="workspace-header" style={{ marginBottom: 16 }}>
                  <div>
                    <p className="workspace-breadcrumb">历史运单</p>
                    <h1>历史运单</h1>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip"><span>总运单</span><strong>{historyShipmentCount}</strong></div>
                    <div className="meta-chip"><span>当前页 SKU</span><strong>{historyItemCount}</strong></div>
                    <div className="meta-chip"><span>当前页</span><strong>{historyData.page ?? 1}</strong></div>
                    <div className="meta-chip"><span>每页</span><strong>{historyFilters.pageSize}</strong></div>
                  </div>
                </div>

                <div className="card-heading">
                  <div>
                    <p className="section-kicker">历史</p>
                    <h3>历史运单列表</h3>
                  </div>
                  <button type="button" className="secondary-button" onClick={() => void loadHistory({ ...historyFilters })}>
                    刷新
                  </button>
                </div>

                <div className="overview-grid history-overview-grid">
                  <article className="overview-card">
                    <p>历史运单总数</p>
                    <strong>{historyShipmentCount}</strong>
                    <span>当前筛选结果中共检索到的历史运单数量</span>
                  </article>
                  <article className="overview-card">
                    <p>SKU 明细量</p>
                    <strong>{historyItemCount}</strong>
                    <span>用于展示系统已成功沉淀的商品明细数据</span>
                  </article>
                  <article className="overview-card">
                    <p>最近导入</p>
                    <strong>{historyData.records?.[0] ? formatDateTime(historyData.records[0].batch.createdAt) : "-"}</strong>
                    <span>用于快速查看最近一次导入记录</span>
                  </article>
                  <article className="overview-card">
                    <p>当前查看</p>
                    <strong>{selectedHistoryRecord?.externalCode ?? "-"}</strong>
                    <span>下方可查看运单明细、来源文件和收货信息</span>
                  </article>
                </div>

                <div className="history-filter-panel">
                  <div className="history-filter-panel-header">
                    <div>
                      <p className="section-kicker">筛选区</p>
                      <h3>按外部编码、收件人和提交日期检索历史运单</h3>
                    </div>
                    <div className="history-filter-tips">
                      <span className="history-filter-tip">支持分页查看</span>
                      <span className="history-filter-tip">便于演示检索过程</span>
                    </div>
                  </div>
                  <div className="history-filters history-filters-panel">
                    <label className="search-field">
                      <span>关键字</span>
                      <input value={historyFilters.query} onChange={(event) => setHistoryFilters((current) => ({ ...current, query: event.target.value }))} placeholder="外部编码 / 收件人 / 门店 / 文件名" />
                    </label>
                    <label className="search-field">
                      <span>外部编码</span>
                      <input value={historyFilters.externalCode} onChange={(event) => setHistoryFilters((current) => ({ ...current, externalCode: event.target.value }))} placeholder="支持精确或模糊搜索" />
                    </label>
                    <label className="search-field">
                      <span>收件人姓名</span>
                      <input value={historyFilters.receiverName} onChange={(event) => setHistoryFilters((current) => ({ ...current, receiverName: event.target.value }))} placeholder="支持模糊搜索" />
                    </label>
                    <label className="search-field">
                      <span>提交日期</span>
                      <div className="date-range-inputs">
                        <input
                          type="date"
                          value={historyFilters.submittedAtStart}
                          onChange={(event) => setHistoryFilters((current) => ({ ...current, submittedAtStart: event.target.value }))}
                          aria-label="提交开始日期"
                        />
                        <span>至</span>
                        <input
                          type="date"
                          value={historyFilters.submittedAtEnd}
                          onChange={(event) => setHistoryFilters((current) => ({ ...current, submittedAtEnd: event.target.value }))}
                          aria-label="提交结束日期"
                        />
                      </div>
                    </label>
                    <div className="search-actions history-search-actions">
                      <button type="button" className="primary-button" onClick={() => void loadHistory({ ...historyFilters, page: 1 })}>查询</button>
                      <button type="button" className="secondary-button" onClick={() => {
                        setHistoryFilters(DEFAULT_HISTORY_FILTERS);
                        void loadHistory(DEFAULT_HISTORY_FILTERS);
                      }}>重置</button>
                    </div>
                  </div>
                </div>

                <div className="history-bulk-toolbar">
                  <span>已选 {selectedHistoryIds.length} 条</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleBatchDeleteHistory()}
                    disabled={historyLoading || historyDeleting || selectedHistoryIds.length === 0}
                  >
                    {historyDeleting ? "删除中..." : `批量删除（${selectedHistoryIds.length}）`}
                  </button>
                </div>

                <div className="table-shell import-history-shell">
                  <table className="data-table history-table">
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            checked={allHistoryRecordsSelected}
                            disabled={historyLoading || currentHistoryIds.length === 0}
                            onChange={(event) => toggleAllHistorySelection(event.target.checked)}
                            aria-label="全选当前页历史运单"
                          />
                        </th>
                        <th>外部编码</th>
                        <th>收货信息</th>
                        <th>SKU 数</th>
                        <th>来源文件</th>
                        <th>提交时间</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyLoading ? (
                        <tr><td colSpan={7} className="empty-row">正在加载历史数据...</td></tr>
                      ) : currentHistoryRecords.length === 0 ? (
                        <tr><td colSpan={7} className="empty-row">当前筛选条件下暂无历史运单，可调整筛选条件后重试。</td></tr>
                      ) : (
                        currentHistoryRecords.map((record) => (
                          <tr
                            key={record.id}
                            className={selectedHistoryRecord?.id === record.id ? "history-row-active" : ""}
                            onClick={() => setSelectedHistoryId(record.id)}
                          >
                            <td className="checkbox-cell" onClick={(event) => event.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedHistoryIdSet.has(record.id)}
                                onChange={(event) => toggleHistorySelection(record.id, event.target.checked)}
                                aria-label={`选择历史运单 ${record.externalCode}`}
                              />
                            </td>
                            <td>{record.externalCode}</td>
                            <td>{formatReceiverSummary(record)}</td>
                            <td>{record.items.length}</td>
                            <td>{record.batch.originalFileName || "-"}</td>
                            <td>{formatDateTime(record.batch.createdAt)}</td>
                            <td>{record.batch.status}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="history-detail-card">
                  <div className="card-heading">
                    <div>
                      <p className="section-kicker">详情区</p>
                      <h3>选中运单明细与导入证据</h3>
                    </div>
                    <span className={`history-pill${selectedHistoryRecord ? "" : " muted"}`}>
                      {selectedHistoryRecord ? `当前查看：${selectedHistoryRecord.externalCode}` : "等待选择运单"}
                    </span>
                  </div>
                  {selectedHistoryRecord ? (
                    <>
                      {(() => {
                        const receiverDetail = buildHistoryReceiverDetail(selectedHistoryRecord);
                        const receiverLookup = buildHistoryReceiverLookup(selectedHistoryRecord);

                        return (
                          <>
                      <p className="history-detail-caption">
                        当前展示该运单的收货信息、来源文件和 SKU 明细，方便核对导入结果与来源依据。
                      </p>
                      <div className="overview-grid history-detail-grid">
                        <article className="overview-card">
                          <p>运单号</p>
                          <strong>{selectedHistoryRecord.externalCode}</strong>
                          <span>用于标识该条运单的外部单据编号</span>
                        </article>
                        <article className="overview-card">
                          <p>收货信息</p>
                          <strong>{receiverDetail.title}</strong>
                          <span>{receiverDetail.detail}</span>
                        </article>
                        <article className="overview-card">
                          <p>来源文件</p>
                          <strong>{selectedHistoryRecord.batch.originalFileName || "-"}</strong>
                          <span>{formatFileTypeLabel(selectedHistoryRecord.batch.fileType)} / {selectedHistoryRecord.batch.sourceSheetName || "-"}</span>
                        </article>
                        <article className="overview-card">
                          <p>导入结果</p>
                          <strong>{selectedHistoryRecord.items.length} 个 SKU</strong>
                          <span>导入状态：{selectedHistoryRecord.batch.status}</span>
                        </article>
                      </div>
                      <div className="table-shell history-detail-shell">
                        <table className="data-table history-detail-table">
                          <thead>
                            <tr>
                              <th>源行号</th>
                              <th>收货信息</th>
                              <th>SKU 编码</th>
                              <th>SKU 名称</th>
                              <th>规格型号</th>
                              <th>数量</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedHistoryRecord.items.map((item) => (
                              <tr key={item.id}>
                                <td>{item.sourceRowIndex}</td>
                                <td>{receiverLookup.get(item.sourceRowIndex) ?? receiverDetail.title}</td>
                                <td>{item.skuCode}</td>
                                <td>{item.skuName}</td>
                                <td>{item.skuSpec || "-"}</td>
                                <td>{item.skuQuantity}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                          </>
                        );
                      })()}
                    </>
                  ) : (
                    <div className="history-empty-card with-illustration">
                      <p className="section-kicker">空状态</p>
                      <h3>请选择一条历史运单查看详情</h3>
                      <p>点击上方列表中的任意一条运单后，这里会展示收货信息、来源文件和 SKU 明细。</p>
                      <div className="empty-state-steps">
                        <span className="empty-state-step">1. 先筛选或查询</span>
                        <span className="empty-state-step">2. 再点选历史运单</span>
                        <span className="empty-state-step">3. 查看导入证据</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="pagination-bar">
                  <div className="pagination-summary">
                    <span>共 {historyData.total ?? 0} 条</span>
                    <label className="page-size-switcher">
                      <span>每页</span>
                      <select
                        value={historyFilters.pageSize}
                        onChange={(event) => {
                          const pageSize = Number.parseInt(event.target.value, 10);
                          void loadHistory({ ...historyFilters, page: 1, pageSize });
                        }}
                      >
                        {[10, 20, 50, 100].map((size) => (
                          <option value={size} key={size}>
                            {size} 条
                          </option>
                        ))}
                      </select>
                    </label>
                    <span>{historyStatus || " "}</span>
                  </div>
                  <div className="pagination-controls">
                    <button type="button" className="page-button" disabled={historyLoading || (historyData.page ?? 1) <= 1} onClick={() => void loadHistory({ ...historyFilters, page: Math.max((historyData.page ?? 1) - 1, 1) })}>上一页</button>
                    <span className="page-button active">{historyData.page ?? 1} / {historyData.totalPages ?? 1}</span>
                    <button type="button" className="page-button" disabled={historyLoading || (historyData.page ?? 1) >= (historyData.totalPages ?? 1)} onClick={() => void loadHistory({ ...historyFilters, page: (historyData.page ?? 1) + 1 })}>下一页</button>
                  </div>
                </div>
              </section>
            ) : (
              <section className="workspace-card">
                <div className="workspace-header" style={{ marginBottom: 16 }}>
                  <div>
                    <p className="workspace-breadcrumb">规则管理</p>
                    <h1>规则管理中心</h1>
                    <p>支持查看规则列表、保存当前规则、更新规则版本、应用规则、删除规则，以及结合样例文件执行试解析。</p>
                  </div>
                  <div className="workspace-header-meta">
                    <div className="meta-chip"><span>规则总数</span><strong>{ruleList.length}</strong></div>
                    <div className="meta-chip"><span>当前选中</span><strong>{selectedRuleId ? "1" : "0"}</strong></div>
                    <div className="meta-chip"><span>样例文件</span><strong>{selectedFile ? "已上传" : "未上传"}</strong></div>
                  </div>
                </div>

                <div className="import-grid">
                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则编辑</p>
                        <h3>保存和调试当前规则</h3>
                      </div>
                    </div>

                    <div className="history-filters">
                      <label className="search-field">
                        <span>规则名称</span>
                        <input value={ruleNameInput} onChange={(event) => setRuleNameInput(event.target.value)} placeholder="例如：门店矩阵配送规则" />
                      </label>
                      <label className="search-field">
                        <span>当前文件类型</span>
                        <input value={fileType} readOnly />
                      </label>
                      <label className="search-field">
                        <span>当前指纹</span>
                        <input value={fingerprint} readOnly placeholder="试解析后自动生成" />
                      </label>
                    </div>

                    <div className="toolbar rule-editor-toolbar rule-editor-toolbar-sticky" style={{ marginTop: 16 }}>
                      <button type="button" className="tool-button quiet" onClick={openNewRuleDialog}>新建规则</button>
                      <button type="button" className="secondary-button" onClick={() => void handleTestCurrentRule()} disabled={!selectedFile}>试解析当前规则</button>
                      <button type="button" className="secondary-button accent" onClick={() => void handleConfirmAiSuggestionSave()} disabled={headers.length === 0}>
                        采用 AI 建议并保存规则
                      </button>
                      <button type="button" className="primary-button" onClick={() => void handleUpdateSelectedRule()} disabled={!selectedRuleId}>保存当前编辑规则</button>
                    </div>

                    <div className="status-panel">
                      <p className={`status-text${ruleStatus ? " visible" : ""}`}>{ruleStatus || " "}</p>
                      <p className="footnote">{ruleTestSummary || "这里会显示规则保存、更新、应用和试解析结果。"}</p>
                    </div>

                    <div className="rule-editor-section">
                      <div className="card-heading compact">
                        <div>
                          <p className="section-kicker">字段映射</p>
                          <h3>人工确认字段映射</h3>
                        </div>
                        <span className="history-pill">表头第 {activeHeaderRowIndex + 1} 行</span>
                      </div>
                      {headers.length > 0 ? (
                        <div className="mapping-grid rule-mapping-grid">
                          {UNIVERSAL_IMPORT_FIELDS.map((field) => {
                            const aiStatus = getAiMappingStatus(aiConfidenceByField.get(field.key));
                            const currentColumn = mapping[field.key];
                            const availableTailSourceOptions = getAvailableTailSourceOptions(ruleDsl, field.key, tailSourceOptions);
                            const defaultValue = getRuleDefaultValue(ruleDsl, field.key);
                            const labelOptions = getFieldLabelOptions(field.key);
                            const currentLabel = getFieldDisplayLabel(field.key, ruleDsl.fieldLabels);

                            return (
                              <label className="mapping-row" key={field.key}>
                                <span className="mapping-label">
                                  <span>{currentLabel}{field.required ? "*" : ""}</span>
                                  {labelOptions.length > 0 && (
                                    <select
                                      className="field-label-select"
                                      value={ruleDsl.fieldLabels?.[field.key] ?? ""}
                                      onChange={(event) => handleFieldLabelChange(field.key, event.target.value)}
                                      title="选择字段标签"
                                    >
                                      <option value="">默认：{field.label}</option>
                                      {labelOptions.map((option) => (
                                        <option value={option} key={option}>
                                          {option}
                                        </option>
                                      ))}
                                    </select>
                                  )}
                                  <em className={`ai-confidence-badge ${aiStatus.tone}`}>{aiStatus.label}</em>
                                </span>
                                <select
                                  value={getMappingSelectValue(ruleDsl, field.key, currentColumn)}
                                  onChange={(event) => handleMappingColumnChange(field.key, event.target.value)}
                                >
                                  <option value="">{aiStatus.strategy === "tail" ? "建议由尾部信息提取" : "未映射"}</option>
                                  {activeColumnOptions.map((option) => (
                                    <option value={option.index} key={`${option.header}-${option.index}`}>
                                      {formatColumnOption(option)}
                                    </option>
                                  ))}
                                  {availableTailSourceOptions.map((option) => (
                                    <option value={option.value} key={option.value}>
                                      {getTailSourceOptionLabel(option)}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  className="mapping-default-input"
                                  value={defaultValue}
                                  onChange={(event) => handleDefaultValueChange(field.key, event.target.value)}
                                  placeholder="默认值：文件无此字段时补齐"
                                />
                                <small className="mapping-hint">
                                  {aiStatus.detail}；下拉用于选择表格列/尾部信息，默认值会补齐空字段。
                                </small>
                              </label>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="empty-row rule-editor-empty with-illustration">可直接点击"新建规则"创建规则；如需配置字段映射，请上传样例文件生成 AI 建议，或应用一条带样例表头的已保存规则。</div>
                      )}
                    </div>

                    <div className="rule-editor-section">
                      <div className="card-heading compact">
                        <div>
                          <p className="section-kicker">预设收货信息</p>
                          <h3>预设收货方</h3>
                        </div>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => openPresetEditor("add")}
                        >
                          添加收货信息
                        </button>
                      </div>
                      {presetReceivers.length === 0 ? (
                        <div className="empty-row rule-editor-empty">
                          暂未配置预设收货信息，点击"添加收货信息"可配置导入时可快速选取的门店/收件人数据。
                        </div>
                      ) : (
                        <div className="preset-receiver-list">
                          {presetReceivers.map((preset, index) => (
                            <div className="preset-receiver-card" key={preset.id ?? index}>
                              <div className="preset-card-info">
                                <strong className="preset-card-label">
                                  {preset.label || preset.receiverStore || preset.receiverName || "未命名"}
                                </strong>
                                <span className="preset-card-detail">
                                  <span title="收货门店">{preset.receiverStore || "—"}</span>
                                  <span className="preset-sep">|</span>
                                  <span title="收件人">{preset.receiverName || "—"}</span>
                                  <span className="preset-sep">|</span>
                                  <span title="电话">{preset.receiverPhone || "—"}</span>
                                  <span className="preset-sep">|</span>
                                  <span title="地址">{preset.receiverAddress || "—"}</span>
                                </span>
                              </div>
                              <div className="preset-card-actions">
                                <button
                                  type="button"
                                  className="text-link-button"
                                  onClick={() => openPresetEditor("edit", index)}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className="text-link-button"
                                  onClick={() => deletePresetReceiver(index)}
                                >
                                  删除
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="rule-editor-section">
                      <div className="card-heading compact">
                        <div>
                          <p className="section-kicker">规则配置</p>
                          <h3>规则动作与 JSON 配置</h3>
                        </div>
                      </div>
                      <div className="transform-editor-stack">
                        {ruleDsl.transforms.map((transform, index) => (
                          <details
                            className={`transform-editor-card${transform.enabled ? " is-enabled" : " is-disabled"}`}
                            key={transform.type}
                            open={transform.enabled && index === 0}
                          >
                            <summary className="transform-editor-summary">
                              <div className="transform-editor-summary-main">
                                <div className="transform-editor-title-block">
                                  <span className="transform-editor-eyebrow">{transform.type}</span>
                                  <strong>{getTransformTypeLabel(transform.type)}</strong>
                                </div>
                                <p>{getTransformConfigSummary(transform.config)}</p>
                              </div>
                              <div className="transform-editor-summary-side">
                                <span className={`transform-status-badge ${transform.enabled ? "enabled" : "disabled"}`}>
                                  {transform.enabled ? "启用" : "关闭"}
                                </span>
                                <span className="transform-expand-hint">展开配置</span>
                              </div>
                            </summary>
                            <div className="transform-editor-body">
                          <div className="transform-editor-header">
                            <div>
                              <p>{transform.type}</p>
                              <strong>{transform.enabled ? "启用" : "关闭"}</strong>
                            </div>
                            <button type="button" className="text-link-button" onClick={() => handleTransformConfigCommit(transform.type)}>
                              应用 JSON
                            </button>
                          </div>
                          <label className="inline-checkbox">
                            <input
                              type="checkbox"
                              checked={transform.enabled}
                              onChange={(event) => {
                                const enabled = event.target.checked;
                                setRuleDsl((current) => ({
                                  ...current,
                                  transforms: current.transforms.map((item) =>
                                    item.type === transform.type ? { ...item, enabled } : item,
                                  ),
                                }));
                              }}
                            />
                            <span>参与试解析</span>
                          </label>
                          <label className="search-field">
                            <span>配置 JSON</span>
                            <textarea
                              className="json-editor"
                              value={transformConfigDrafts[transform.type] ?? formatTransformConfig(transform.config)}
                              onChange={(event) => handleTransformConfigDraftChange(transform.type, event.target.value)}
                              onBlur={() => handleTransformConfigCommit(transform.type)}
                              rows={8}
                              spellCheck={false}
                            />
                          </label>
                            </div>
                          </details>
                        ))}
                      </div>
                    </div>
                  </section>

                  <section className="workspace-card">
                    <div className="card-heading">
                      <div>
                        <p className="section-kicker">规则列表</p>
                        <h3>已保存的导入规则</h3>
                      </div>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => void handleBatchDeleteRules()}
                        disabled={ruleLoading || ruleDeleting || selectedRuleIds.length === 0}
                      >
                        {ruleDeleting ? "删除中..." : `批量删除（${selectedRuleIds.length}）`}
                      </button>
                      <button type="button" className="secondary-button" onClick={() => void loadRules()} disabled={ruleLoading}>
                        {ruleLoading ? "加载中..." : "刷新规则"}
                      </button>
                    </div>

                    <div className="table-shell import-history-shell">
                      <table className="data-table history-table">
                        <thead>
                          <tr>
                            <th className="checkbox-cell">
                              <input
                                type="checkbox"
                                checked={allRulesSelected}
                                disabled={ruleLoading || ruleList.length === 0}
                                onChange={(event) => toggleAllRuleSelection(event.target.checked)}
                                aria-label="全选规则"
                              />
                            </th>
                            <th>规则名称</th>
                            <th>文件类型</th>
                            <th>版本</th>
                            <th>批次引用</th>
                            <th>更新时间</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ruleLoading ? (
                            <tr><td colSpan={7} className="empty-row">正在加载规则列表...</td></tr>
                          ) : ruleList.length === 0 ? (
                            <tr><td colSpan={7} className="empty-row">暂无已保存规则，可点击上方"新建规则"开始配置。</td></tr>
                          ) : (
                            ruleList.map((rule) => (
                              <tr key={rule.id} className={selectedRuleId === rule.id ? "rule-row-active" : ""}>
                                <td className="checkbox-cell" onClick={(event) => event.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={selectedRuleIdSet.has(rule.id)}
                                    onChange={(event) => toggleRuleSelection(rule.id, event.target.checked)}
                                    aria-label={`选择规则 ${rule.ruleName}`}
                                  />
                                </td>
                                <td>{rule.ruleName}</td>
                                <td>{rule.fileType}</td>
                                <td>v{rule.version}</td>
                                <td>{rule._count?.batches ?? 0}</td>
                                <td>{new Date(rule.updatedAt).toLocaleString("zh-CN", { hour12: false })}</td>
                                <td>
                                  <div className="toolbar table-action-toolbar">
                                    <button type="button" className="text-link-button" onClick={() => handleApplyRule(rule)}>应用</button>
                                    <button type="button" className="text-link-button" onClick={() => void handleCopyRule(rule)}>复制</button>
                                    <button type="button" className="text-link-button" onClick={() => {
                                      handleEditRule(rule);
                                    }}>编辑</button>
                                    <button type="button" className="text-link-button" onClick={() => void handleDeleteRule(rule.id)}>删除</button>
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </div>
              </section>
            )}
          </div>
        </section>
      </div>

      {deleteConfirmTarget ? (
        <div className="confirm-backdrop" role="presentation">
          <div className="delete-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title">
            <div className="delete-confirm-header">
              <h2 id="delete-confirm-title">提示</h2>
              <button
                type="button"
                className="delete-confirm-close"
                onClick={closeDeleteConfirm}
                aria-label="关闭"
                disabled={historyDeleting || ruleDeleting}
              >
                ×
              </button>
            </div>
            <div className="delete-confirm-body">
              <span className="delete-confirm-icon" aria-hidden="true">!</span>
              <p>删除当前数据将无法恢复，您确定删除当前数据?</p>
            </div>
            <div className="delete-confirm-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={closeDeleteConfirm}
                disabled={historyDeleting || ruleDeleting}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleConfirmDelete()}
                disabled={historyDeleting || ruleDeleting}
              >
                {historyDeleting || ruleDeleting ? "删除中..." : "确认"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {presetEditorOpen ? (
        <div className="confirm-backdrop" role="presentation" onClick={closePresetEditor}>
          <div
            className="preset-receiver-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="preset-editor-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="delete-confirm-header">
              <h2 id="preset-editor-title">
                {presetEditorMode === "edit" ? "编辑预设收货信息" : "添加预设收货信息"}
              </h2>
              <button
                type="button"
                className="delete-confirm-close"
                onClick={closePresetEditor}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="preset-receiver-form">
              <label className="preset-form-row">
                <span>标签名</span>
                <input
                  value={presetEditorData.label}
                  onChange={(event) =>
                    setPresetEditorData((current) => ({ ...current, label: event.target.value }))
                  }
                  placeholder="用于区分多个预设，如「总仓-西区」"
                />
              </label>
              <label className="preset-form-row">
                <span>收货门店 *</span>
                <input
                  value={presetEditorData.receiverStore}
                  onChange={(event) =>
                    setPresetEditorData((current) => ({ ...current, receiverStore: event.target.value }))
                  }
                  placeholder="如：西区万达店"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人姓名 *</span>
                <input
                  value={presetEditorData.receiverName}
                  onChange={(event) =>
                    setPresetEditorData((current) => ({ ...current, receiverName: event.target.value }))
                  }
                  placeholder="如：张三"
                />
              </label>
              <label className="preset-form-row">
                <span>联系方式</span>
                <input
                  value={presetEditorData.receiverPhone}
                  onChange={(event) =>
                    setPresetEditorData((current) => ({ ...current, receiverPhone: event.target.value }))
                  }
                  placeholder="如：13800138000"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人地址</span>
                <input
                  value={presetEditorData.receiverAddress}
                  onChange={(event) =>
                    setPresetEditorData((current) => ({ ...current, receiverAddress: event.target.value }))
                  }
                  placeholder="如：XX市XX区XX路100号"
                />
              </label>
            </div>
            <div className="delete-confirm-actions">
              <button type="button" className="secondary-button" onClick={closePresetEditor}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={savePresetReceiver}>
                {presetEditorMode === "edit" ? "保存修改" : "添加"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {newRuleDialogOpen ? (
        <div className="confirm-backdrop" role="presentation" onClick={closeNewRuleDialog}>
          <div
            className="preset-receiver-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-rule-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="delete-confirm-header">
              <h2 id="new-rule-dialog-title">新建规则</h2>
              <button
                type="button"
                className="delete-confirm-close"
                onClick={closeNewRuleDialog}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <p className="form-desc" style={{ margin: "0 0 14px", color: "var(--muted)", fontSize: "0.88rem" }}>
              填写收货信息，保存后导入时可快速填充到数据行。均可选填。
            </p>
            <div className="preset-receiver-form">
              <label className="preset-form-row">
                <span>收货门店</span>
                <input
                  value={newRuleForm.receiverStore}
                  onChange={(event) =>
                    setNewRuleForm((current) => ({ ...current, receiverStore: event.target.value }))
                  }
                  placeholder="如：西区万达店"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人姓名</span>
                <input
                  value={newRuleForm.receiverName}
                  onChange={(event) =>
                    setNewRuleForm((current) => ({ ...current, receiverName: event.target.value }))
                  }
                  placeholder="如：张三"
                />
              </label>
              <label className="preset-form-row">
                <span>联系方式</span>
                <input
                  value={newRuleForm.receiverPhone}
                  onChange={(event) =>
                    setNewRuleForm((current) => ({ ...current, receiverPhone: event.target.value }))
                  }
                  placeholder="如：13800138000"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人地址</span>
                <input
                  value={newRuleForm.receiverAddress}
                  onChange={(event) =>
                    setNewRuleForm((current) => ({ ...current, receiverAddress: event.target.value }))
                  }
                  placeholder="如：XX市XX区XX路100号"
                />
              </label>
            </div>
            <div className="delete-confirm-actions">
              <button type="button" className="secondary-button" onClick={closeNewRuleDialog}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={() => void confirmNewRule()}>
                保存规则
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {editRuleDialogOpen ? (
        <div className="confirm-backdrop" role="presentation" onClick={closeEditRuleDialog}>
          <div
            className="preset-receiver-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-rule-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="delete-confirm-header">
              <h2 id="edit-rule-dialog-title">编辑规则</h2>
              <button
                type="button"
                className="delete-confirm-close"
                onClick={closeEditRuleDialog}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <p className="form-desc" style={{ margin: "0 0 14px", color: "var(--muted)", fontSize: "0.88rem" }}>
              修改规则名称与收货信息，保存后生效。
            </p>
            <div className="preset-receiver-form">
              <label className="preset-form-row">
                <span>规则名称</span>
                <input
                  value={editRuleForm.ruleName}
                  onChange={(event) =>
                    setEditRuleForm((current) => ({ ...current, ruleName: event.target.value }))
                  }
                  placeholder="如：西区配送单规则"
                />
              </label>
              <label className="preset-form-row">
                <span>收货门店</span>
                <input
                  value={editRuleForm.receiverStore}
                  onChange={(event) =>
                    setEditRuleForm((current) => ({ ...current, receiverStore: event.target.value }))
                  }
                  placeholder="如：西区万达店"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人姓名</span>
                <input
                  value={editRuleForm.receiverName}
                  onChange={(event) =>
                    setEditRuleForm((current) => ({ ...current, receiverName: event.target.value }))
                  }
                  placeholder="如：张三"
                />
              </label>
              <label className="preset-form-row">
                <span>联系方式</span>
                <input
                  value={editRuleForm.receiverPhone}
                  onChange={(event) =>
                    setEditRuleForm((current) => ({ ...current, receiverPhone: event.target.value }))
                  }
                  placeholder="如：13800138000"
                />
              </label>
              <label className="preset-form-row">
                <span>收件人地址</span>
                <input
                  value={editRuleForm.receiverAddress}
                  onChange={(event) =>
                    setEditRuleForm((current) => ({ ...current, receiverAddress: event.target.value }))
                  }
                  placeholder="如：XX市XX区XX路100号"
                />
              </label>
            </div>
            <div className="delete-confirm-actions">
              <button type="button" className="secondary-button" onClick={closeEditRuleDialog}>
                取消
              </button>
              <button type="button" className="primary-button" onClick={() => void confirmEditRule()}>
                保存修改
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="toast-stack" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast-item ${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  );
}
