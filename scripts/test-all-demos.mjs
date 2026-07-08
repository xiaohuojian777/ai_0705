/**
 * 综合测试：所有 demo 文件 → AI 建议/手工规则 → 解析 → 去重保存 → 提交下单
 * 用法：node scripts/test-all-demos.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { File } from "node:buffer";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DEMOS_DIR = resolve(import.meta.dirname, "..", "demos");

const PLACEHOLDER_MAPPING = {
  externalCode: null, receiverStore: null, receiverName: null,
  receiverPhone: null, receiverAddress: null, note: null,
  skuCode: 0, skuName: 0, skuQuantity: 0, skuSpec: null,
};

// ─── TXT 文件自定义规则 ────────────────────────────────────
const TXT_CUSTOM_RULES = {
  "配送签收单（多单）.txt": {
    type: "text_record_split", enabled: true,
    config: {
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
  },
  "门店配送确认单.txt": {
    type: "text_record_split", enabled: true,
    config: {
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
  },
  "黔寨寨配送单.txt": {
    type: "text_record_split", enabled: true,
    config: {
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
  },
};

function getFileType(filename) {
  const ext = extname(filename).toLowerCase();
  if ([".xlsx", ".xls"].includes(ext)) return "excel";
  return "text";
}

async function findExistingRule(fingerprint, ruleName, fileType) {
  const res = await fetch(`${BASE_URL}/api/universal-import/templates`);
  if (!res.ok) return null;
  const { templates } = await res.json();
  // 优先 fingerprint 前缀匹配
  let found = (templates || []).find(
    (t) => t.fingerprint?.startsWith(fingerprint) && t.status !== "DELETED"
  );
  if (found) return found;
  // TXT 文件 fingerprint 可能不匹配（保存 API 用 "sheet1::"，测试 API 用文件名），兜底按 ruleName + fileType 匹配
  if (ruleName && fileType) {
    found = (templates || []).find(
      (t) => t.ruleName === ruleName && t.fileType === fileType && t.status !== "DELETED"
    );
  }
  return found || null;
}

async function testFile(filename, stats) {
  const filePath = resolve(DEMOS_DIR, filename);
  const fileBuffer = readFileSync(filePath);
  const fileType = getFileType(filename);
  const isTxt = fileType === "text";
  const ruleName = basename(filename, extname(filename));
  const startTime = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📄 ${filename}  (${(stats.size / 1024).toFixed(1)} KB)${isTxt ? " ⚡手工规则" : ""}`);
  console.log(`${"=".repeat(60)}`);

  let suggestedRule = null;
  let documentSummary = null;

  if (isTxt && TXT_CUSTOM_RULES[filename]) {
    // ── TXT: 直接使用自定义规则 ──
    console.log(`  [1/3] 使用手工规则...`);
    const customTransform = TXT_CUSTOM_RULES[filename];
    const DISABLED = ["header_mapping","tail_text_extract","matrix_pivot","split_multiline_cell","multisheet_merge","card_split"]
      .map(t => ({ type: t, enabled: false, config: {} }));
    suggestedRule = {
      fileType: "text", mode: "text",
      mapping: PLACEHOLDER_MAPPING,
      transforms: [...DISABLED, customTransform, { type: "group_by_external_code", enabled: true, config: {} }],
    };
  } else {
    // ── Excel: AI Suggest ──
    console.log(`  [1/4] AI 规则建议...`);
    const suggestForm = new FormData();
    suggestForm.append("file", new File([fileBuffer], filename), filename);
    suggestForm.append("fileType", fileType);
    let suggestRes, suggestData;
    try {
      suggestRes = await fetch(`${BASE_URL}/api/universal-import/templates/ai-suggest`, { method: "POST", body: suggestForm });
      suggestData = await suggestRes.json();
    } catch (err) {
      console.log(`  ❌ AI Suggest 失败: ${err.message}`);
      return { file: filename, status: "FAILED", error: err.message };
    }
    if (!suggestRes.ok) {
      console.log(`  ❌ AI Suggest 错误: ${JSON.stringify(suggestData.error || suggestData)}`);
      return { file: filename, status: "FAILED_AI", error: suggestData.error };
    }
    suggestedRule = suggestData.suggestedRule;
    documentSummary = suggestData.documentSummary;
    console.log(`  ✅ 建议完成 (${suggestData.provider}/${suggestData.model})`);
    console.log(`     Transforms: ${suggestedRule.transforms.filter(t => t.enabled).map(t => t.type).join(", ") || "(none)"}`);
  }

  // ── Test Parse ──
  const stepNum = isTxt ? "2/3" : "2/4";
  console.log(`  [${stepNum}] 试解析...`);
  const testForm = new FormData();
  testForm.append("file", new File([fileBuffer], filename), filename);
  testForm.append("fileType", fileType);
  testForm.append("mapping", JSON.stringify(suggestedRule.mapping));
  testForm.append("ruleDsl", JSON.stringify(suggestedRule));
  let testRes, testData;
  try {
    testRes = await fetch(`${BASE_URL}/api/universal-import/templates/test`, { method: "POST", body: testForm });
    testData = await testRes.json();
  } catch (err) {
    console.log(`  ❌ 解析失败: ${err.message}`);
    return { file: filename, status: "FAILED", error: err.message };
  }
  if (!testRes.ok) {
    console.log(`  ❌ 解析失败: ${JSON.stringify(testData.error || testData)}`);
    return { file: filename, status: "FAILED_PARSE", error: testData.error };
  }
  const { previewRows, rowCount, fingerprint, issues } = testData;
  console.log(`  ✅ 解析: ${rowCount || previewRows.length}行, ${issues?.length || 0}个问题`);
  if (!isTxt) console.log(`     Fingerprint: ${fingerprint}`);
  issues?.slice(0, 3).forEach(iss => console.log(`     ⚠ ${iss.message || iss}`));
  previewRows?.slice(0, 3).forEach((row, i) => {
    const code = row.externalCode || "(空)";
    const name = row.skuName || "(空)";
    const qty = row.skuQuantity || "0";
    const store = row.receiverStore || "(无)";
    console.log(`     [${i + 1}] ${code} | ${name} x${qty} → ${store}`);
  });
  if (previewRows?.length > 3) console.log(`     ... 共 ${previewRows.length} 行`);

  if (!previewRows || previewRows.length === 0) {
    console.log(`  ⚠ 无数据，跳过`);
    return { file: filename, status: "NO_DATA", rowCount: 0, duration: Date.now() - startTime };
  }

  // ── Save Rule (去重) ──
  const stepNum3 = isTxt ? "3/3" : "3/4";
  console.log(`  [${stepNum3}] 保存规则（去重检查）...`);
  const effectiveFingerprint = fingerprint || `${ruleName}::`;
  const existingRule = await findExistingRule(effectiveFingerprint, ruleName, fileType);
  let savedRuleId = null;
  if (existingRule) {
    console.log(`  ⏭ 已存在: "${existingRule.ruleName}" v${existingRule.version} (id: ${existingRule.id})`);
    savedRuleId = existingRule.id;
  } else {
    const saveBody = {
      ruleName,
      sheetName: documentSummary?.sheetName || "Sheet1",
      headers: documentSummary?.headers || [],
      mapping: suggestedRule.mapping,
      fileType,
      ruleDsl: suggestedRule,
    };
    let saveRes, saveData;
    try {
      saveRes = await fetch(`${BASE_URL}/api/universal-import/templates`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveBody),
      });
      saveData = await saveRes.json();
    } catch (err) {
      console.log(`  ❌ 保存失败: ${err.message}`);
      return { file: filename, status: "FAILED_SAVE", error: err.message };
    }
    if (!saveRes.ok) {
      console.log(`  ❌ 保存失败: ${JSON.stringify(saveData.error || saveData)}`);
      return { file: filename, status: "FAILED_SAVE", error: saveData.error };
    }
    console.log(`  ✅ 已保存: "${saveData.template.ruleName}" v${saveData.template.version} (id: ${saveData.template.id})`);
    savedRuleId = saveData.template.id;
  }

  // ── Submit Shipments ──
  const stepNum4 = isTxt ? undefined : "4/4";
  if (!isTxt) console.log(`  [${stepNum4}] 提交下单...`);
  else console.log(`  [提交下单]`);

  const rows = previewRows.map((row, idx) => ({
    externalCode: row.externalCode || "", receiverStore: row.receiverStore || "",
    receiverName: row.receiverName || "", receiverPhone: row.receiverPhone || "",
    receiverAddress: row.receiverAddress || "", skuCode: row.skuCode || "",
    skuName: row.skuName || "", skuQuantity: String(row.skuQuantity || "0"),
    skuSpec: row.skuSpec || "", note: row.note || "",
    rowIndex: row.rowIndex ?? idx,
  }));

  const shipBody = {
    batchName: `${ruleName}_(自动导入)`,
    originalFileName: filename, fileType,
    sheetName: documentSummary?.sheetName || "Sheet1",
    headers: documentSummary?.headers || [],
    rows, mapping: suggestedRule.mapping,
    fingerprint: effectiveFingerprint, ruleId: savedRuleId,
  };
  let shipRes, shipData;
  try {
    shipRes = await fetch(`${BASE_URL}/api/universal-import/shipments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shipBody),
    });
    shipData = await shipRes.json();
  } catch (err) {
    console.log(`  ❌ 下单失败: ${err.message}`);
    return { file: filename, status: "FAILED_SHIPMENT", error: err.message, ruleId: savedRuleId };
  }
  const dur = Date.now() - startTime;
  if (!shipRes.ok) {
    console.log(`  ❌ 下单失败: ${shipData.error}`);
    if (shipData.issues) shipData.issues.slice(0, 5).forEach(i => console.log(`     - ${i}`));
    return { file: filename, status: "FAILED_SHIPMENT", error: shipData.error, issues: shipData.issues, ruleId: savedRuleId };
  }
  console.log(`  ✅ 下单成功! ${shipData.summary?.shipmentCount || 0}单 ${shipData.summary?.successCount || 0}行 ⏱${(dur / 1000).toFixed(1)}s`);
  return {
    file: filename, status: "SUCCESS", ruleId: savedRuleId,
    rowCount: rowCount || previewRows.length,
    shipmentCount: shipData.summary?.shipmentCount || 0,
    successCount: shipData.summary?.successCount || 0, duration: dur,
  };
}

async function main() {
  console.log(`\n🔍 万能导入 Demo 文件综合测试 (v2)`);
  console.log(`   服务器: ${BASE_URL}`);
  const serverOk = await fetch(`${BASE_URL}/api/universal-import/templates`)
    .then(r => r.ok).catch(() => false);
  if (!serverOk) { console.log(`\n❌ 服务器未运行！`); process.exit(1); }
  console.log(`✅ 服务器连接正常\n`);

  // 先处理 TXT 文件，再处理 Excel（TXT 用自定义规则不依赖 AI）
  const files = readdirSync(DEMOS_DIR, { withFileTypes: true })
    .filter(d => d.isFile())
    .map(d => ({ name: d.name, stats: { size: readFileSync(resolve(DEMOS_DIR, d.name)).length } }));

  const txtFiles = files.filter(f => getFileType(f.name) === "text");
  const excelFiles = files.filter(f => getFileType(f.name) !== "text");

  const results = [];

  for (const f of txtFiles) {
    const r = await testFile(f.name, f.stats);
    results.push(r);
  }
  for (let i = 0; i < excelFiles.length; i++) {
    console.log(`\n▶ [${results.length + 1}/${files.length}]`);
    const r = await testFile(excelFiles[i].name, excelFiles[i].stats);
    results.push(r);
  }

  // ─── 汇总 ───
  console.log(`\n\n${"=".repeat(60)}`);
  console.log(`📊 测试汇总`);
  console.log(`${"=".repeat(60)}`);
  const success = results.filter(r => r.status === "SUCCESS");
  const failed = results.filter(r => r.status !== "SUCCESS");
  console.log(`  ✅ 成功: ${success.length}   ❌ 失败: ${failed.length}`);
  const totalShipments = results.reduce((s, r) => s + (r.shipmentCount || 0), 0);
  const totalRows = results.reduce((s, r) => s + (r.successCount || 0), 0);
  const totalDur = results.reduce((s, r) => s + (r.duration || 0), 0);
  console.log(`  📦 ${totalShipments} 单 | 📄 ${totalRows} 行 | ⏱ ${(totalDur / 1000).toFixed(1)}s`);

  results.forEach(r => {
    const icon = r.status === "SUCCESS" ? "✅" : "❌";
    console.log(`  ${icon} ${r.file} | ${r.rowCount || 0}行/${r.shipmentCount || 0}单 | ${((r.duration || 0) / 1000).toFixed(1)}s${r.status !== "SUCCESS" ? ` | ${r.error || r.status}` : ""}`);
  });

  if (failed.length > 0) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
