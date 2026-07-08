/**
 * 自动化测试脚本：遍历 demos 文件，执行导入 → 生成规则（去重）→ 提交下单
 * 用法：node scripts/test-demos.mjs
 * 依赖：本地开发服务器运行在 http://localhost:3000
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { File } from "node:buffer";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const DEMOS_DIR = resolve(import.meta.dirname, "..", "demos");

// ─── 工具函数 ───────────────────────────────────────────────

function log(text) {
  console.log(text);
}

function getFileType(filename) {
  const ext = extname(filename).toLowerCase();
  if ([".xlsx", ".xls"].includes(ext)) return "excel";
  if ([".csv", ".tsv"].includes(ext)) return "csv";
  return "text";
}

async function checkServer() {
  try {
    const res = await fetch(`${BASE_URL}/api/universal-import/templates`);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 从已保存的模板列表中查找是否已存在相同结构（表头）的规则
 */
async function findExistingRule(fingerprint) {
  const res = await fetch(`${BASE_URL}/api/universal-import/templates`);
  if (!res.ok) return null;
  const { templates } = await res.json();
  // fingerprint 格式: "normalizedSheet::normalizedHeaders"
  // 数据库中保存的是: "normalizedSheet::normalizedHeaders::randomUUID"
  return (templates || []).find(
    (t) => t.fingerprint?.startsWith(fingerprint) && t.status !== "DELETED"
  ) || null;
}

// ─── 主流程 ──────────────────────────────────────────────────

async function testDemoFile(filename, stats) {
  const filePath = resolve(DEMOS_DIR, filename);
  const fileBuffer = readFileSync(filePath);
  const fileType = getFileType(filename);
  const displayName = filename;

  log(`\n${"=".repeat(60)}`);
  log(`📄 ${displayName}  (${(stats.size / 1024).toFixed(1)} KB)`);
  log(`${"=".repeat(60)}`);

  const startTime = Date.now();

  // ── Step 1: AI Suggest ───────────────────────────────────
  log(`  [1/4] AI 规则建议...`);

  const suggestForm = new FormData();
  const file1 = new File([fileBuffer], filename);
  suggestForm.append("file", file1, filename);
  suggestForm.append("fileType", fileType);

  let suggestRes;
  try {
    suggestRes = await fetch(
      `${BASE_URL}/api/universal-import/templates/ai-suggest`,
      { method: "POST", body: suggestForm }
    );
  } catch (err) {
    log(`  ❌ AI Suggest 请求失败: ${err.message}`);
    return { file: filename, status: "FAILED", error: err.message };
  }

  const suggestData = await suggestRes.json();

  if (!suggestRes.ok) {
    log(`  ❌ AI Suggest 返回错误: ${JSON.stringify(suggestData.error || suggestData)}`);
    return { file: filename, status: "FAILED_AI_SUGGEST", error: suggestData.error };
  }

  const { documentSummary, suggestedRule } = suggestData;
  log(`  ✅ AI 建议完成 (${suggestData.provider}/${suggestData.model})`);
  log(`     Sheet: "${documentSummary.sheetName}", 行数: ${documentSummary.rowCount}, 段数: ${documentSummary.sectionCount}`);
  log(`     置信度: ${(suggestData.confidenceReport || []).map(c => `${c.field}:${(c.confidence * 100).toFixed(0)}%`).join(", ")}`);
  if (suggestData.riskNotes?.length) {
    suggestData.riskNotes.forEach((n) => log(`     ⚠ ${n}`));
  }
  log(`     Transforms: ${suggestedRule.transforms.filter(t => t.enabled).map(t => t.type).join(", ") || "(none)"}`);

  // ── Step 2: Test Parse ───────────────────────────────────
  log(`  [2/4] 试解析...`);

  const testForm = new FormData();
  const file2 = new File([fileBuffer], filename);
  testForm.append("file", file2, filename);
  testForm.append("fileType", fileType);
  testForm.append("mapping", JSON.stringify(suggestedRule.mapping));
  testForm.append("ruleDsl", JSON.stringify(suggestedRule));

  let testRes;
  try {
    testRes = await fetch(`${BASE_URL}/api/universal-import/templates/test`, {
      method: "POST",
      body: testForm,
    });
  } catch (err) {
    log(`  ❌ Test Parse 请求失败: ${err.message}`);
    return { file: filename, status: "FAILED", error: err.message };
  }

  const testData = await testRes.json();

  if (!testRes.ok) {
    log(`  ❌ 试解析失败: ${JSON.stringify(testData.error || testData)}`);
    return { file: filename, status: "FAILED_PARSE", error: testData.error };
  }

  const { previewRows, rowCount, fingerprint, issues } = testData;
  log(`  ✅ 解析完成: ${rowCount || previewRows.length} 行, ${issues?.length || 0} 个问题`);
  log(`     Fingerprint: ${fingerprint}`);

  if (issues?.length) {
    issues.slice(0, 5).forEach((iss) => log(`     ⚠ 行${iss.rowIndex}: ${iss.message}`));
    if (issues.length > 5) log(`     ... 还有 ${issues.length - 5} 个问题`);
  }

  // 预览前3行
  previewRows?.slice(0, 3).forEach((row, i) => {
    const code = row.externalCode || "(空)";
    const name = row.skuName || "(空)";
    const qty = row.skuQuantity || "0";
    const store = row.receiverStore || row.receiverName || "(无收货信息)";
    log(`     [${i + 1}] ${code} | ${name} x${qty} | → ${store}`);
  });
  if (previewRows?.length > 3) log(`     ... 共 ${previewRows.length} 行`);

  // ── Step 3: Save Rule (去重) ───────────────────────────
  log(`  [3/4] 保存规则（去重检查）...`);

  const existingRule = await findExistingRule(fingerprint);
  let savedRuleId = null;

  if (existingRule) {
    log(`  ⏭ 规则已存在（去重跳过）: "${existingRule.ruleName}" v${existingRule.version} (id: ${existingRule.id})`);
    savedRuleId = existingRule.id;
  } else {
    const ruleName = basename(filename, extname(filename));
    const saveBody = {
      ruleName,
      sheetName: documentSummary.sheetName,
      headers: documentSummary.headers,
      mapping: suggestedRule.mapping,
      fileType,
      ruleDsl: suggestedRule,
    };

    let saveRes;
    try {
      saveRes = await fetch(`${BASE_URL}/api/universal-import/templates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(saveBody),
      });
    } catch (err) {
      log(`  ❌ 保存规则请求失败: ${err.message}`);
      return { file: filename, status: "FAILED_SAVE", error: err.message };
    }

    const saveData = await saveRes.json();

    if (!saveRes.ok) {
      log(`  ❌ 保存规则失败: ${JSON.stringify(saveData.error || saveData)}`);
      return { file: filename, status: "FAILED_SAVE", error: saveData.error };
    }

    log(`  ✅ 规则已保存: "${saveData.template.ruleName}" v${saveData.template.version} (id: ${saveData.template.id})`);
    savedRuleId = saveData.template.id;
  }

  // ── Step 4: Submit Shipments ────────────────────────────
  log(`  [4/4] 提交下单...`);

  if (!previewRows || previewRows.length === 0) {
    log(`  ⚠ 无数据可提交，跳过下单`);
    return {
      file: filename,
      status: "NO_DATA",
      ruleId: savedRuleId,
      rowCount: 0,
      duration: Date.now() - startTime,
    };
  }

  // 处理行数据,确保所有必填字段存在
  const rows = previewRows.map((row, idx) => ({
    externalCode: row.externalCode || "",
    receiverStore: row.receiverStore || "",
    receiverName: row.receiverName || "",
    receiverPhone: row.receiverPhone || "",
    receiverAddress: row.receiverAddress || "",
    skuCode: row.skuCode || "",
    skuName: row.skuName || "",
    skuQuantity: String(row.skuQuantity || "0"),
    skuSpec: row.skuSpec || "",
    note: row.note || "",
    rowIndex: row.rowIndex ?? idx,
  }));

  const shipmentBody = {
    batchName: `${basename(filename, extname(filename))}_(自动导入)`,
    originalFileName: filename,
    fileType,
    sheetName: documentSummary.sheetName,
    headers: documentSummary.headers,
    rows,
    mapping: suggestedRule.mapping,
    fingerprint,
    ruleId: savedRuleId,
  };

  let shipmentRes;
  try {
    shipmentRes = await fetch(`${BASE_URL}/api/universal-import/shipments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(shipmentBody),
    });
  } catch (err) {
    log(`  ❌ 提交下单请求失败: ${err.message}`);
    return { file: filename, status: "FAILED_SHIPMENT", error: err.message, ruleId: savedRuleId };
  }

  const shipmentData = await shipmentRes.json();

  if (!shipmentRes.ok) {
    log(`  ❌ 提交下单失败: ${JSON.stringify(shipmentData.error || shipmentData)}`);
    if (shipmentData.issues) {
      shipmentData.issues.slice(0, 5).forEach((iss) => log(`     问题: ${iss}`));
    }
    return {
      file: filename,
      status: "FAILED_SHIPMENT",
      error: shipmentData.error,
      ruleId: savedRuleId,
      issues: shipmentData.issues,
    };
  }

  const duration = Date.now() - startTime;
  log(`  ✅ 提交下单成功!`);
  log(`     批次: ${shipmentData.summary?.shipmentCount || 0} 单, 成功: ${shipmentData.summary?.successCount || 0} 行`);
  log(`     ⏱ 耗时: ${(duration / 1000).toFixed(1)}s`);

  return {
    file: filename,
    status: "SUCCESS",
    ruleId: savedRuleId,
    rowCount: rowCount || previewRows.length,
    shipmentCount: shipmentData.summary?.shipmentCount || 0,
    successCount: shipmentData.summary?.successCount || 0,
    duration,
  };
}

// ─── 入口 ──────────────────────────────────────────────────

async function main() {
  log(`\n🔍 万能导入 Demo 文件批量测试`);
  log(`   服务器: ${BASE_URL}`);
  log(`   目录: ${DEMOS_DIR}`);

  // 检查服务器
  const serverOk = await checkServer();
  if (!serverOk) {
    log(`\n❌ 服务器未运行！请先启动: npm run dev`);
    process.exit(1);
  }
  log(`✅ 服务器连接正常\n`);

  // 收集所有文件
  const allFiles = readdirSync(DEMOS_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => ({
      name: dirent.name,
      stats: readFileSync(resolve(DEMOS_DIR, dirent.name), { flag: "r" }), // 获取文件大小即可
    }));

  // 获取文件大小
  const files = readdirSync(DEMOS_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isFile())
    .map((dirent) => ({
      name: dirent.name,
      stats: { size: readFileSync(resolve(DEMOS_DIR, dirent.name)).length },
    }));

  const results = [];
  const total = files.length;

  for (let i = 0; i < files.length; i++) {
    const { name, stats } = files[i];
    log(`\n▶ [${i + 1}/${total}]`);
    const result = await testDemoFile(name, stats);
    results.push(result);
  }

  // ─── 汇总报告 ──────────────────────────────────────────
  log(`\n\n${"=".repeat(60)}`);
  log(`📊 测试汇总报告`);
  log(`${"=".repeat(60)}`);

  const success = results.filter((r) => r.status === "SUCCESS");
  const failed = results.filter((r) => r.status !== "SUCCESS" && r.status !== "NO_DATA");
  const nodata = results.filter((r) => r.status === "NO_DATA");
  const deduped = results.filter((r) => r.status === "SUCCESS" && r._deduped);

  log(`  ✅ 成功: ${success.length} 文件`);
  log(`  ⚠ 无数据: ${nodata.length} 文件`);
  log(`  ❌ 失败: ${failed.length} 文件`);
  log(`  🔄 规则去重命中: ${deduped.length} 次`);

  const totalShipments = results.reduce((s, r) => s + (r.shipmentCount || 0), 0);
  const totalRows = results.reduce((s, r) => s + (r.successCount || 0), 0);
  const totalDuration = results.reduce((s, r) => s + (r.duration || 0), 0);

  log(`\n  📦 总下单数: ${totalShipments} 单`);
  log(`  📄 总行数: ${totalRows} 行`);
  log(`  ⏱ 总耗时: ${(totalDuration / 1000).toFixed(1)}s`);

  if (failed.length > 0) {
    log(`\n  失败详情:`);
    failed.forEach((r) => {
      log(`    ❌ ${r.file}: ${r.error || r.status}`);
      if (r.issues) r.issues.forEach((i) => log(`       - ${i}`));
    });
  }

  // 详情表
  log(`\n${"-".repeat(60)}`);
  log(`  文件详情:`);
  results.forEach((r) => {
    const icon = r.status === "SUCCESS" ? "✅" : r.status === "NO_DATA" ? "⚠" : "❌";
    log(`  ${icon} ${r.file} | ${r.status} | ${r.rowCount || 0}行 | ${r.shipmentCount || 0}单 | ${((r.duration || 0) / 1000).toFixed(1)}s`);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
