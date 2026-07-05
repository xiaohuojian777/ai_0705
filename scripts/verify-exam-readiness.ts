import fs from "node:fs/promises";
import path from "node:path";
import {
  createDefaultRuleDsl,
  executeUniversalImportRule,
  parseImportDocument,
  type ParsedDocument,
  type SupportedImportFileType,
  type UniversalImportRuleDsl,
} from "@/lib/universal-import-engine";
import {
  inferMappingFromHeaders,
  UNIVERSAL_IMPORT_FIELDS,
  type UniversalImportField,
  type UniversalImportMapping,
} from "@/lib/universal-import";

const DEFAULT_DEMO_DIR = "D:\\codex\\AITest\\demos";
const FALLBACK_ASSET_DIR = path.join(process.cwd(), "docs", "exam-assets");
const ALLOW_FALLBACK_ASSETS = process.env.ALLOW_EXAM_ASSET_FALLBACK === "1";

function detectFileType(fileName: string): SupportedImportFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".pdf") {
    return "pdf";
  }
  if (ext === ".doc" || ext === ".docx") {
    return "word";
  }
  return "excel";
}

function normalize(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function isPositiveNumber(value: unknown) {
  return /^\d+(?:\.\d+)?$/.test(String(value ?? "").trim()) && Number(value) > 0;
}

function isMetricLikeMatrixHeader(value: unknown) {
  return /^(?:\d+(?:\.\d+)?)$/.test(String(value ?? "").trim()) ||
    /(合计|总计|库存|结余|可用|待移入|分配|冻结|下单后|在库|数量)/.test(String(value ?? ""));
}

function scoreHeaderRow(row: string[]) {
  const normalizedCells = row.map(normalize).filter(Boolean);
  const aliasScore = UNIVERSAL_IMPORT_FIELDS.reduce((score, field) => {
    const aliases = field.aliases.map(normalize).filter(Boolean);
    const matched = normalizedCells.some((cell) =>
      aliases.some((alias) => cell === alias || cell.includes(alias) || alias.includes(cell)),
    );
    return score + (matched ? 8 : 0);
  }, 0);

  return normalizedCells.length + aliasScore;
}

function inferHeaderRowIndex(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  return rows
    .slice(0, 16)
    .map((row, index) => ({ index, score: scoreHeaderRow(row) }))
    .sort((left, right) => right.score - left.score)[0]?.index ?? 0;
}

function inferMappingFromDocument(document: ParsedDocument) {
  const headerRowIndex = inferHeaderRowIndex(document);
  const header = document.sections[0]?.rows[headerRowIndex] ?? document.headers;
  return {
    headerRowIndex,
    mapping: inferMappingFromHeaders(header),
  };
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

function maxMappedColumn(mapping: Partial<Record<UniversalImportField, number | null>>) {
  return Math.max(
    -1,
    ...Object.values(mapping).filter((value): value is number => typeof value === "number"),
  );
}

function findMatrixStartColumn(header: string[], mapping: UniversalImportMapping) {
  const fixedEnd = maxMappedColumn({
    skuCode: mapping.skuCode,
    skuName: mapping.skuName,
    skuSpec: mapping.skuSpec,
    externalCode: mapping.externalCode,
  });
  const firstBusinessDimension = header.findIndex((cell, index) =>
    index > fixedEnd && Boolean(normalize(cell)) && !isMetricLikeMatrixHeader(cell),
  );

  return firstBusinessDimension >= 0 ? firstBusinessDimension : Math.max(fixedEnd + 1, 0);
}

function detectMatrixRule(document: ParsedDocument, mapping: UniversalImportMapping, headerRowIndex: number) {
  if (typeof mapping.skuQuantity === "number") {
    return null;
  }

  const rows = document.sections[0]?.rows ?? [];
  const header = rows[headerRowIndex] ?? [];
  const dataRows = rows.slice(headerRowIndex + 1, headerRowIndex + 8);
  const matrixStartColumn = findMatrixStartColumn(header, mapping);
  const candidateHeaders = header
    .slice(matrixStartColumn)
    .filter((cell) => normalize(cell) && !isMetricLikeMatrixHeader(cell));
  const positiveCells = dataRows.reduce(
    (count, row) =>
      count +
      row
        .slice(matrixStartColumn)
        .filter((cell, offset) => !isMetricLikeMatrixHeader(header[matrixStartColumn + offset]) && isPositiveNumber(cell))
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
    matrixEndColumn: header.length - 1,
    excludeHeaderRegex: "合计|总计|库存|结余|可用|待移入|分配|冻结|下单后|在库|数量",
    externalCodeTemplate: "MATRIX-{receiverStore}",
  };
}

function detectSplitMultilineCellRule(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const headerRowIndex = inferHeaderRowIndex(document);
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

function detectCardRule(document: ParsedDocument) {
  const rows = document.sections[0]?.rows ?? [];
  const startIndex = rows.findIndex((row) => /调拨记录|▶|card/i.test(row.join(" ")));
  if (startIndex < 0) {
    return null;
  }

  const itemHeaderIndex = rows.findIndex((row, index) =>
    index > startIndex && scoreHeaderRow(row) >= 12 && row.join(" ").match(/编码|名称|数量|SKU/i),
  );
  const itemHeader = itemHeaderIndex >= 0 ? rows[itemHeaderIndex] : [];
  const itemColumns = inferMappingFromHeaders(itemHeader);

  return {
    startRegex: "调拨记录|▶|card",
    itemHeaderRegex: "编码|名称|数量|SKU",
    fieldRegex: {
      receiverStore: "门店[:：\\s]+([^|\\n\\r]+)",
      receiverName: "收货(?:人|员)?[:：\\s]+([^|\\n\\r]+)",
      receiverPhone: "(?:电话|手机)[:：\\s]+(1\\d{10}|(?:0\\d{2,3}-?)?\\d{7,8})",
      receiverAddress: "地址[:：\\s]+([^|\\n\\r]+)",
    },
    keyValueLabels: {
      receiverStore: ["调入门店", "收货门店", "门店"],
      receiverName: ["收货人", "联系人"],
      receiverPhone: ["电话", "联系电话", "手机"],
      receiverAddress: ["收货地址", "地址"],
    },
    itemColumns,
    excludeRowRegex: "合计|小计|备注",
  };
}

const KEY_VALUE_FIELD_ALIASES: Record<UniversalImportField, string[]> = {
  externalCode: ["外部编码", "订单号", "配送单号", "配送汇总单号", "单据编号", "单据号", "单号"],
  receiverStore: ["收货门店", "门店", "门店名称", "收货机构", "收货单位"],
  receiverName: ["收货人姓名", "收件人姓名", "收货人", "收件人", "联系人"],
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

function isLikelyKeyValueLabel(value: unknown) {
  const normalized = normalize(normalizeKeyValueLabel(value)).replace(/[*＊]/g, "");
  if (!normalized) {
    return false;
  }

  const extraLabels = ["备用联系人", "备用联系电话", "创建日期", "创建人", "审核人", "制单人", "签字"];
  return [...UNIVERSAL_IMPORT_FIELDS.flatMap((field) => field.aliases), ...extraLabels].some(
    (alias) => normalize(alias) === normalized,
  );
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

  return row
    .slice(cellIndex + 1, Math.min(row.length, cellIndex + 5))
    .some((cell) => Boolean(String(cell ?? "").trim()) && !isLikelyKeyValueLabel(cell));
}

function isDenseTableHeaderRow(row: string[]) {
  const populated = row.map((cell) => String(cell ?? "").trim()).filter(Boolean);
  if (populated.length < 8) {
    return false;
  }

  const labelLikeCount = populated.filter((cell) => {
    const normalized = normalize(cell);
    return (
      isLikelyKeyValueLabel(cell) ||
      /(?:序号|行号|分类|品牌|单位|仓库|日期|备注|状态|批次|规格|型号|金额|单价|成本|体积|重量|数量|电话|地址|联系人|机构|单号)/.test(
        normalized,
      )
    );
  }).length;

  return labelLikeCount / populated.length >= 0.45;
}

function inferKeyValueExtractionConfig(document: ParsedDocument) {
  const labels: Partial<Record<UniversalImportField, string[]>> = {};
  const matchedRowIndexes = new Set<number>();

  document.sections.forEach((section) => {
    section.rows.forEach((row, rowIndex) => {
      if (isDenseTableHeaderRow(row)) {
        return;
      }

      row.forEach((cell, cellIndex) => {
        const inlineKeyValue = parseInlineKeyValueCell(cell);
        const normalizedCell = normalize(inlineKeyValue?.label ?? normalizeKeyValueLabel(cell));
        if (!normalizedCell || !hasNearbyValue(row, cellIndex)) {
          return;
        }

        (Object.keys(KEY_VALUE_FIELD_ALIASES) as UniversalImportField[]).forEach((field) => {
          const aliases = KEY_VALUE_FIELD_ALIASES[field];
          if (aliases.length === 0) {
            return;
          }

          const matched = aliases.some((alias) => normalize(alias) === normalizedCell);
          if (!matched) {
            return;
          }

          const exactLabel = inlineKeyValue?.label ?? normalizeKeyValueLabel(cell);
          if (!exactLabel) {
            return;
          }

          labels[field] = Array.from(new Set([...(labels[field] ?? []), exactLabel]));
          matchedRowIndexes.add(rowIndex);
        });
      });
    });
  });

  const matchedFields = (Object.keys(labels) as UniversalImportField[]).filter((field) => (labels[field]?.length ?? 0) > 0);
  if (matchedFields.length === 0) {
    return null;
  }

  return {
    matchedFields,
    matchedRowIndexes: Array.from(matchedRowIndexes.values()),
    config: {
      source: "section_text",
      keyValueLabels: labels,
    },
  };
}

function buildHeuristicRule(document: ParsedDocument, fileType: SupportedImportFileType) {
  const { headerRowIndex, mapping } = inferMappingFromDocument(document);
  let rule = createDefaultRuleDsl(mapping, fileType);

  rule = updateTransform(rule, "header_mapping", {
    enabled: fileType === "excel",
    config: {
      headerRowIndex,
      dataStartRowIndex: headerRowIndex + 1,
      fieldColumns: mapping,
      requiredRowFields: ["skuCode", "skuName", "skuQuantity"],
      skipRowRegex: "合计|总计|小计",
      externalCodeTemplate: typeof mapping.externalCode === "number" ? "" : "SHEET-{sectionTitle}",
    },
  });

  if (document.sections.length > 1) {
    rule = updateTransform(rule, "multisheet_merge", {
      enabled: true,
      config: { mergeAllSheets: true },
    });
  }

  const keyValueConfig = inferKeyValueExtractionConfig(document);
  if (keyValueConfig) {
    rule = updateTransform(rule, "tail_text_extract", {
      enabled: true,
      config: keyValueConfig.config,
    });
  }

  const cardRule = detectCardRule(document);
  if (cardRule) {
    rule = updateTransform(rule, "card_split", {
      enabled: true,
      config: {
        ...cardRule,
        externalCodeTemplate: "CARD-{cardIndex}",
      },
    });
    rule = updateTransform(rule, "matrix_pivot", {
      enabled: false,
      config: {},
    });
    rule = updateTransform(rule, "header_mapping", {
      config: { emitWithCard: false },
    });
  }

  const splitRule = detectSplitMultilineCellRule(document);
  if (splitRule) {
    rule = updateTransform(rule, "split_multiline_cell", {
      enabled: true,
      config: splitRule,
    });
    rule = updateTransform(rule, "header_mapping", {
      config: { emitWithSplitMultilineCell: false },
    });
  }

  const matrixRule = cardRule ? null : detectMatrixRule(document, mapping, headerRowIndex);
  if (matrixRule) {
    rule = updateTransform(rule, "matrix_pivot", {
      enabled: true,
      config: matrixRule,
    });
    rule = updateTransform(rule, "header_mapping", {
      config: { emitWithMatrix: false },
    });
  }

  if (fileType !== "excel") {
    rule = updateTransform(rule, "text_record_split", {
      enabled: true,
      config: {
        recordSeparatorRegex: "━{3,}|-{5,}|配送签收单|配送确认单",
        fieldRegex: {
          externalCode: "(?:单号|外部编码|配送单号)[:：\\s]+([^|\\n\\r]+)",
          receiverName: "(?:收货人|收件人)[:：\\s]+([^|\\n\\r]+)",
          receiverPhone: "(?:电话|手机)[:：\\s]+(1\\d{10}|(?:0\\d{2,3}-?)?\\d{7,8})",
          receiverAddress: "(?:地址|收货地址)[:：\\s]+([^|\\n\\r]+)",
        },
        item: {
          regex: "(?:\\d+[.、]\\s*)?([A-Za-z0-9_-]{2,})\\s*[|\\s]+([^|\\n\\r]+?)\\s*[|\\s]+([^|\\n\\r]*?)\\s*[|\\s]+(\\d+(?:\\.\\d+)?)",
          skuCodeGroup: 1,
          skuNameGroup: 2,
          skuSpecGroup: 3,
          skuQuantityGroup: 4,
        },
      },
    });
  }

  rule = updateTransform(rule, "group_by_external_code", {
    enabled: true,
    config: {
      inheritedFields: ["receiverStore", "receiverName", "receiverPhone", "receiverAddress", "note"],
      inheritBlankKey: true,
    },
  });

  return rule;
}

async function listInputFiles() {
  const requestedDir = process.argv[2]?.trim() || DEFAULT_DEMO_DIR;
  let demoDir = requestedDir;

  try {
    await fs.access(demoDir);
  } catch {
    if (!ALLOW_FALLBACK_ASSETS) {
      throw new Error(
        `Demo directory not found: ${requestedDir}. Provide the real exam demos directory or set ALLOW_EXAM_ASSET_FALLBACK=1 to run against docs/exam-assets.`,
      );
    }

    demoDir = FALLBACK_ASSET_DIR;
  }

  const names = await fs.readdir(demoDir);
  const files = names
    .filter((name) => /\.(xlsx|xls|docx|doc|pdf)$/i.test(name))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .map((name) => path.join(demoDir, name));

  if (files.length === 0) {
    throw new Error(`No supported demo files found in ${demoDir}.`);
  }

  return {
    demoDir,
    usedFallbackAssets: demoDir === FALLBACK_ASSET_DIR,
    files,
  };
}

async function verifyFile(filePath: string) {
  const fileName = path.basename(filePath);
  const fileType = detectFileType(fileName);
  const fileBuffer = await fs.readFile(filePath);
  const startedAt = performance.now();
  const document = await parseImportDocument({
    fileBuffer,
    fileType,
    originalFileName: fileName,
  });
  const rule = buildHeuristicRule(document, fileType);
  const result = await executeUniversalImportRule({
    fileBuffer,
    fileType,
    originalFileName: fileName,
    rule,
  });

  return {
    fileName,
    fileType,
    sectionCount: document.sections.length,
    rawRowCount: document.rawRows.length,
    rowCount: result.rowCount,
    issueCount: result.issueCount,
    issues: result.issues.slice(0, 10),
    summary: result.summary,
    enabledTransforms: rule.transforms.filter((transform) => transform.enabled).map((transform) => transform.type),
    elapsedMs: Math.round(performance.now() - startedAt),
  };
}

async function main() {
  const { demoDir, usedFallbackAssets, files } = await listInputFiles();
  const results = [];

  for (const file of files) {
    results.push(await verifyFile(file));
  }

  const failed = results.filter((result) => result.rowCount === 0 || result.issueCount > 0);
  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        demoDir,
        usedFallbackAssets,
        fileCount: results.length,
        passCount: results.length - failed.length,
        failedFiles: failed.map((item) => item.fileName),
        results,
      },
      null,
      2,
    ),
  );

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

void main();
