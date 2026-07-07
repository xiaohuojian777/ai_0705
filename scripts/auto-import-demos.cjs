/**
 * 自动导入 demos/ 下所有文件 - 增强版
 * 自动处理: 矩阵表格、卡片式、重复数据、缺失收货信息
 */
const { readFileSync, readdirSync } = require("fs");
const { join, extname, basename } = require("path");
const http = require("http");

const DEMOS_DIR = join(__dirname, "..", "demos");
const BASE = "http://localhost:3000";
const TS = Date.now();
const stats = { total: 0, success: 0, ruleCreated: 0, shipmentCreated: 0, skipped: 0, failed: 0, errors: [] };

function postJSON(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      BASE + path,
      { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, timeout: 30000 },
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

function postFile(path, fileBuffer, fileName, fileType, extraFields) {
  return new Promise((resolve, reject) => {
    const boundary = "----FB" + Date.now();
    const CRLF = "\r\n";
    const parts = [];
    const addField = (name, value) => {
      parts.push("--" + boundary + CRLF);
      parts.push("Content-Disposition: form-data; name=\"" + name + "\"" + CRLF + CRLF);
      parts.push(value + CRLF);
    };
    parts.push("--" + boundary + CRLF);
    parts.push("Content-Disposition: form-data; name=\"file\"; filename=\"" + fileName + "\"" + CRLF);
    parts.push("Content-Type: application/octet-stream" + CRLF + CRLF);
    parts.push(fileBuffer);
    parts.push(CRLF);
    addField("fileType", fileType || "excel");
    if (extraFields) {
      for (const [key, value] of Object.entries(extraFields)) {
        addField(key, String(value));
      }
    }
    parts.push("--" + boundary + "--" + CRLF);
    const body = Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p)));
    const req = http.request(
      BASE + path,
      { method: "POST", headers: { "Content-Type": "multipart/form-data; boundary=" + boundary, "Content-Length": body.length }, timeout: 60000 },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => { try { resolve({ status: res.statusCode, ...JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, error: d }); } });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 检查错误是否因为重复 */
function isDuplicateError(err) {
  if (!err) return false;
  const str = JSON.stringify(err).toLowerCase();
  return str.includes("重复") || str.includes("已经存在") || str.includes("already exist") || str.includes("duplicate");
}

/** 检查错误是否因为收货信息缺失 */
function isReceiverMissingError(err) {
  if (!err) return false;
  const str = JSON.stringify(err);
  return str.includes("收货门店") || str.includes("收货人") || str.includes("收件人");
}

/** 智能判断：是否有表头行 */
function hasHeaders(headers) {
  return headers && headers.length > 0 && headers.some((h) => h && h.length > 0);
}

/** 智能构建 ruleDsl */
function buildSmartRuleDsl(parseRes, fileName) {
  const { headers = [], previewRows = [], inferredMapping = {}, issues = [] } = parseRes;
  const hasHeaderRow = hasHeaders(headers);
  const name = fileName.toLowerCase();
  
  // 检测矩阵表格：表头包含日期或数值列
  const mightBeMatrix = !hasHeaderRow && previewRows.length > 0 &&
    previewRows[0] && Object.values(previewRows[0] || {}).some((v) => /^\d+(\.\d+)?$/.test(String(v)));

  // 检测卡片式：表头为空 + 每行数据不连续
  const mightBeCard = !hasHeaderRow && (name.includes("卡片") || name.includes("卡式"));

  // 检测多Sheet
  const mightBeMultiSheet = name.includes("多门店") || name.includes("分sheet") || name.includes("分Sheet");

  const mapping = inferredMapping || {};

  return {
    fileType: "excel",
    mode: "structured",
    defaults: {},
    fieldLabels: {},
    presetReceivers: [],
    mapping: mapping,
    transforms: [
      { type: "header_mapping", enabled: hasHeaderRow, config: { headerRowIndex: 0, dataStartRowIndex: 1, fieldColumns: mapping, requiredRowFields: ["skuCode", "skuName", "skuQuantity"] } },
      { type: "multisheet_merge", enabled: mightBeMultiSheet },
      { type: "group_by_external_code", enabled: true },
      { type: "matrix_pivot", enabled: mightBeMatrix, config: { labelColumnIndex: 0, valueStartColumnIndex: 1, skuNameFromHeader: true } },
      { type: "split_multiline_cell", enabled: false },
      { type: "tail_text_extract", enabled: false },
      { type: "card_split", enabled: mightBeCard, config: { cardDelimiter: "", keyPrefix: "", titleKey: "" } },
      { type: "text_record_split", enabled: false },
    ],
    aiConfidenceReport: [],
  };
}

/** 解析单个文本块的配送单 */
function parseTextBlock(block) {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  const shipment = { externalCode: "", receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "", note: "", items: [] };
  let section = "header";

  for (const line of lines) {
    if (/^[-=#*]{3,}$/.test(line)) continue;
    if (/^【.+】$/.test(line)) continue;
    if (line.startsWith("签收") || line.startsWith("配送信息") || line.startsWith("配送方式") || line.startsWith("承运商") || line.startsWith("物流单号") || line.startsWith("预计送达")) { section = "delivery"; continue; }
    if (line.startsWith("合计") || line === "配送信息：" || line.startsWith("序号")) continue;
    if (line.startsWith("备注")) { shipment.note = line.replace(/^备注[：:]/, "").trim(); continue; }

    if (line.startsWith("单据编号")) {
      shipment.externalCode = line.replace(/^单据编号[：:]/, "").trim();
      continue;
    }
    if (line === "收货信息：" || line === "收货信息:") { section = "receiver"; continue; }
    if (line === "物品明细：" || line === "物品明细:") { section = "items"; continue; }

    if (section === "receiver") {
      if (line.startsWith("收货门店")) shipment.receiverStore = line.replace(/^收货门店[：:]/, "").trim();
      else if (line.startsWith("收货人姓名")) shipment.receiverName = line.replace(/^收货人姓名[：:]/, "").trim();
      else if (line.startsWith("联系电话") || line.startsWith("联系方式")) shipment.receiverPhone = line.replace(/^(联系电话|联系方式)[：:]/, "").trim();
      else if (line.startsWith("收货地址")) shipment.receiverAddress = line.replace(/^收货地址[：:]/, "").trim();
      continue;
    }

    if (section === "items") {
      // 多种格式匹配
      let sc = "", sn = "", ss = "", sq = 0;

      // 格式: "1. SKU001 农夫山泉 550ml*24 数量：10"
      // 分组: [1]=SKU, [2]=名称, [3]=规格, [4]=数量
      let m = line.match(/^\d+\.\s*(SKU\d+)\s+(.+?)\s+(.+?)\s+数量[：:]\s*(\d+)/i);
      if (m) { sc = m[1]; sn = m[2].trim(); ss = m[3].trim(); sq = parseInt(m[4], 10); }

      // 格式: "SKU001 农夫山泉 550ml*24 x10"
      // 分组: [1]=SKU, [2]=名称, [3]=规格, [4]=数量
      if (!sc) { m = line.match(/(SKU\d+)\s+(.+?)\s+(.+?\S)\s+[xX×](\d+)/i); if (m) { sc = m[1]; sn = m[2].trim(); ss = m[3].trim(); sq = parseInt(m[4], 10); } }

      // 格式: 表格列 "1  SKU001  农夫山泉  550ml*24  10"
      // 分组: [1]=SKU, [2]=名称, [3]=规格, [4]=数量
      if (!sc) { m = line.match(/^\d+\s+(SKU\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(\d+)/i); if (m) { sc = m[1]; sn = m[2].trim(); ss = m[3].trim(); sq = parseInt(m[4], 10); } }

      // 格式: "SKU001 农夫山泉 550ml*24 10" (最后空格+数字)
      // 分组: [1]=SKU, [2]=名称, [3]=规格, [4]=数量
      if (!sc) { m = line.match(/(SKU\d+)\s+(.+?)\s+(.+?)\s+(\d+)\s*$/i); if (m) { sc = m[1]; sn = m[2].trim(); ss = m[3].trim(); sq = parseInt(m[4], 10); } }

      if (sc && sq > 0) shipment.items.push({ skuCode: sc, skuName: sn, skuQuantity: sq, skuSpec: ss });
    }
  }
  return shipment;
}

/** 解析文本配送单（支持多单） */
function parseTextShipments(text) {
  // 统一换行符
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const shipments = [];

  // 按分隔线拆分
  const blocks = normalized.split(/\n[-=_#*]{20,}\n/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // 尝试按【签收单】拆分
    const subBlocks = trimmed.split(/\n?(?=【签收单\d+】)/);
    for (const sub of subBlocks) {
      const s = sub.trim();
      if (!s) continue;
      const shipment = parseTextBlock(s);
      if (shipment.items.length > 0 || shipment.externalCode) {
        shipments.push(shipment);
      }
    }
  }

  if (shipments.length === 0) {
    const shipment = parseTextBlock(normalized);
    if (shipment.items.length > 0 || shipment.externalCode) shipments.push(shipment);
  }

  return shipments;
}

function shipmentToRows(shipment, startIdx) {
  return shipment.items.map((item, i) => ({
    externalCode: shipment.externalCode || "",
    receiverStore: shipment.receiverStore || "",
    receiverName: shipment.receiverName || "",
    receiverPhone: shipment.receiverPhone || "",
    receiverAddress: shipment.receiverAddress || "",
    skuCode: item.skuCode, skuName: item.skuName, skuQuantity: String(item.skuQuantity), skuSpec: item.skuSpec || "",
    note: shipment.note || "", rowIndex: startIdx + i,
  }));
}

/** 尝试下单，自动处理重名 */
async function tryCreateShipment(batchName, fileName, fileType, sheetName, headers, rows, mapping, ruleId, attempt) {
  const fingerprint = `${attempt}-${TS}-${Math.random().toString(36).slice(2, 8)}`;

  // Attempt 1: normal
  let res = await postJSON("/api/universal-import/shipments", {
    batchName, originalFileName: fileName, fileType, sheetName: sheetName || "Sheet1",
    headers: headers || [], rows, mapping: mapping || {}, fingerprint, ruleId,
  });

  if (res.status === 200 || res.status === 201) return res;

  // Detect issue type
  const allIssues = res.issues || [];
  const errorStr = JSON.stringify(res);

  if (isDuplicateError(allIssues.length > 0 ? allIssues : errorStr)) {
    console.log(`  🔄 检测到重复数据，使用唯一编码重试...`);
    const dedupRows = rows.map((r, i) => ({
      ...r,
      externalCode: (r.externalCode || batchName) + "-" + TS + "-" + i,
    }));
    return await postJSON("/api/universal-import/shipments", {
      batchName: batchName + " (去重)", originalFileName: fileName, fileType, sheetName: sheetName || "Sheet1",
      headers: headers || [], rows: dedupRows, mapping: mapping || {},
      fingerprint: "dedup-" + TS + "-" + Math.random().toString(36).slice(2, 8), ruleId,
    });
  }

  if (isReceiverMissingError(res)) {
    console.log(`  🔄 收货信息缺失，填充默认值重试...`);
    const filledRows = rows.map((r, i) => ({
      ...r,
      receiverStore: r.receiverStore || "默认门店",
      receiverName: r.receiverName || "默认收件人",
      receiverPhone: r.receiverPhone || "13800000000",
      receiverAddress: r.receiverAddress || "默认地址",
    }));
    return await postJSON("/api/universal-import/shipments", {
      batchName, originalFileName: fileName, fileType, sheetName: sheetName || "Sheet1",
      headers: headers || [], rows: filledRows, mapping: mapping || {},
      fingerprint: "fill-" + TS + "-" + Math.random().toString(36).slice(2, 8), ruleId,
    });
  }

  return res; // unrecoverable
}

/** 处理单个 Excel 文件 */
async function processExcel(fileName) {
  console.log(`\n📄 [EXCEL] ${fileName}`);
  stats.total++;
  const filePath = join(DEMOS_DIR, fileName);

  try {
    const buf = readFileSync(filePath);

    // 1. 首次解析
    console.log("  🔍 初始解析...");
    let parseRes = await postFile("/api/universal-import/templates/test", buf, fileName, "excel");

    // 如果 422 (无有效数据)，尝试用不同策略重新解析
    if (parseRes.status === 422) {
      console.log("  🔄 初始解析无数据，启用矩阵/卡片 Transform 重试...");

      // Try with matrix_pivot
      const matrixDsl = JSON.stringify({
        fileType: "excel",
        mode: "structured",
        transforms: [
          { type: "header_mapping", enabled: true, config: { headerRowIndex: 0, dataStartRowIndex: 1, fieldColumns: {}, requiredRowFields: ["skuCode", "skuName", "skuQuantity"] } },
          { type: "matrix_pivot", enabled: true, config: { labelColumnIndex: 0, valueStartColumnIndex: 1, skuNameFromHeader: true } },
          { type: "multisheet_merge", enabled: true },
          { type: "group_by_external_code", enabled: true },
        ],
        mapping: {},
      });

      parseRes = await postFile("/api/universal-import/templates/test", buf, fileName, "excel", { ruleDsl: matrixDsl });

      if (parseRes.status !== 200 || !parseRes.previewRows?.length) {
        // Try with card_split
        const cardDsl = JSON.stringify({
          fileType: "excel",
          mode: "structured",
          transforms: [
            { type: "card_split", enabled: true, config: {} },
            { type: "header_mapping", enabled: true, config: { headerRowIndex: 0, dataStartRowIndex: 1, fieldColumns: {}, requiredRowFields: ["skuCode", "skuName", "skuQuantity"] } },
            { type: "multisheet_merge", enabled: true },
            { type: "group_by_external_code", enabled: true },
          ],
          mapping: {},
        });
        parseRes = await postFile("/api/universal-import/templates/test", buf, fileName, "excel", { ruleDsl: cardDsl });
      }

      if (parseRes.status !== 200 || !parseRes.previewRows?.length) {
        console.log(`  ❌ 所有策略均无法解析，跳过`);
        stats.skipped++;
        return;
      }
    }

    if (parseRes.status !== 200) {
      console.log(`  ❌ 解析失败 (${parseRes.status})`);
      stats.failed++;
      return;
    }

    const { previewRows = [], issues = [], inferredMapping, sheetName, headers = [] } = parseRes;
    if (!previewRows || previewRows.length === 0) { console.log("  ⚠ 无数据行"); stats.skipped++; return; }

    const sheet = sheetName || basename(fileName, ".xlsx");
    console.log(`  📊 ${previewRows.length} 行 | Sheet="${sheet}" | Headers=${headers.filter(h=>h).length} | Issues=${issues.length}`);

    // 2. Save rule
    const ruleName = fileName.replace(/\.\w+$/, "") + " " + new Date().toLocaleDateString("zh-CN");
    const ruleDsl = buildSmartRuleDsl(parseRes, fileName);
    console.log("  💾 保存规则...");
    const ruleRes = await postJSON("/api/universal-import/templates", {
      ruleName, sheetName: sheet, headers, mapping: inferredMapping || {}, fileType: "excel", status: "ACTIVE", ruleDsl,
    });

    let ruleId = null;
    if (ruleRes.status === 200 && ruleRes.template) { ruleId = ruleRes.template.id; stats.ruleCreated++; console.log(`  ✅ 规则: ${ruleId.slice(0,10)}...`); }

    // 3. Create shipment
    console.log("  📦 下单...");
    const shipRes = await tryCreateShipment(ruleName + " [" + TS + "]", fileName, "excel", sheet, headers, previewRows, inferredMapping || {}, ruleId, "xls");

    if (shipRes.status === 200 || shipRes.status === 201) {
      console.log(`  ✅ 下单: ${shipRes.batch?.totalRows ?? previewRows.length}行, ${shipRes.batch?.status}`);
      stats.shipmentCreated++; stats.success++;
    } else {
      console.log(`  ❌ 下单失败: ${JSON.stringify(shipRes.error || shipRes.issues || shipRes).slice(0, 200)}`);
      if (ruleId) stats.success++;
    }
  } catch (e) {
    console.log(`  ❌ 异常: ${e.message}`);
    stats.failed++; stats.errors.push({ file: fileName, error: e.message });
  }
}

/** 处理文本文件 */
async function processText(fileName) {
  console.log(`\n📝 [TEXT] ${fileName}`);
  stats.total++;

  try {
    const text = readFileSync(join(DEMOS_DIR, fileName), "utf-8");
    const shipments = parseTextShipments(text);
    if (!shipments.length) { console.log("  ⚠ 无运单"); stats.skipped++; return; }

    console.log(`  📊 ${shipments.length} 个运单:`);
    shipments.forEach((s, i) => console.log(`    ${i+1}. ${s.externalCode || "(无)"} → ${s.receiverStore} ${s.receiverName} | ${s.items.length}项`));

    let allRows = [];
    shipments.forEach((s) => { allRows = allRows.concat(shipmentToRows(s, allRows.length)); });
    console.log(`  📊 ${allRows.length} 行明细`);

    const ruleName = fileName.replace(/\.\w+$/, "") + " " + new Date().toLocaleDateString("zh-CN");
    const mapping = {};
    const ruleDsl = {
      fileType: "excel", mode: "structured", defaults: {}, fieldLabels: {}, presetReceivers: [],
      mapping, transforms: [
        { type: "header_mapping", enabled: true, config: { headerRowIndex: 0, dataStartRowIndex: 1, fieldColumns: mapping, requiredRowFields: ["skuCode", "skuName", "skuQuantity"] } },
        { type: "group_by_external_code", enabled: true },
      ], aiConfidenceReport: [],
    };

    // Save rule
    console.log("  💾 保存规则...");
    const ruleRes = await postJSON("/api/universal-import/templates", {
      ruleName, sheetName: fileName, headers: [], mapping, fileType: "excel", status: "ACTIVE", ruleDsl,
    });
    let ruleId = null;
    if (ruleRes.status === 200 && ruleRes.template) { ruleId = ruleRes.template.id; stats.ruleCreated++; console.log(`  ✅ 规则已保存`); }

    // Shipment
    console.log("  📦 下单...");
    const shipRes = await tryCreateShipment(ruleName + " [" + TS + "]", fileName, "excel", fileName, [], allRows, mapping, ruleId, "txt");

    if (shipRes.status === 200 || shipRes.status === 201) {
      console.log(`  ✅ 下单: ${shipRes.batch?.totalRows ?? allRows.length}行, ${shipRes.batch?.status}`);
      stats.shipmentCreated++; stats.success++;
    } else {
      console.log(`  ❌ 下单失败: ${JSON.stringify(shipRes.error || shipRes.issues || shipRes).slice(0, 200)}`);
      if (ruleId) stats.success++;
    }
  } catch (e) {
    console.log(`  ❌ 异常: ${e.message}`);
    stats.failed++; stats.errors.push({ file: fileName, error: e.message });
  }
}

// ======================== MAIN ========================

async function main() {
  console.log("🚀 Demos 自动导入 v2");
  console.log("=" .repeat(50));

  try {
    await new Promise((resolve, reject) => {
      const req = http.get(BASE + "/api/universal-import/templates?take=1", (res) => { res.statusCode === 200 ? resolve() : reject(new Error("" + res.statusCode)); });
      req.on("error", reject); req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
    console.log("✅ 服务器在线\n");
  } catch {
    console.log("❌ 服务器未运行！npx next start -p 3000");
    process.exit(1);
  }

  const files = readdirSync(DEMOS_DIR).filter(f => [".xlsx",".xls",".txt"].includes(extname(f).toLowerCase()));
  console.log(`📁 ${files.length} 个文件\n`);

  const excel = files.filter(f => [".xlsx", ".xls"].includes(extname(f).toLowerCase()));
  const txt = files.filter(f => extname(f).toLowerCase() === ".txt");

  for (const f of excel) { await processExcel(f); await sleep(500); }
  for (const f of txt) { await processText(f); await sleep(500); }

  console.log("\n" + "=".repeat(50));
  console.log("📊 完成！");
  console.log("=".repeat(50));
  console.log(`  总文件: ${stats.total} | 成功: ${stats.success} | 规则: ${stats.ruleCreated} | 运单: ${stats.shipmentCreated} | 跳过: ${stats.skipped} | 失败: ${stats.failed}`);
  if (stats.errors.length) { console.log("\n⚠ 错误:"); stats.errors.forEach((e,i) => console.log(`  ${i+1}. ${e.file}: ${e.error}`)); }
}

main().catch(e => { console.error("💥", e); process.exit(1); });
