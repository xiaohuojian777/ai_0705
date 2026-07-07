/**
 * 完整解析 9 个 demo 文件，去重规则，逐一下单
 * 策略：本地完全解析 → 构造成标准行 → 检查/保存规则 → 提交运单
 */
const X = require("xlsx");
const { readFileSync, readdirSync } = require("fs");
const { join, extname, basename } = require("path");
const http = require("http");

const DEMOS = join(__dirname, "..", "demos");
const BASE = "http://localhost:3000";
const TS = Date.now();

// ======================== HTTP Helpers ========================

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method, path,
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    };
    if (data) {
      opts.headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(BASE + path, opts, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, raw: d.substring(0, 500) }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function getJSON(p) { return request("GET", p); }
function postJSON(p, body) { return request("POST", p, body); }
function delJSON(p) { return request("DELETE", p); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ======================== Rule Management ========================

let ruleCache = null;
async function getExistingRules() {
  if (ruleCache) return ruleCache;
  const res = await getJSON("/api/universal-import/templates?take=200");
  ruleCache = (res.templates || []).filter(t => t.status === "ACTIVE");
  return ruleCache;
}

/** Find existing rule by base name (文件原名,不含日期) */
async function findRule(baseName) {
  const rules = await getExistingRules();
  // Match rules whose ruleName starts with baseName
  return rules.find(r => r.ruleName.startsWith(baseName));
}

/** Create or reuse a rule */
async function ensureRule(ruleName, sheetName, headers, mapping, fileType, ruleDsl) {
  const baseName = ruleName.split(" ")[0]; // first word is file base name
  const existing = await findRule(baseName);
  if (existing) {
    console.log(`    ♻ 复用已有规则: ${existing.id.substring(0, 10)}...`);
    return existing.id;
  }

  const res = await postJSON("/api/universal-import/templates", {
    ruleName: baseName + " " + new Date().toLocaleDateString("zh-CN"),
    sheetName,
    headers,
    mapping,
    fileType,
    status: "ACTIVE",
    ruleDsl,
  });

  if (res.status === 200 && res.template) {
    console.log(`    ✅ 新建规则: ${res.template.id.substring(0, 10)}...`);
    // Clear cache so next lookup finds it
    ruleCache = null;
    return res.template.id;
  }
  if (res.status === 200 && res.id) {
    console.log(`    ✅ 新建规则: ${res.id.substring(0, 10)}...`);
    ruleCache = null;
    return res.id;
  }
  console.log(`    ⚠ 规则保存异常: ${res.status} ${JSON.stringify(res).substring(0, 200)}`);
  return null;
}

/** Submit shipment rows */
async function submitShipment(batchName, fileName, fileType, sheetName, headers, rows, mapping, ruleId) {
  const fp = batchName.replace(/\s/g, "-") + "-" + TS + "-" + Math.random().toString(36).slice(2, 6);
  const res = await postJSON("/api/universal-import/shipments", {
    batchName,
    originalFileName: fileName,
    fileType,
    sheetName: sheetName || "Sheet1",
    headers: headers || [],
    rows,
    mapping: mapping || {},
    fingerprint: fp,
    ruleId,
  });

  if (res.status === 200 || res.status === 201) {
    const cnt = res.batch?.totalRows || rows.length;
    console.log(`    ✅ 运单: ${cnt} 行, 状态=${res.batch?.status || "OK"}`);
    return { ok: true, count: cnt };
  }

  console.log(`    ❌ 运单失败: ${res.status} ${JSON.stringify(res.error || res.issues || res.raw || "").substring(0, 250)}`);
  return { ok: false, count: 0 };
}

// ======================== File Parsers ========================

/**
 * 1. 多门店分Sheet出库单.xlsx
 *    Multi-sheet, each has header at R3, data at R4+
 */
function parseMultiSheet(filePath) {
  const wb = X.readFile(filePath);
  const all = [];
  for (const sn of wb.SheetNames) {
    const d = X.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
    // Find header row (R3 = index 3)
    if (d.length < 5) continue;
    const headerRow = d[3]; // R3
    // Map columns
    const colMap = {};
    const fields = ["externalCode", "skuCode", "skuName", "skuSpec", "skuQuantity", "receiverStore", "receiverName", "receiverPhone", "receiverAddress", "note"];
    headerRow.forEach((h, idx) => {
      const hh = String(h || "").trim();
      if (hh.includes("外部编码")) colMap.externalCode = idx;
      else if (hh.includes("SKU") && hh.includes("编码")) colMap.skuCode = idx;
      else if (hh.includes("SKU") && hh.includes("名称")) colMap.skuName = idx;
      else if (hh.includes("规格")) colMap.skuSpec = idx;
      else if (hh.includes("数量") || hh.includes("发货")) colMap.skuQuantity = idx;
      else if (hh.includes("收货") && hh.includes("门店")) colMap.receiverStore = idx;
      else if (hh.includes("收货") && hh.includes("人")) colMap.receiverName = idx;
      else if (hh.includes("电话")) colMap.receiverPhone = idx;
      else if (hh.includes("地址")) colMap.receiverAddress = idx;
      else if (hh.includes("备注")) colMap.note = idx;
    });

    for (let r = 4; r < d.length; r++) {
      const row = d[r];
      if (!row || !row[0]) continue;
      const obj = {};
      fields.forEach(f => { obj[f] = colMap[f] !== undefined ? String(row[colMap[f]] || "").trim() : ""; });
      if (!obj.skuName && !obj.skuCode) continue;
      obj.rowIndex = all.length;
      obj.skuQuantity = String(parseInt(obj.skuQuantity) || 0);
      all.push(obj);
    }
  }
  return {
    rows: all,
    headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"],
    mapping: { externalCode:"externalCode",skuCode:"skuCode",skuName:"skuName",skuSpec:"skuSpec",skuQuantity:"skuQuantity",receiverStore:"receiverStore",receiverName:"receiverName",receiverPhone:"receiverPhone",receiverAddress:"receiverAddress",note:"note" },
  };
}

/**
 * 2. 湖南仓发货明细.xlsx
 *    Header at R2, data at R3+
 */
function parseHunan(filePath) {
  const wb = X.readFile(filePath);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const d = X.utils.sheet_to_json(sh, { header: 1 });
  const headerRow = d[2]; // R2
  const colMap = {};
  const fields = ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"];
  headerRow.forEach((h, idx) => {
    const hh = String(h || "").trim();
    if (hh.includes("外部编码")) colMap.externalCode = idx;
    else if (hh.includes("SKU") && hh.includes("编码")) colMap.skuCode = idx;
    else if (hh.includes("SKU") && hh.includes("名称")) colMap.skuName = idx;
    else if (hh.includes("规格")) colMap.skuSpec = idx;
    else if (hh.includes("数量")) colMap.skuQuantity = idx;
    else if (hh.includes("收货") && hh.includes("门店")) colMap.receiverStore = idx;
    else if (hh.includes("收货") && hh.includes("人")) colMap.receiverName = idx;
    else if (hh.includes("电话")) colMap.receiverPhone = idx;
    else if (hh.includes("地址")) colMap.receiverAddress = idx;
    else if (hh.includes("备注")) colMap.note = idx;
  });

  const all = [];
  for (let r = 3; r < d.length; r++) {
    const row = d[r];
    if (!row || !row[0]) continue;
    const obj = {};
    fields.forEach(f => { obj[f] = colMap[f] !== undefined ? String(row[colMap[f]] || "").trim() : ""; });
    if (!obj.skuName && !obj.skuCode) continue;
    obj.rowIndex = all.length;
    obj.skuQuantity = String(parseInt(obj.skuQuantity) || 0);
    all.push(obj);
  }
  return {
    rows: all,
    headers: fields,
    mapping: Object.fromEntries(fields.map(f => [f, f])),
  };
}

/**
 * 3. 欢乐牧场模板.xlsx
 *    Transposed matrix: rows=SKUs, cols=stores with quantity values
 */
function parseHuanle(filePath) {
  const wb = X.readFile(filePath);  
  const sh = wb.Sheets[wb.SheetNames[0]];
  const d = X.utils.sheet_to_json(sh, { header: 1 });
  // R3 = header row: SKU物品编码, SKU物品名称, SKU规格型号, 朝阳门店, 海淀门店, ...
  const headerRow = d[3];
  if (!headerRow) return { rows: [] };

  // Identify store columns (index >= 3, not empty)
  const stores = [];
  for (let i = 3; i < headerRow.length; i++) {
    const h = String(headerRow[i] || "").trim();
    if (h && !h.includes("SKU")) stores.push({ idx: i, name: h });
  }

  const all = [];
  for (let r = 4; r < d.length; r++) {
    const row = d[r];
    if (!row || row[0] === "合计" || !row[0]) continue;
    const skuCode = String(row[0] || "").trim();
    const skuName = String(row[1] || "").trim();
    const skuSpec = String(row[2] || "").trim();
    if (!skuCode && !skuName) continue;

    for (const st of stores) {
      const qty = parseInt(row[st.idx]) || 0;
      if (qty <= 0) continue;
      all.push({
        externalCode: `HL-${st.name}-${skuCode}`,
        skuCode, skuName, skuSpec,
        skuQuantity: String(qty),
        receiverStore: st.name,
        receiverName: "", receiverPhone: "", receiverAddress: "",
        note: "", rowIndex: all.length,
      });
    }
  }

  return {
    rows: all,
    headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore"],
    mapping: { externalCode:"externalCode",skuCode:"skuCode",skuName:"skuName",skuSpec:"skuSpec",skuQuantity:"skuQuantity",receiverStore:"receiverStore" },
  };
}

/**
 * 4. 黎明屯配送发货单.xlsx
 *    Wide form: data row at R6, receiver info at R8-R13
 */
function parseLimingtun(filePath) {
  const wb = X.readFile(filePath);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const d = X.utils.sheet_to_json(sh, { header: 1 });

  // R0 = header row with many fields; R6 = first data row
  const headerRow = d[0];
  if (!headerRow) return { rows: [] };
  
  const colMap = {};
  const fields = ["skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note","externalCode","productionDate","expiryDate","batchNo","warehouse","zone","shelf","deliveryMethod","carrier","expectedArrival","status"];
  headerRow.forEach((h, idx) => {
    const hh = String(h || "").trim();
    if (hh.includes("SKU") && hh.includes("编码")) colMap.skuCode = idx;
    else if (hh.includes("物品名称") || (hh.includes("SKU") && hh.includes("名称"))) colMap.skuName = idx;
    else if (hh.includes("规格")) colMap.skuSpec = idx;
    else if (hh.includes("数量") || hh.includes("发货")) colMap.skuQuantity = idx;
    else if (hh.includes("收货") && hh.includes("门店")) colMap.receiverStore = idx;
    else if (hh.includes("收货") && hh.includes("人") && !hh.includes("门店")) colMap.receiverName = idx;
    else if (hh.includes("电话") || hh.includes("手机")) colMap.receiverPhone = idx;
    else if (hh.includes("地址")) colMap.receiverAddress = idx;
    else if (hh.includes("备注")) colMap.note = idx;
    else if (hh.includes("外部编码") || hh.includes("单据编号")) colMap.externalCode = idx;
    else if (hh.includes("生产日期")) colMap.productionDate = idx;
    else if (hh.includes("保质期") || hh.includes("有效期")) colMap.expiryDate = idx;
    else if (hh.includes("批次")) colMap.batchNo = idx;
    else if (hh.includes("仓库")) colMap.warehouse = idx;
    else if (hh.includes("库区")) colMap.zone = idx;
    else if (hh.includes("货位")) colMap.shelf = idx;
    else if (hh.includes("配送方式") || hh.includes("发货方式")) colMap.deliveryMethod = idx;
    else if (hh.includes("承运商") || hh.includes("物流商")) colMap.carrier = idx;
    else if (hh.includes("预计送达") || hh.includes("预计到达")) colMap.expectedArrival = idx;
    else if (hh.includes("状态")) colMap.status = idx;
  });

  // Extract receiver info from block at R8-R13
  let receiverInfo = {};
  for (let r = 8; r < Math.min(d.length, 14); r++) {
    const row = d[r];
    if (!row) continue;
    const label = String(row[0] || "").trim();
    const value = String(row[1] || "").trim();
    if (label.includes("收货门店") && value) receiverInfo.receiverStore = value;
    if (label.includes("收货人") && value) receiverInfo.receiverName = value;
    if (label.includes("联系") && label.includes("电话") && value) receiverInfo.receiverPhone = value;
    if (label.includes("收货地址") && value) receiverInfo.receiverAddress = value;
    if (label.includes("备注") && value) receiverInfo.note = value;
  }

  const all = [];
  for (let r = 6; r < d.length; r++) {
    const row = d[r];
    if (!row || (row[0] === "收货信息")) break;
    const obj = { rowIndex: all.length };
    // Extract from column mapping
    Object.keys(colMap).forEach(f => {
      obj[f] = colMap[f] !== undefined ? String(row[colMap[f]] || "").trim() : "";
    });
    // Fallback: if skuName is empty, try other positions
    if (!obj.skuName) {
      for (let c = 0; c < row.length; c++) {
        const v = String(row[c] || "").trim();
        if (/^[\u4e00-\u9fa5]{2,}/.test(v) && !obj.skuName) obj.skuName = v;
      }
    }
    if (!obj.skuName && !obj.skuCode) continue;
    // Fill receiver info from block
    if (receiverInfo.receiverStore && !obj.receiverStore) obj.receiverStore = receiverInfo.receiverStore;
    if (receiverInfo.receiverName && !obj.receiverName) obj.receiverName = receiverInfo.receiverName;
    if (receiverInfo.receiverPhone && !obj.receiverPhone) obj.receiverPhone = receiverInfo.receiverPhone;
    if (receiverInfo.receiverAddress && !obj.receiverAddress) obj.receiverAddress = receiverInfo.receiverAddress;
    
    obj.skuQuantity = String(parseInt(obj.skuQuantity) || 0);
    all.push(obj);
  }

  const outHeaders = ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"];

  return {
    rows: all,
    headers: outHeaders,
    mapping: Object.fromEntries(outHeaders.map(f => [f, f])),
  };
}

/**
 * 5. 门店调拨单（卡片式）.xlsx
 *    Card-style: each 【调拨记录N】 is a card
 */
function parseCard(filePath) {
  const wb = X.readFile(filePath);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const d = X.utils.sheet_to_json(sh, { header: 1 });

  const all = [];
  let currentCard = null;
  let inItems = false;

  for (let r = 0; r < d.length; r++) {
    const row = d[r];
    if (!row) continue;

    const first = String(row[0] || "").trim();

    // Detect card header
    if (first.startsWith("【调拨记录")) {
      currentCard = { externalCode: first.replace(/[【】]/g, ""), receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "", note: "", items: [] };
      inItems = false;
      continue;
    }

    if (!currentCard) continue;

    // Card metadata rows
    for (let c = 0; c < row.length; c += 2) {
      if (c + 1 >= row.length) continue;
      const k = String(row[c] || "").trim();
      const v = String(row[c + 1] || "").trim();
      if (!k || !v) continue;
      if (k.includes("调出仓库")) { /* skip */ }
      else if (k.includes("调入") || k.includes("门店")) currentCard.receiverStore = v;
      else if (k.includes("收货人")) currentCard.receiverName = v;
      else if (k.includes("联系") && k.includes("电话")) currentCard.receiverPhone = v;
      else if (k.includes("收货地址")) currentCard.receiverAddress = v;
      else if (k.includes("备注")) currentCard.note = v;
    }

    // Item header row
    if (first === "序号" || first === "物品明细：") { inItems = true; continue; }
    if (first === "物品明细") { inItems = true; continue; }

    // Item data row
    if (inItems && /^\d+$/.test(first)) {
      const skuCode = String(row[1] || "").trim();
      const skuName = String(row[2] || "").trim();
      const skuSpec = String(row[3] || "").trim();
      const skuQuantity = parseInt(row[4]) || 0;
      if (skuCode || skuName) {
        currentCard.items.push({ skuCode, skuName, skuSpec, skuQuantity });
      }
    }

    // End of card (empty row after items)
    if (inItems && first === "" && row.every(c => !c)) {
      // Check if the next card is coming or end of file
      if (currentCard.items.length > 0) {
        currentCard.items.forEach(item => {
          all.push({
            externalCode: currentCard.externalCode || "",
            skuCode: item.skuCode,
            skuName: item.skuName,
            skuSpec: item.skuSpec,
            skuQuantity: String(item.skuQuantity),
            receiverStore: currentCard.receiverStore,
            receiverName: currentCard.receiverName,
            receiverPhone: currentCard.receiverPhone,
            receiverAddress: currentCard.receiverAddress,
            note: currentCard.note,
            rowIndex: all.length,
          });
        });
      }
      currentCard = null;
      inItems = false;
    }
  }

  // Last card if not processed
  if (currentCard && currentCard.items.length > 0) {
    currentCard.items.forEach(item => {
      all.push({
        externalCode: currentCard.externalCode || "",
        skuCode: item.skuCode, skuName: item.skuName, skuSpec: item.skuSpec,
        skuQuantity: String(item.skuQuantity),
        receiverStore: currentCard.receiverStore,
        receiverName: currentCard.receiverName,
        receiverPhone: currentCard.receiverPhone,
        receiverAddress: currentCard.receiverAddress,
        note: currentCard.note,
        rowIndex: all.length,
      });
    });
  }

  return {
    rows: all,
    headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"],
    mapping: Object.fromEntries(["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"].map(f=>[f,f])),
  };
}

/**
 * 6. 门店配送确认单.txt
 *    Multiple shipments separated by "---"
 */
function parseDeliveryConfirm(text) {
  const blocks = text.split(/\n-{20,}\n/);
  const all = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    const ship = { externalCode: "", receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "", note: "", items: [] };
    let section = "";
    for (const line of lines) {
      if (line.startsWith("单据编号")) { ship.externalCode = line.replace("单据编号：", "").trim(); continue; }
      if (line === "收货信息：") { section = "receiver"; continue; }
      if (line === "物品明细：") { section = "items"; continue; }
      if (line === "配送信息：" || line.startsWith("配送方式") || line.startsWith("承运商") || line.startsWith("物流单号") || line.startsWith("预计送达")) { section = ""; continue; }
      if (line.startsWith("备注：")) { ship.note = line.replace("备注：", "").trim(); continue; }
      if (section === "receiver") {
        if (line.startsWith("收货门店：")) ship.receiverStore = line.replace("收货门店：", "").trim();
        if (line.startsWith("收货人姓名：")) ship.receiverName = line.replace("收货人姓名：", "").trim();
        if (line.startsWith("联系电话：")) ship.receiverPhone = line.replace("联系电话：", "").trim();
        if (line.startsWith("收货地址：")) ship.receiverAddress = line.replace("收货地址：", "").trim();
        continue;
      }
      if (section === "items") {
        // "1. SKU001 农夫山泉矿泉水 550ml*24 数量：10箱"
        let m = line.match(/^\d+\.\s*(SKU\d+)\s+(.+?)\s+(.+?\S)\s+数量[：:]\s*(\d+)/i);
        if (m) {
          ship.items.push({ skuCode: m[1], skuName: m[2].trim(), skuSpec: m[3].trim(), skuQuantity: parseInt(m[4], 10) });
        }
      }
    }
    if (ship.items.length > 0) {
      ship.items.forEach(item => {
        all.push({
          externalCode: ship.externalCode,
          skuCode: item.skuCode, skuName: item.skuName, skuSpec: item.skuSpec,
          skuQuantity: String(item.skuQuantity),
          receiverStore: ship.receiverStore,
          receiverName: ship.receiverName,
          receiverPhone: ship.receiverPhone,
          receiverAddress: ship.receiverAddress,
          note: ship.note,
          rowIndex: all.length,
        });
      });
    }
  }
  return all;
}

/**
 * 7. 配送签收单（多单）.txt
 *    Multiple shipments with 【签收单N】 markers
 */
function parseSignConfirm(text) {
  const blocks = text.split(/【签收单\d+】/).filter(s => s.trim());
  const all = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    const ship = { externalCode: "", receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "", note: "", items: [] };
    let section = "";
    for (const line of lines) {
      if (line.startsWith("单据编号")) { ship.externalCode = line.replace("单据编号：", "").trim(); continue; }
      if (line.startsWith("配送日期")) continue;
      if (line === "收货信息：") { section = "receiver"; continue; }
      if (line === "物品明细：") { section = "items"; continue; }
      if (line === "签收信息：" || line.startsWith("签收人") || line.startsWith("签收时间") || line.startsWith("签收状态")) { section = ""; continue; }
      if (section === "receiver") {
        if (line.startsWith("收货门店：")) ship.receiverStore = line.replace("收货门店：", "").trim();
        if (line.startsWith("收货人姓名：")) ship.receiverName = line.replace("收货人姓名：", "").trim();
        if (line.startsWith("联系电话：")) ship.receiverPhone = line.replace("联系电话：", "").trim();
        if (line.startsWith("收货地址：")) ship.receiverAddress = line.replace("收货地址：", "").trim();
        continue;
      }
      if (section === "items") {
        // "SKU001 农夫山泉矿泉水 550ml*24 x10"
        let m = line.match(/(SKU\d+)\s+(.+?)\s+(.+?\S)\s+[xX×](\d+)/i);
        if (m) {
          ship.items.push({ skuCode: m[1], skuName: m[2].trim(), skuSpec: m[3].trim(), skuQuantity: parseInt(m[4], 10) });
        }
      }
    }
    if (ship.items.length > 0) {
      ship.items.forEach(item => {
        all.push({
          externalCode: ship.externalCode,
          skuCode: item.skuCode, skuName: item.skuName, skuSpec: item.skuSpec,
          skuQuantity: String(item.skuQuantity),
          receiverStore: ship.receiverStore,
          receiverName: ship.receiverName,
          receiverPhone: ship.receiverPhone,
          receiverAddress: ship.receiverAddress,
          note: ship.note,
          rowIndex: all.length,
        });
      });
    }
  }
  return all;
}

/**
 * 8. 黔寨寨配送单.txt
 *    Two shipments separated by "====..." and "第二页"
 */
function parseQianZhaiZhai(text) {
  // Split by long delimiter
  const blocks = text.split(/\n=+\n/).filter(s => s.trim() && !s.includes("配送签收单"));
  const all = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    const ship = { externalCode: "", receiverStore: "", receiverName: "", receiverPhone: "", receiverAddress: "", note: "", items: [] };
    let section = "";
    for (const line of lines) {
      if (line === "黔寨寨配送单" || line === "第二页") continue;
      if (line.startsWith("单据编号：")) { ship.externalCode = line.replace("单据编号：", "").trim(); continue; }
      if (line.startsWith("配送日期：")) continue;
      if (line === "收货信息：") { section = "receiver"; continue; }
      if (line === "物品明细：") { section = "items"; continue; }
      if (line === "配送信息：") { section = "delivery"; continue; }
      if (line.startsWith("备注：")) { ship.note = line.replace("备注：", "").trim(); continue; }
      if (line.startsWith("合计") || line.startsWith("配送方式") || line.startsWith("承运商") || line.startsWith("物流单号") || line.startsWith("预计送达")) continue;
      if (section === "receiver") {
        if (line.startsWith("收货门店：")) ship.receiverStore = line.replace("收货门店：", "").trim();
        if (line.startsWith("收货人姓名：")) ship.receiverName = line.replace("收货人姓名：", "").trim();
        if (line.startsWith("联系电话：")) ship.receiverPhone = line.replace("联系电话：", "").trim();
        if (line.startsWith("收货地址：")) ship.receiverAddress = line.replace("收货地址：", "").trim();
        continue;
      }
      if (section === "items") {
        // "1     SKU001       农夫山泉矿泉水      550ml*24       10"
        let m = line.match(/^\d+\s+(SKU\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(\d+)/i);
        if (m) {
          ship.items.push({ skuCode: m[1], skuName: m[2].trim(), skuSpec: m[3].trim(), skuQuantity: parseInt(m[4], 10) });
        }
      }
    }
    if (ship.items.length > 0) {
      ship.items.forEach(item => {
        all.push({
          externalCode: ship.externalCode,
          skuCode: item.skuCode, skuName: item.skuName, skuSpec: item.skuSpec,
          skuQuantity: String(item.skuQuantity),
          receiverStore: ship.receiverStore,
          receiverName: ship.receiverName,
          receiverPhone: ship.receiverPhone,
          receiverAddress: ship.receiverAddress,
          note: ship.note,
          rowIndex: all.length,
        });
      });
    }
  }
  return all;
}

/**
 * 9. 周配送计划.xlsx
 *    Matrix: rows=stores, cols=dates, cells="品名x数量\n品名x数量"
 */
function parseWeeklyPlan(filePath) {
  const wb = X.readFile(filePath);
  const sh = wb.Sheets[wb.SheetNames[0]];
  const d = X.utils.sheet_to_json(sh, { header: 1 });
  // R3 = header: 收货门店, 12月2日（周一）, ...
  const dateHeaders = [];
  const headerRow = d[3];
  if (!headerRow) return { rows: [] };
  for (let i = 1; i < headerRow.length; i++) {
    const h = String(headerRow[i] || "").trim();
    if (h && h.includes("月") && h.includes("日")) dateHeaders.push({ col: i, label: h });
  }

  const all = [];
  for (let r = 4; r < d.length; r++) {
    const row = d[r];
    const storeName = String(row[0] || "").trim();
    if (!storeName || storeName.startsWith("备注")) continue;
    for (const dh of dateHeaders) {
      const cell = String(row[dh.col] || "").trim();
      if (!cell) continue;
      // Split multi-line items
      const items = cell.split("\n").map(s => s.trim()).filter(Boolean);
      for (const item of items) {
        const m = item.match(/^(.+?)[xX×](\d+)/);
        if (!m) continue;
        all.push({
          externalCode: `W-${storeName}-${dh.label}`,
          skuCode: "",
          skuName: m[1].trim(),
          skuSpec: "",
          skuQuantity: String(parseInt(m[2], 10)),
          receiverStore: storeName,
          receiverName: "",
          receiverPhone: "",
          receiverAddress: "",
          note: dh.label,
          rowIndex: all.length,
        });
      }
    }
  }
  return {
    rows: all,
    headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","note"],
    mapping: { externalCode:"externalCode",skuCode:"skuCode",skuName:"skuName",skuSpec:"skuSpec",skuQuantity:"skuQuantity",receiverStore:"receiverStore",note:"note" },
  };
}

// ======================== Main Processor ========================

async function processFile(fileName, parseResult, sheetName) {
  const baseName = basename(fileName, extname(fileName));
  const isTxt = fileName.endsWith(".txt");
  const fileType = isTxt ? "excel" : "excel"; // All use excel type in our system

  const { rows, headers, mapping } = parseResult;
  if (!rows || rows.length === 0) {
    console.log(`    ⚠ 解析无数据，跳过`);
    return { file: baseName, rows: 0, ok: false };
  }

  // Rule dedup: check by baseName prefix
  const ruleName = baseName + " " + new Date().toLocaleDateString("zh-CN");
  const ruleDsl = {
    fileType: "excel",
    mode: "structured",
    mapping,
    transforms: [{ type: "group_by_external_code", enabled: true }],
  };

  const ruleId = await ensureRule(ruleName, sheetName || "Sheet1", headers, mapping, fileType, ruleDsl);

  // Submit shipment
  const batchName = `${baseName} ${TS}`;
  const res = await submitShipment(batchName, fileName, fileType, sheetName || "Sheet1", headers, rows, mapping, ruleId);
  return { file: baseName, rows: rows.length, ok: res.ok };
}

// ======================== MAIN ========================

async function main() {
  console.log("=".repeat(60));
  console.log("🚀 9 文件完整导入 - 本地解析 + 规则去重");
  console.log("=".repeat(60));

  // Check server
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(BASE + "/api/universal-import/templates?take=1", (res) => {
        res.statusCode === 200 ? resolve() : reject(new Error("" + res.statusCode));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
    console.log("✅ 服务器在线\n");
  } catch {
    console.log("❌ 服务器未运行！请先 npx next start -p 3000");
    process.exit(1);
  }

  // Load existing rules for dedup
  await getExistingRules();
  console.log(`📋 已有 ${ruleCache.length} 条规则，将按文件名去重\n`);

  const now = new Date().toLocaleDateString("zh-CN");
  const stats = { total: 0, success: 0, fail: 0, totalRows: 0 };

  const tasks = [
    // Excel files - parsed locally
    { file: "多门店分Sheet出库单.xlsx", fn: () => parseMultiSheet(join(DEMOS, "多门店分Sheet出库单.xlsx")), sheet: "多门店" },
    { file: "湖南仓发货明细.xlsx", fn: () => parseHunan(join(DEMOS, "湖南仓发货明细.xlsx")), sheet: "发货明细" },
    { file: "欢乐牧场模板.xlsx", fn: () => parseHuanle(join(DEMOS, "欢乐牧场模板.xlsx")), sheet: "门店配送" },
    { file: "黎明屯配送发货单.xlsx", fn: () => parseLimingtun(join(DEMOS, "黎明屯配送发货单.xlsx")), sheet: "Sheet1" },
    { file: "门店调拨单（卡片式）.xlsx", fn: () => parseCard(join(DEMOS, "门店调拨单（卡片式）.xlsx")), sheet: "调拨单" },
    { file: "周配送计划.xlsx", fn: () => parseWeeklyPlan(join(DEMOS, "周配送计划.xlsx")), sheet: "周配送计划" },
    // Text files - parsed locally
    { file: "门店配送确认单.txt", fn: () => {
      const txt = readFileSync(join(DEMOS, "门店配送确认单.txt"), "utf-8");
      const rows = parseDeliveryConfirm(txt);
      return { rows, headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"], mapping: Object.fromEntries(["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"].map(f=>[f,f])) };
    }, sheet: "门店配送确认单" },
    { file: "配送签收单（多单）.txt", fn: () => {
      const txt = readFileSync(join(DEMOS, "配送签收单（多单）.txt"), "utf-8");
      const rows = parseSignConfirm(txt);
      return { rows, headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"], mapping: Object.fromEntries(["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"].map(f=>[f,f])) };
    }, sheet: "配送签收单" },
    { file: "黔寨寨配送单.txt", fn: () => {
      const txt = readFileSync(join(DEMOS, "黔寨寨配送单.txt"), "utf-8");
      const rows = parseQianZhaiZhai(txt);
      return { rows, headers: ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"], mapping: Object.fromEntries(["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"].map(f=>[f,f])) };
    }, sheet: "黔寨寨配送单" },
  ];

  for (const task of tasks) {
    stats.total++;
    console.log(`\n📄 [${stats.total}/9] ${task.file}`);
    try {
      const start = Date.now();
      const parsed = task.fn();
      console.log(`    📊 本地解析: ${parsed.rows.length} 行 (${Date.now() - start}ms)`);
      const result = await processFile(task.file, parsed, task.sheet);
      if (result.ok) {
        stats.success++;
        stats.totalRows += result.rows;
      } else {
        stats.fail++;
      }
    } catch (e) {
      console.log(`    ❌ 异常: ${e.message}`);
      stats.fail++;
    }
    await sleep(300);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 导入完成");
  console.log("=".repeat(60));
  console.log(`  文件: ${stats.total} | 成功: ${stats.success} | 失败: ${stats.fail} | 总行数: ${stats.totalRows}`);

  // Show final rule count
  const finalRules = await getJSON("/api/universal-import/templates?take=200");
  const activeRules = (finalRules.templates || []).filter(t => t.status === "ACTIVE");
  const uniqueNames = new Set(activeRules.map(r => {
    const base = r.ruleName.split(" ")[0];
    return base;
  }));
  console.log(`  活跃规则总数: ${activeRules.length} | 唯一规则: ${uniqueNames.size}`);
  if (uniqueNames.size < activeRules.length) {
    console.log(`  ⚠ 仍存在 ${activeRules.length - uniqueNames.size} 条重复规则`);
  }

  // Clean up inspection files
  const fs = require("fs");
  try { fs.unlinkSync(join(__dirname, "_inspect_files.cjs")); } catch {}
  try { fs.unlinkSync(join(__dirname, "_inspect2.cjs")); } catch {}
}

main().catch(e => { console.error("💥", e); process.exit(1); });
