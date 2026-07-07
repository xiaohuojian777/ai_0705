/**
 * 周配送计划 - 矩阵格式专项导入
 * 格式: 行=门店, 列=日期, 单元格内=品名x数量（换行分隔）
 */
const { readFileSync } = require("fs");
const { join } = require("path");
const http = require("http");
const XLSX = require("xlsx");

const BASE = "http://localhost:3000";
const TS = Date.now();
const FILE_PATH = join(__dirname, "..", "demos", "周配送计划.xlsx");

// ── Helpers ──
function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      BASE + path,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, timeout: 60000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, ...JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, error: d }); } });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── 核心: 解析矩阵 ──
function parseMatrixPlan() {
  const wb = XLSX.readFile(FILE_PATH);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sh, { header: 1, defval: "" });

  // Row 0: title, Row 1: period, Row 2: empty, Row 3: headers
  const period = (raw[1]?.[0] || "").replace("配送周期：", "").trim();
  console.log(`  周期: ${period}`);

  // Parse date headers from row 3 (skip col 0 = "收货门店")
  const dateHeaders = [];
  for (let i = 1; i < raw[3].length; i++) {
    const h = String(raw[3][i]).trim();
    if (!h) break;
    // "12月2日（周一）" -> "12月2日"
    dateHeaders.push({ col: i, label: h.replace(/（.+）/, ""), full: h });
  }
  console.log(`  日期列: ${dateHeaders.map(d => d.label).join(", ")}`);

  // Parse store rows (row 4 onwards, skip empty and notes)
  const allRows = [];
  for (let r = 4; r < raw.length; r++) {
    const row = raw[r];
    const storeName = String(row[0] || "").trim();
    // Skip empty rows and note rows
    if (!storeName || storeName.startsWith("备注")) continue;

    console.log(`\n  📍 ${storeName}:`);
    for (const dh of dateHeaders) {
      const cellContent = String(row[dh.col] || "").trim();
      if (!cellContent) continue;

      // Parse items: "品名x数量\n品名x数量"
      const items = cellContent.split("\n").map(s => s.trim()).filter(Boolean);
      let dayCount = 0;
      for (const item of items) {
        // "农夫山泉矿泉水x10" or "农夫山泉矿泉水x10瓶" 
        const m = item.match(/^(.+?)[xX×](\d+)/);
        if (!m) { console.log(`    ⚠ 跳过: "${item}"`); continue; }

        const skuName = m[1].trim();
        const skuQuantity = parseInt(m[2], 10);
        allRows.push({
          externalCode: `W-${storeName}-${dh.label}`,
          receiverStore: storeName,
          receiverName: "",
          receiverPhone: "",
          receiverAddress: "",
          skuCode: `W-${skuName.replace(/\s/g, "")}`,
          skuName,
          skuQuantity: String(skuQuantity),
          skuSpec: "",
          note: `${dh.label}`,
          rowIndex: allRows.length,
        });
        dayCount++;
      }
      if (dayCount > 0) console.log(`    ${dh.label}: ${dayCount}项`);
    }
  }

  return { allRows, period, dateHeaders };
}

// ── 主流程 ──
async function main() {
  console.log("🚀 周配送计划 矩阵导入");
  console.log("═".repeat(50));

  // 1. Parse matrix locally
  console.log("\n📊 解析矩阵...");
  const { allRows, period } = parseMatrixPlan();
  console.log(`\n📊 总计: ${allRows.length} 行明细`);
  if (allRows.length === 0) { console.log("❌ 无数据"); return; }

  // Show sample
  allRows.slice(0, 5).forEach((r, i) =>
    console.log(`  ${i+1}. ${r.receiverStore} | ${r.skuName} | x${r.skuQuantity} | ${r.note}`)
  );
  if (allRows.length > 5) console.log(`  ... 共 ${allRows.length} 行`);

  // 2. Create rule
  console.log("\n💾 创建规则...");
  const ruleName = `周配送计划 ${period} ${new Date().toLocaleDateString("zh-CN")}`;
  const headers = ["externalCode", "receiverStore", "skuCode", "skuName", "skuQuantity", "note"];
  const mapping = {
    externalCode: "externalCode",
    receiverStore: "receiverStore",
    skuCode: "skuCode",
    skuName: "skuName",
    skuQuantity: "skuQuantity",
    note: "note",
  };

  const ruleDsl = {
    fileType: "excel",
    mode: "structured",
    defaults: { receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "" },
    fieldLabels: {},
    presetReceivers: [],
    mapping,
    transforms: [
      { type: "header_mapping", enabled: true, config: { headerRowIndex: 0, dataStartRowIndex: 1, fieldColumns: mapping, requiredRowFields: ["skuName", "skuQuantity"] } },
      { type: "group_by_external_code", enabled: true },
    ],
    aiConfidenceReport: [],
  };

  const ruleRes = await postJSON("/api/universal-import/templates", {
    ruleName, sheetName: "周配送计划", headers, mapping, fileType: "excel", status: "ACTIVE", ruleDsl,
  });

  let ruleId = null;
  if (ruleRes.status === 200 && ruleRes.template) {
    ruleId = ruleRes.template.id;
    console.log(`  ✅ 规则: ${ruleId.slice(0, 10)}...`);
  } else {
    console.log(`  ⚠ 规则创建失败: ${JSON.stringify(ruleRes.error || ruleRes).slice(0, 200)}`);
    console.log(`  继续下单（无 ruleId）...`);
  }

  // 3. Create shipment batch
  console.log("\n📦 创建运单...");
  const batchName = `周配送计划 ${period} [${TS}]`;

  const shipRes = await postJSON("/api/universal-import/shipments", {
    batchName,
    originalFileName: "周配送计划.xlsx",
    fileType: "excel",
    sheetName: "周配送计划",
    headers,
    rows: allRows,
    mapping,
    fingerprint: "weekly-plan-" + TS,
    ruleId,
  });

  if (shipRes.status === 200 || shipRes.status === 201) {
    const totalRows = shipRes.batch?.totalRows ?? allRows.length;
    const status = shipRes.batch?.status ?? "ok";
    const details = shipRes.batch?.details || shipRes.batch;
    console.log(`  ✅ 下单成功: ${totalRows}行, 状态=${status}`);
    if (shipRes.batch?.id) console.log(`  Batch ID: ${shipRes.batch.id}`);
  } else {
    const errMsg = typeof shipRes === "string" ? shipRes : JSON.stringify(shipRes.error || shipRes.issues || shipRes).slice(0, 300);
    console.log(`  ❌ 下单失败: ${errMsg}`);

    // Retry with unique external codes
    console.log("  🔄 使用唯一编码重试...");
    const dedupRows = allRows.map((r, i) => ({
      ...r,
      externalCode: r.externalCode + "-" + TS + "-" + i,
    }));
    const retryRes = await postJSON("/api/universal-import/shipments", {
      batchName: batchName + " (去重)",
      originalFileName: "周配送计划.xlsx",
      fileType: "excel", sheetName: "周配送计划",
      headers, rows: dedupRows, mapping,
      fingerprint: "weekly-plan-dedup-" + TS,
      ruleId,
    });
    if (retryRes.status === 200 || retryRes.status === 201) {
      console.log(`  ✅ 去重重试成功: ${retryRes.batch?.totalRows ?? dedupRows.length}行`);
    } else {
      console.log(`  ❌ 去重重试也失败: ${JSON.stringify(retryRes).slice(0, 300)}`);
    }
  }

  console.log("\n" + "═".repeat(50));
  console.log("🏁 完成!");
}

main().catch((e) => {
  console.error("💥 Fatal:", e.message || e);
  process.exit(1);
});
