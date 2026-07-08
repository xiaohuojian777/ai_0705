/**
 * 为失败的 TXT 文件手工构建规则并提交下单（修复 mapping 覆盖问题）
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { File } from "node:buffer";

const BASE_URL = "http://localhost:3000";
const DEMOS = resolve(import.meta.dirname, "..", "demos");

// 核心：mapping 不能全 null，否则 engine 会覆盖 ruleDsl
const PLACEHOLDER_MAPPING = {
  externalCode: null, receiverStore: null, receiverName: null,
  receiverPhone: null, receiverAddress: null, note: null,
  skuCode: 0, skuName: 0, skuQuantity: 0, skuSpec: null,
};
const DISABLED_TRANSFORMS = ["header_mapping","tail_text_extract","matrix_pivot","split_multiline_cell","multisheet_merge","card_split"]
  .map(t => ({ type: t, enabled: false, config: {} }));

async function processFile(filename, ruleName, customRule) {
  console.log(`\n📄 ${filename}`);
  const buf = readFileSync(resolve(DEMOS, filename));
  const ruleDsl = {
    fileType: "text", mode: "text",
    mapping: PLACEHOLDER_MAPPING,
    transforms: [...DISABLED_TRANSFORMS, customRule, { type: "group_by_external_code", enabled: true, config: {} }],
  };

  // Test parse
  const fd = new FormData();
  fd.append("file", new File([buf], filename), filename);
  fd.append("fileType", "text");
  fd.append("mapping", JSON.stringify(ruleDsl.mapping));
  fd.append("ruleDsl", JSON.stringify(ruleDsl));
  const res = await fetch(`${BASE_URL}/api/universal-import/templates/test`, { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) { console.log(`  ❌ Parse: ${data.error || JSON.stringify(data)}`); return false; }
  const count = data.previewRows?.length || data.rowCount;
  console.log(`  ✅ Parse: ${count} rows`);
  data.previewRows?.forEach(r =>
    console.log(`     ${r.externalCode} | ${r.skuName} x${r.skuQuantity} → ${r.receiverStore}`));

  // Save rule
  const saveRes = await fetch(`${BASE_URL}/api/universal-import/templates`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ruleName, sheetName: "Sheet1", headers: [],
      mapping: ruleDsl.mapping, fileType: "text", ruleDsl,
    }),
  });
  const saveData = await saveRes.json();
  const ruleId = saveData.template?.id;
  console.log(`  ⏺ Rule: ${saveData.template?.ruleName} (${ruleId})`);

  // Submit
  const rows = data.previewRows.map((r, i) => ({
    externalCode: r.externalCode || "", receiverStore: r.receiverStore || "",
    receiverName: r.receiverName || "", receiverPhone: r.receiverPhone || "",
    receiverAddress: r.receiverAddress || "", skuCode: r.skuCode || "",
    skuName: r.skuName || "", skuQuantity: String(r.skuQuantity || "0"),
    skuSpec: r.skuSpec || "", note: r.note || "",
    rowIndex: r.rowIndex ?? i,
  }));
  const shipRes = await fetch(`${BASE_URL}/api/universal-import/shipments`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      batchName: ruleName, originalFileName: filename, fileType: "text",
      sheetName: "Sheet1", headers: [], rows,
      mapping: ruleDsl.mapping, fingerprint: data.fingerprint, ruleId,
    }),
  });
  const shipData = await shipRes.json();
  const ok = shipRes.ok;
  const emoji = ok ? "✅" : "❌";
  console.log(`  ${emoji} Submit: ${shipData.summary?.shipmentCount || 0}单 ${shipData.summary?.successCount || 0}行`);
  if (!ok && shipData.issues) shipData.issues.slice(0,3).forEach(i => console.log(`     - ${i}`));
  return ok;
}

// ═══════════════
const results = [];

results.push(await processFile("配送签收单（多单）.txt", "配送签收单_多单", {
  type: "text_record_split", enabled: true, config: {
    recordSeparatorRegex: "-{5,}",
    fieldRegex: {
      externalCode: "单据编号[：:]\\s*(\\S+)",
      receiverStore: "收货门店[：:]\\s*(\\S+)",
      receiverName: "收货人姓名[：:]\\s*(\\S+)",
      receiverPhone: "联系电话[：:]\\s*(\\S+)",
      receiverAddress: "收货地址[：:]\\s*(\\S+)",
    },
    item: {
      regex: "(SKU\\d+)\\s+(.+?)\\s+(\\S+)\\s+x(\\d+)",
      skuCodeGroup: 1, skuNameGroup: 2, skuSpecGroup: 3, skuQuantityGroup: 4,
    },
  },
}));

results.push(await processFile("门店配送确认单.txt", "门店配送确认单", {
  type: "text_record_split", enabled: true, config: {
    recordSeparatorRegex: "-{5,}",
    fieldRegex: {
      externalCode: "单据编号[：:]\\s*(\\S+)",
      receiverStore: "收货门店[：:]\\s*(\\S+)",
      receiverName: "收货人姓名[：:]\\s*(\\S+)",
      receiverPhone: "联系电话[：:]\\s*(\\S+)",
      receiverAddress: "收货地址[：:]\\s*(\\S+)",
      note: "备注[：:]\\s*(.*?)(?:\\r?\\n|$)",
    },
    item: {
      regex: "\\d+\\.\\s*(SKU\\d+)\\s+(.+?)\\s+(\\S+)\\s+数量[：:]\\s*(\\d+)",
      skuCodeGroup: 1, skuNameGroup: 2, skuSpecGroup: 3, skuQuantityGroup: 4,
    },
  },
}));

results.push(await processFile("黔寨寨配送单.txt", "黔寨寨配送单", {
  type: "text_record_split", enabled: true, config: {
    recordSeparatorRegex: "={5,}",
    fieldRegex: {
      externalCode: "单据编号[：:]\\s*(\\S+)",
      receiverStore: "收货门店[：:]\\s*(\\S+)",
      receiverName: "收货人姓名[：:]\\s*(\\S+)",
      receiverPhone: "联系电话[：:]\\s*(\\S+)",
      receiverAddress: "收货地址[：:]\\s*(\\S+)",
      note: "备注[：:]\\s*(.*?)(?:\\r?\\n|$)",
    },
    item: {
      regex: "^\\s*\\d+\\s{2,}(SKU\\d+)\\s{2,}(\\S+)\\s{2,}(\\S+)\\s{2,}(\\d+)",
      skuCodeGroup: 1, skuNameGroup: 2, skuSpecGroup: 3, skuQuantityGroup: 4,
    },
  },
}));

const ok = results.filter(Boolean).length;
console.log(`\n${"=".repeat(40)}`);
console.log(`✅ TXT fix: ${ok}/${results.length} succeeded`);
