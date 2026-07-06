export const UNIVERSAL_IMPORT_FIELDS = [
  {
    key: "externalCode",
    label: "外部编码",
    required: false,
    aliases: ["外部编码", "订单号", "配送单号", "配送汇总单号", "单据编号", "单号", "externalcode", "code"],
  },
  {
    key: "receiverStore",
    label: "收货门店",
    required: false,
    aliases: ["收货门店", "门店", "门店名称", "收货机构", "仓库名称", "调入门店", "store", "shop", "仓库"],
    labelOptions: ["收货门店", "收货机构", "仓库名称", "调入门店"],
  },
  {
    key: "receiverName",
    label: "收件人姓名",
    required: false,
    aliases: ["收件人姓名", "收货人姓名", "收件人", "收货人", "receiver", "recipient"],
    labelOptions: ["收件人姓名", "收件人"],
  },
  {
    key: "receiverPhone",
    label: "收件人电话",
    required: false,
    aliases: ["收件人电话", "收货人电话", "收件人手机号", "收货人手机号", "联系电话", "手机号", "手机", "电话", "receiverphone", "recipientphone"],
    labelOptions: ["收件人电话", "收件人手机号", "联系电话"],
  },
  {
    key: "receiverAddress",
    label: "收件人地址",
    required: false,
    aliases: ["收件人地址", "收货人地址", "收货地址", "地址", "receiveraddress", "recipientaddress"],
    labelOptions: ["收件人地址", "收货地址"],
  },
  {
    key: "skuCode",
    label: "SKU物品编码",
    required: true,
    aliases: ["SKU物品编码", "SKU编码", "商品编码", "物品编码", "sku", "skucode"],
  },
  {
    key: "skuName",
    label: "SKU物品名称",
    required: true,
    aliases: ["SKU物品名称", "SKU名称", "商品名称", "物品名称", "品名", "skuname"],
  },
  {
    key: "skuQuantity",
    label: "SKU发货数量",
    required: true,
    aliases: ["SKU发货数量", "发货数量", "出库数量", "数量", "件数", "qty", "quantity"],
  },
  {
    key: "skuSpec",
    label: "SKU规格型号",
    required: false,
    aliases: ["SKU规格型号", "规格型号", "规格", "型号", "spec", "skuspec"],
  },
  {
    key: "note",
    label: "备注",
    required: false,
    aliases: ["备注", "说明", "附加说明", "note", "remark"],
  },
] as const;

/** 返回指定字段的预设标签选项，若未定义则返回空数组 */
export function getFieldLabelOptions(fieldKey: UniversalImportField): string[] {
  const field = UNIVERSAL_IMPORT_FIELDS.find((f) => f.key === fieldKey);
  return (field as { labelOptions?: readonly string[] } | undefined)?.labelOptions?.slice() ?? [];
}

/** 根据 ruleDsl 中存储的 fieldLabels 获取字段在 UI 中应展示的自定义标签 */
export function getFieldDisplayLabel(
  fieldKey: UniversalImportField,
  fieldLabels?: Partial<Record<UniversalImportField, string>> | null,
): string {
  const override = fieldLabels?.[fieldKey]?.trim();
  if (override) return override;
  const field = UNIVERSAL_IMPORT_FIELDS.find((f) => f.key === fieldKey);
  return field?.label ?? fieldKey;
}

export type UniversalImportField = (typeof UNIVERSAL_IMPORT_FIELDS)[number]["key"];

export type UniversalImportRow = Record<UniversalImportField, string> & {
  rowIndex: number;
};

export type UniversalImportIssue = {
  rowIndex: number;
  field: UniversalImportField;
  message: string;
};

export type UniversalImportMapping = Record<UniversalImportField, number | null>;

export type ExistingExternalCodeEntry = {
  externalCode: string;
  rowIndex?: number;
  batchName?: string;
  batchCreatedAt?: string;
};

export const UNIVERSAL_IMPORT_FIELD_LABELS = Object.fromEntries(
  UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, field.label]),
) as Record<UniversalImportField, string>;

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "")
    .replace(/[()[\]{}<>【】“”"'`‘’、，。；：！？,.!?/\\|]/g, "");
}

function normalizeDisplayValue(value: unknown) {
  return String(value ?? "").trim();
}

function isInventoryMetricQuantityHeader(value: string) {
  return /(库存|在库|可用|结余|冻结|分配|待移入|下单后)/.test(value);
}

function isContactPhoneHeader(value: string) {
  return /(电话|手机|手机号|联系方式|联系电话|号码)/.test(value);
}

export function buildTemplateFingerprint(sheetName: string, headerRow: unknown[]) {
  const headers = headerRow.map((value) => normalizeText(value));
  return `${normalizeText(sheetName)}::${headers.join("|")}`;
}

export function inferMappingFromHeaders(headers: unknown[]): UniversalImportMapping {
  const normalizedHeaders = headers.map((header) => normalizeText(header));
  const mapping = Object.fromEntries(
    UNIVERSAL_IMPORT_FIELDS.map((field) => [field.key, null]),
  ) as UniversalImportMapping;
  const usedColumns = new Set<number>();

  const fieldScores = UNIVERSAL_IMPORT_FIELDS.map((field) => {
    const aliases = field.aliases.map((alias) => normalizeText(alias));
    const candidateScores = normalizedHeaders.map((header, columnIndex) => {
      if (!header) {
        return { columnIndex, score: 0 };
      }

      const score = aliases.reduce((currentScore, alias) => {
        if (!alias) {
          return currentScore;
        }

        if (field.key === "skuQuantity" && alias === "数量" && isInventoryMetricQuantityHeader(header)) {
          return currentScore;
        }

        if (field.key === "receiverName" && isContactPhoneHeader(header)) {
          return currentScore;
        }

        if (header === alias) {
          return Math.max(currentScore, 100);
        }

        if (header.includes(alias) || alias.includes(header)) {
          return Math.max(currentScore, 80 - Math.abs(header.length - alias.length));
        }

        return currentScore;
      }, 0);

      return { columnIndex, score };
    });

    const bestScore = candidateScores.reduce(
      (currentBest, candidate) => (candidate.score > currentBest.score ? candidate : currentBest),
      { columnIndex: -1, score: 0 },
    );

    return {
      field: field.key,
      bestScore,
      candidateScores,
    };
  });

  fieldScores
    .sort((left, right) => right.bestScore.score - left.bestScore.score)
    .forEach(({ field, candidateScores, bestScore }) => {
      if (bestScore.score <= 0) {
        return;
      }

      const chosen = candidateScores
        .filter((candidate) => !usedColumns.has(candidate.columnIndex))
        .sort((left, right) => right.score - left.score)[0];

      if (!chosen || chosen.score <= 0) {
        return;
      }

      mapping[field] = chosen.columnIndex;
      usedColumns.add(chosen.columnIndex);
    });

  return mapping;
}

export function createEmptyRow(rowIndex: number): UniversalImportRow {
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
  };
}

function isPhoneLike(value: string) {
  const normalized = value.replace(/\s+/g, "");
  return /^(?:1\d{10}|(?:0\d{2,3}-?)?\d{7,8})$/.test(normalized);
}

export function normalizeNumericImportValue(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  const normalized = text
    .normalize("NFKC")
    .replace(/,/g, "")
    .replace(/[（(]\s*(?:公斤|千克|kg|KG|g|G|斤|件|箱|包|瓶|袋|个|pcs?)\s*[）)]/gi, "")
    .replace(/\s*(?:公斤|千克|kg|KG|g|G|斤|件|箱|包|瓶|袋|个|pcs?)\s*$/gi, "")
    .trim();

  const match = normalized.match(/^\+?(\d+(?:\.\d+)?)/);
  return match?.[1] ?? normalized;
}

function isPositiveNumber(value: string) {
  const normalized = normalizeNumericImportValue(value);
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return false;
  }

  return Number.parseFloat(normalized) > 0;
}

function isPositiveInteger(value: string) {
  const normalized = normalizeNumericImportValue(value);
  if (!/^\d+$/.test(normalized)) {
    return false;
  }

  return Number.parseInt(normalized, 10) > 0;
}

function normalizeExternalCode(value: string) {
  return value.trim().toLowerCase();
}

export function countAggregatedShipments(rows: UniversalImportRow[]) {
  return new Set(rows.map((row) => normalizeExternalCode(row.externalCode)).filter(Boolean)).size;
}

function getDuplicateSourceLabel(entry: ExistingExternalCodeEntry) {
  if (entry.rowIndex) {
    return entry.batchName ? `历史批次“${entry.batchName}”第 ${entry.rowIndex} 行` : `历史第 ${entry.rowIndex} 行`;
  }

  if (entry.batchName) {
    return `历史批次“${entry.batchName}”`;
  }

  return "历史数据";
}

function normalizeExistingExternalCodes(
  existingExternalCodes:
    | Set<string>
    | Map<string, ExistingExternalCodeEntry>
    | ExistingExternalCodeEntry[],
) {
  if (existingExternalCodes instanceof Set) {
    return new Map(
      Array.from(existingExternalCodes, (value) => [normalizeExternalCode(value), { externalCode: value }]),
    );
  }

  if (existingExternalCodes instanceof Map) {
    return new Map(
      Array.from(existingExternalCodes.entries(), ([key, value]) => [normalizeExternalCode(key), value]),
    );
  }

  return new Map(existingExternalCodes.map((entry) => [normalizeExternalCode(entry.externalCode), entry]));
}

export function validateImportRows(
  rows: UniversalImportRow[],
  existingExternalCodes: Set<string> | Map<string, ExistingExternalCodeEntry> | ExistingExternalCodeEntry[] = new Set(),
) {
  const issues: UniversalImportIssue[] = [];
  const existingLookup = normalizeExistingExternalCodes(existingExternalCodes);

  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const externalCode = row.externalCode.trim();

    if (externalCode) {
      const normalized = normalizeExternalCode(externalCode);
      const existing = existingLookup.get(normalized);

      if (existing) {
        issues.push({
          rowIndex: rowNumber,
          field: "externalCode",
          message: `与${getDuplicateSourceLabel(existing)}重复`,
        });
      }
    }

    const hasStoreGroup = Boolean(row.receiverStore.trim());
    const hasReceiverGroup =
      Boolean(row.receiverName.trim()) &&
      Boolean(row.receiverPhone.trim()) &&
      Boolean(row.receiverAddress.trim());

    if (!hasStoreGroup && !hasReceiverGroup) {
      issues.push({
        rowIndex: rowNumber,
        field: "receiverStore",
        message: "收货门店或收件人信息至少完整填写一组",
      });
    }

    if (row.receiverPhone.trim() && !isPhoneLike(row.receiverPhone.trim())) {
      issues.push({ rowIndex: rowNumber, field: "receiverPhone", message: "格式错误" });
    }

    if (!row.skuCode.trim()) {
      issues.push({ rowIndex: rowNumber, field: "skuCode", message: "必填项缺失" });
    }

    if (!row.skuName.trim()) {
      issues.push({ rowIndex: rowNumber, field: "skuName", message: "必填项缺失" });
    }

    if (!row.skuQuantity.trim()) {
      issues.push({ rowIndex: rowNumber, field: "skuQuantity", message: "必填项缺失" });
    } else if (!isPositiveInteger(row.skuQuantity.trim())) {
      issues.push({ rowIndex: rowNumber, field: "skuQuantity", message: "必须为正整数" });
    }

  });

  const issuesByRow = new Map<number, UniversalImportIssue[]>();
  issues.forEach((issue) => {
    const list = issuesByRow.get(issue.rowIndex) ?? [];
    list.push(issue);
    issuesByRow.set(issue.rowIndex, list);
  });

  return {
    issues,
    issuesByRow,
  };
}

export function formatIssueLabel(issue: UniversalImportIssue) {
  return `第 ${issue.rowIndex} 行，${UNIVERSAL_IMPORT_FIELD_LABELS[issue.field]}：${issue.message}`;
}

export function toSafeSheetName(name: string) {
  return normalizeDisplayValue(name).slice(0, 30) || "Sheet1";
}
