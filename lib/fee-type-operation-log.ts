type FeeTypeSnapshot = {
  feeCode: string;
  feeName: string;
  businessDomain: string;
  quoteTypes: string[];
  note: string | null;
};

function diffFields(before: FeeTypeSnapshot, after: FeeTypeSnapshot) {
  const changed: string[] = [];

  if (before.feeName !== after.feeName) {
    changed.push("费用名称");
  }

  if (before.businessDomain !== after.businessDomain) {
    changed.push("所属业务域");
  }

  if (before.quoteTypes.join("|") !== after.quoteTypes.join("|")) {
    changed.push("所属报价");
  }

  if ((before.note ?? "") !== (after.note ?? "")) {
    changed.push("备注");
  }

  return changed;
}

export function buildCreateSummary(feeType: Pick<FeeTypeSnapshot, "feeCode" | "feeName">) {
  return `新增费用类型 ${feeType.feeName}（${feeType.feeCode}）`;
}

export function buildDeleteSummary(feeType: Pick<FeeTypeSnapshot, "feeCode" | "feeName">) {
  return `删除费用类型 ${feeType.feeName}（${feeType.feeCode}）`;
}

export function buildUpdateSummary(before: FeeTypeSnapshot, after: FeeTypeSnapshot) {
  const changedFields = diffFields(before, after);

  if (changedFields.length === 0) {
    return `查看并保存费用类型 ${after.feeName}（${after.feeCode}），字段未变化`;
  }

  return `编辑费用类型 ${after.feeName}（${after.feeCode}），更新字段：${changedFields.join("、")}`;
}
