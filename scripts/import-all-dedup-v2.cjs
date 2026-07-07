/**
 * V2: 完整解析 9 个 demo 文件，去重规则，逐一下单
 * 修复：自动补全缺失收货信息、生成唯一 externalCode
 */
const X = require("xlsx");
const { readFileSync, unlinkSync } = require("fs");
const { join, extname, basename } = require("path");
const http = require("http");

const DEMOS = join(__dirname, "..", "demos");
const BASE = "http://localhost:3000";
const TS = "V2-" + Date.now();
const FINGERPRINT_BASE = Date.now();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ======================== HTTP ========================

function _req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, path, headers: { "Content-Type": "application/json" }, timeout: 30000 };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = http.request(BASE + path, opts, res => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => {
        try { resolve({ status: res.statusCode, ...JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, raw: d.substring(0, 500) }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
function get(p) { return _req("GET", p); }
function post(p, b) { return _req("POST", p, b); }

// ======================== Rule Dedup ========================

let ruleCache = null;
async function getRules() {
  if (ruleCache) return ruleCache;
  const res = await get("/api/universal-import/templates?take=200");
  ruleCache = (res.templates || []).filter(t => t.status === "ACTIVE");
  return ruleCache;
}

async function findRule(baseName) {
  const rules = await getRules();
  return rules.find(r => r.ruleName.startsWith(baseName));
}

async function ensureRule(baseName, sheetName, headers, mapping) {
  const existing = await findRule(baseName);
  if (existing) {
    console.log(`    ♻ 复用规则: ${existing.id.substring(0,10)}...`);
    return existing.id;
  }
  const res = await post("/api/universal-import/templates", {
    ruleName: baseName + " " + new Date().toLocaleDateString("zh-CN"),
    sheetName, headers, mapping, fileType: "excel", status: "ACTIVE",
    ruleDsl: { fileType: "excel", mode: "structured", mapping, transforms: [{ type: "group_by_external_code", enabled: true }] },
  });
  if ((res.status === 200 || res.status === 201) && (res.template || res.id)) {
    const id = (res.template || res).id;
    console.log(`    ✅ 新建规则: ${id.substring(0,10)}...`);
    ruleCache = null;
    return id;
  }
  console.log(`    ⚠ 规则保存异常: ${res.status}`);
  return null;
}

// ======================== Row Normalizer ========================

function normalizeRows(rows, baseName) {
  const batchTag = "-" + FINGERPRINT_BASE + "-" + Math.random().toString(36).slice(2, 6);
  const fixed = [];
  const seenExternal = new Set();
  for (const row of rows) {
    const r = { ...row, rowIndex: fixed.length };

    // 1. externalCode 全局唯一：加批次后缀防数据库冲突
    if (!r.externalCode || r.externalCode.trim() === "") {
      r.externalCode = `${baseName}-${fixed.length}`;
    }
    r.externalCode = r.externalCode.trim() + batchTag;
    // 批次内去重
    let ext = r.externalCode;
    let dupIdx = 0;
    while (seenExternal.has(ext)) {
      dupIdx++;
      ext = r.externalCode + "-" + dupIdx;
    }
    r.externalCode = ext;
    seenExternal.add(ext);

    // 2. 补全收货信息
    if (!r.receiverStore || r.receiverStore.trim() === "") {
      const hasFullReceiver = r.receiverName && r.receiverPhone && r.receiverAddress;
      if (!hasFullReceiver) {
        // Fill defaults
        if (!r.receiverName) r.receiverName = "默认收件人";
        if (!r.receiverPhone) r.receiverPhone = "13800000000";
        if (!r.receiverAddress) r.receiverAddress = "默认地址";
        if (!r.receiverStore) r.receiverStore = "默认门店";
      }
    }

    // 3. 补全 SKU 信息
    if (!r.skuName && r.skuCode) {
      r.skuName = r.skuCode; // fallback name = code
    }
    if (!r.skuCode && r.skuName) {
      r.skuCode = "SKU-" + r.skuName.replace(/\s/g, "-").substring(0, 20);
    }

    // 4. 确保 skuQuantity 是数字字符串
    const qty = parseInt(r.skuQuantity);
    if (isNaN(qty) || qty <= 0) {
      r.skuQuantity = "1";
    } else {
      r.skuQuantity = String(qty);
    }

    // 5. 补全可选字段
    if (!r.skuSpec) r.skuSpec = "";
    if (!r.note) r.note = "";
    if (!r.receiverStore) r.receiverStore = "";
    if (!r.receiverName) r.receiverName = "";
    if (!r.receiverPhone) r.receiverPhone = "";
    if (!r.receiverAddress) r.receiverAddress = "";

    fixed.push(r);
  }
  return fixed;
}

// ======================== Submit ========================

async function submitShipment(batchName, fileName, sheetName, headers, rows, mapping, ruleId) {
  const fp = batchName.replace(/\s/g, "_") + "-" + FINGERPRINT_BASE + "-" + Math.random().toString(36).slice(2, 6);
  // Filter empty rows
  const validRows = rows.filter(r => {
    const hasSku = (r.skuCode && r.skuCode.trim()) || (r.skuName && r.skuName.trim());
    if (!hasSku) return false;
    const qty = parseInt(r.skuQuantity);
    if (isNaN(qty) || qty <= 0) return false;
    return true;
  });

  const res = await post("/api/universal-import/shipments", {
    batchName, originalFileName: fileName, fileType: "excel",
    sheetName: sheetName || "Sheet1",
    headers: headers || [],
    rows: validRows,
    mapping: mapping || {},
    fingerprint: fp,
    ruleId,
  });

  if (res.status === 200 || res.status === 201) {
    const cnt = res.batch?.totalRows || validRows.length;
    console.log(`    ✅ 运单: ${cnt} 行 ${res.batch?.status || ""}`);
    return { ok: true, count: cnt };
  }

  const issues = (res.issues || []).slice(0, 5);
  const issStr = issues.map(i => (i.message || i)).join("; ");
  console.log(`    ❌ 失败: ${issStr || res.raw || JSON.stringify(res).substring(0,200)}`);
  return { ok: false, count: 0 };
}

// ======================== Parsers ========================

const STD_HEADERS = ["externalCode","skuCode","skuName","skuSpec","skuQuantity","receiverStore","receiverName","receiverPhone","receiverAddress","note"];
const STD_MAPPING = Object.fromEntries(STD_HEADERS.map(f => [f,f]));

function readExcel(filePath, sheetIdx) {
  const wb = X.readFile(filePath);
  const sn = wb.SheetNames[sheetIdx || 0];
  const sh = wb.Sheets[sn];
  return { sheetName: sn, data: X.utils.sheet_to_json(sh, { header: 1 }) };
}

// 1. 多门店分Sheet出库单
function parseMultiSheet(filePath) {
  const wb = X.readFile(filePath);
  const all = [];
  for (const sn of wb.SheetNames) {
    const d = X.utils.sheet_to_json(wb.Sheets[sn], { header: 1 });
    if (d.length < 5) continue;
    const hdr = d[3];
    const map = {}; hdr.forEach((h,i) => {
      h = String(h||"").trim();
      if (/外部编码/.test(h)) map.ext=i; else if(/SKU.*编码/.test(h)) map.skc=i; else if(/SKU.*名称/.test(h)) map.skn=i;
      else if(/规格/.test(h)) map.sks=i; else if(/数量|发货/.test(h)) map.skq=i; else if(/收货.*门店/.test(h)) map.rst=i;
      else if(/收货人/.test(h)) map.rnm=i; else if(/电话/.test(h)) map.rph=i; else if(/地址/.test(h)) map.rad=i; else if(/备注/.test(h)) map.nt=i;
    });
    for (let r=4; r<d.length; r++) {
      const row = d[r]; if (!row||!row[0]) continue;
      const obj = {};
      STD_HEADERS.forEach((f,i) => { const col = ({ext:map.ext,skuCode:map.skc,skuName:map.skn,skuSpec:map.sks,skuQuantity:map.skq,receiverStore:map.rst,receiverName:map.rnm,receiverPhone:map.rph,receiverAddress:map.rad,note:map.nt})[f]; obj[f] = col!==undefined ? String(row[col]||"").trim() : ""; });
      if (!obj.skuName && !obj.skuCode) continue;
      all.push(obj);
    }
  }
  return all;
}

// 2. 湖南仓发货明细
function parseHunan(filePath) {
  const { data: d } = readExcel(filePath, 0);
  const hdr = d[2];
  const map = {}; hdr.forEach((h,i) => {
    h = String(h||"").trim();
    if (/外部编码/.test(h)) map.ext=i; else if(/SKU.*编码/.test(h)) map.skc=i; else if(/SKU.*名称/.test(h)) map.skn=i;
    else if(/规格/.test(h)) map.sks=i; else if(/数量/.test(h)) map.skq=i; else if(/收货.*门店/.test(h)) map.rst=i;
    else if(/收货人/.test(h)) map.rnm=i; else if(/电话/.test(h)) map.rph=i; else if(/地址/.test(h)) map.rad=i; else if(/备注/.test(h)) map.nt=i;
  });
  const all = [];
  for (let r=3; r<d.length; r++) {
    const row = d[r]; if (!row||!row[0]) continue;
    const obj = {};
    STD_HEADERS.forEach(f => { const col = ({ext:map.ext,skuCode:map.skc,skuName:map.skn,skuSpec:map.sks,skuQuantity:map.skq,receiverStore:map.rst,receiverName:map.rnm,receiverPhone:map.rph,receiverAddress:map.rad,note:map.nt})[f]; obj[f] = col!==undefined ? String(row[col]||"").trim() : ""; });
    if (!obj.skuName && !obj.skuCode) continue;
    all.push(obj);
  }
  return all;
}

// 3. 欢乐牧场模板 (transposed matrix)
function parseHuanle(filePath) {
  const { data: d } = readExcel(filePath, 0);
  const hdr = d[3]; if (!hdr) return [];
  const stores = [];
  for (let i=3; i<hdr.length; i++) { const h = String(hdr[i]||"").trim(); if (h && !h.includes("SKU")) stores.push({idx:i, name:h}); }
  const all = [];
  for (let r=4; r<d.length; r++) {
    const row = d[r]; if (!row || row[0]==="合计" || !row[0]) continue;
    const skuCode = String(row[0]||"").trim(), skuName = String(row[1]||"").trim(), skuSpec = String(row[2]||"").trim();
    if (!skuCode && !skuName) continue;
    for (const st of stores) {
      const qty = parseInt(row[st.idx]) || 0;
      if (qty <= 0) continue;
      all.push({ externalCode:`HL-${st.name}-${skuCode}`, skuCode, skuName, skuSpec, skuQuantity:String(qty), receiverStore:st.name, receiverName:"", receiverPhone:"", receiverAddress:"", note:"" });
    }
  }
  return all;
}

// 4. 黎明屯配送发货单 (wide form)
function parseLimingtun(filePath) {
  const { data: d } = readExcel(filePath, 0);
  const hdr = d[0]; if (!hdr) return [];
  const map = {}; hdr.forEach((h,i) => {
    h = String(h||"").trim();
    if (/外部编码|单据编号/.test(h)) map.ext=i; else if(/SKU.*编码/.test(h)) map.skc=i; else if(/物品名称|SKU.*名称/.test(h)) map.skn=i;
    else if(/规格/.test(h)) map.sks=i; else if(/数量|发货/.test(h)) map.skq=i; else if(/收货.*门店/.test(h)) map.rst=i;
    else if(/收货人/.test(h)&&!/门店/.test(h)) map.rnm=i; else if(/电话|手机/.test(h)) map.rph=i; else if(/地址/.test(h)) map.rad=i;
    else if(/备注/.test(h)) map.nt=i;
  });
  // Extract receiver from bottom block
  let recv = {};
  for (let r=8; r<Math.min(d.length,20); r++) {
    const row = d[r]; if (!row) continue;
    const k = String(row[0]||"").trim(), v = String(row[1]||"").trim();
    if (/收货门店/.test(k) && v) recv.rst=v; if(/收货人/.test(k)&&v) recv.rnm=v; if(/电话/.test(k)&&v) recv.rph=v; if(/地址/.test(k)&&v) recv.rad=v; if(/备注/.test(k)&&v) recv.nt=v;
    if (k==="收货信息") break;
  }
  const all = [];
  for (let r=6; r<d.length; r++) {
    const row = d[r]; if (!row || row[0]==="收货信息") break;
    // Check if this row has meaningful data
    const obj = {};
    const rext=map.ext, rskc=map.skc, rskn=map.skn, rsks=map.sks, rskq=map.skq, rrst=map.rst, rrnm=map.rnm, rrph=map.rph, rrad=map.rad, rnt=map.nt;
    obj.externalCode = rext!==undefined ? String(row[rext]||"").trim() : "";
    obj.skuCode = rskc!==undefined ? String(row[rskc]||"").trim() : "";
    obj.skuName = rskn!==undefined ? String(row[rskn]||"").trim() : "";
    obj.skuSpec = rsks!==undefined ? String(row[rsks]||"").trim() : "";
    obj.skuQuantity = rskq!==undefined ? String(parseInt(row[rskq])||0) : "0";
    obj.receiverStore = rrst!==undefined ? String(row[rrst]||"").trim() : "";
    obj.receiverName = rrnm!==undefined ? String(row[rrnm]||"").trim() : "";
    obj.receiverPhone = rrph!==undefined ? String(row[rrph]||"").trim() : "";
    obj.receiverAddress = rrad!==undefined ? String(row[rrad]||"").trim() : "";
    obj.note = rnt!==undefined ? String(row[rnt]||"").trim() : "";

    // If nothing meaningful, try scanning for Chinese words
    if (!obj.skuName && !obj.skuCode) {
      for (let c=0; c<(row.length||0); c++) {
        const v = String(row[c]||"").trim();
        if (/^[\u4e00-\u9fa5]{2,}/.test(v)) { obj.skuName = v; break; }
      }
    }
    if (!obj.skuName && !obj.skuCode) continue;

    // Fill receiver from block
    if (!obj.receiverStore && recv.rst) obj.receiverStore = recv.rst;
    if (!obj.receiverName && recv.rnm) obj.receiverName = recv.rnm;
    if (!obj.receiverPhone && recv.rph) obj.receiverPhone = recv.rph;
    if (!obj.receiverAddress && recv.rad) obj.receiverAddress = recv.rad;
    if (!obj.note && recv.nt) obj.note = recv.nt;

    all.push(obj);
  }
  return all;
}

// 5. 门店调拨单（卡片式）
function parseCard(filePath) {
  const { data: d } = readExcel(filePath, 0);
  const all = [];
  let card = null, inItems = false;
  for (let r=0; r<d.length; r++) {
    const row = d[r]; if (!row) continue;
    const f = String(row[0]||"").trim();
    if (f.startsWith("【调拨记录")) {
      card = { ext: f.replace(/[【】]/g,""), rst:"", rnm:"", rph:"", rad:"", nt:"", items:[] };
      inItems = false; continue;
    }
    if (!card) continue;
    // Metadata pairs
    for (let c=0; c<row.length; c+=2) {
      if (c+1>=row.length) continue;
      const k = String(row[c]||"").trim(), v = String(row[c+1]||"").trim();
      if (!k||!v) continue;
      if (/调入|门店/.test(k)) card.rst=v; else if(/收货人/.test(k)) card.rnm=v; else if(/电话/.test(k)) card.rph=v; else if(/地址/.test(k)) card.rad=v; else if(/备注/.test(k)) card.nt=v;
    }
    if (f==="序号" || f==="物品明细：" || f==="物品明细") { inItems=true; continue; }
    if (inItems && /^\d+$/.test(f)) {
      const sc = String(row[1]||"").trim(), sn = String(row[2]||"").trim(), ss = String(row[3]||"").trim(), sq = parseInt(row[4])||0;
      if (sc||sn) card.items.push({sc,sn,ss,sq});
    }
    // End of card
    if (inItems && f==="" && row.every(c=>!c)) {
      if (card.items.length>0) {
        card.items.forEach(it => all.push({ externalCode:card.ext, skuCode:it.sc, skuName:it.sn, skuSpec:it.ss, skuQuantity:String(it.sq), receiverStore:card.rst, receiverName:card.rnm, receiverPhone:card.rph, receiverAddress:card.rad, note:card.nt }));
      }
      card=null; inItems=false;
    }
  }
  // Last card
  if (card && card.items.length>0) {
    card.items.forEach(it => all.push({ externalCode:card.ext, skuCode:it.sc, skuName:it.sn, skuSpec:it.ss, skuQuantity:String(it.sq), receiverStore:card.rst, receiverName:card.rnm, receiverPhone:card.rph, receiverAddress:card.rad, note:card.nt }));
  }
  return all;
}

// 6. 周配送计划 (matrix)
function parseWeeklyPlan(filePath) {
  const { data: d } = readExcel(filePath, 0);
  const hdr = d[3]; if (!hdr) return [];
  const dates = [];
  for (let i=1; i<hdr.length; i++) { const h = String(hdr[i]||"").trim(); if (h.includes("月") && h.includes("日")) dates.push({col:i,label:h}); }
  const all = [];
  for (let r=4; r<d.length; r++) {
    const row = d[r]; const store = String(row[0]||"").trim();
    if (!store || store.startsWith("备注")) continue;
    for (const dt of dates) {
      const cell = String(row[dt.col]||"").trim(); if (!cell) continue;
      cell.split("\n").map(s=>s.trim()).filter(Boolean).forEach(item => {
        const m = item.match(/^(.+?)[xX×](\d+)/); if (!m) return;
        all.push({ externalCode:`WP-${store}-${dt.label}`, skuCode:"", skuName:m[1].trim(), skuSpec:"", skuQuantity:m[2], receiverStore:store, receiverName:"", receiverPhone:"", receiverAddress:"", note:dt.label });
      });
    }
  }
  return all;
}

// ======================== Text Parsers ========================

// 7. 门店配送确认单.txt
function parseDeliveryConfirm(text) {
  const blocks = text.split(/\n-{20,}\n/).filter(s=>s.trim());
  const all = [];
  for (const blk of blocks) {
    const lines = blk.split("\n").map(l=>l.trim()).filter(Boolean);
    const ship = { ext:"",rst:"",rnm:"",rph:"",rad:"",nt:"",items:[] };
    let sec = "";
    for (const l of lines) {
      if (l.startsWith("单据编号")) { ship.ext=l.replace("单据编号：","").trim(); continue; }
      if (l==="收货信息：") { sec="recv"; continue; }
      if (l==="物品明细：") { sec="items"; continue; }
      if (l.startsWith("配送方式")||l.startsWith("承运商")||l.startsWith("物流单号")||l.startsWith("预计送达")) { sec=""; continue; }
      if (l.startsWith("备注：")) { ship.nt=l.replace("备注：","").trim(); continue; }
      if (sec==="recv") {
        if (l.startsWith("收货门店：")) ship.rst=l.replace("收货门店：","").trim();
        if (l.startsWith("收货人姓名：")) ship.rnm=l.replace("收货人姓名：","").trim();
        if (l.startsWith("联系电话：")) ship.rph=l.replace("联系电话：","").trim();
        if (l.startsWith("收货地址：")) ship.rad=l.replace("收货地址：","").trim();
        continue;
      }
      if (sec==="items") {
        const m = l.match(/^\d+\.\s*(SKU\d+)\s+(.+?)\s+(.+?\S)\s+数量[：:]\s*(\d+)/i);
        if (m) ship.items.push({sc:m[1],sn:m[2].trim(),ss:m[3].trim(),sq:parseInt(m[4],10)});
      }
    }
    if (ship.items.length>0) ship.items.forEach(it => all.push({ externalCode:ship.ext, skuCode:it.sc, skuName:it.sn, skuSpec:it.ss, skuQuantity:String(it.sq), receiverStore:ship.rst, receiverName:ship.rnm, receiverPhone:ship.rph, receiverAddress:ship.rad, note:ship.nt }));
  }
  return all;
}

// 8. 配送签收单（多单）.txt
function parseSignConfirm(text) {
  const blocks = text.split(/【签收单\d+】/).filter(s=>s.trim());
  const all = [];
  for (const blk of blocks) {
    const lines = blk.split("\n").map(l=>l.trim()).filter(Boolean);
    const ship = { ext:"",rst:"",rnm:"",rph:"",rad:"",nt:"",items:[] };
    let sec = "";
    for (const l of lines) {
      if (l.startsWith("单据编号")) { ship.ext=l.replace("单据编号：","").trim(); continue; }
      if (l==="收货信息：") { sec="recv"; continue; }
      if (l==="物品明细：") { sec="items"; continue; }
      if (l==="签收信息："||l.startsWith("签收人")||l.startsWith("签收时间")||l.startsWith("签收状态")) { sec=""; continue; }
      if (sec==="recv") {
        if (l.startsWith("收货门店：")) ship.rst=l.replace("收货门店：","").trim();
        if (l.startsWith("收货人姓名：")) ship.rnm=l.replace("收货人姓名：","").trim();
        if (l.startsWith("联系电话：")) ship.rph=l.replace("联系电话：","").trim();
        if (l.startsWith("收货地址：")) ship.rad=l.replace("收货地址：","").trim();
        continue;
      }
      if (sec==="items") {
        const m = l.match(/(SKU\d+)\s+(.+?)\s+(.+?\S)\s+[xX×](\d+)/i);
        if (m) ship.items.push({sc:m[1],sn:m[2].trim(),ss:m[3].trim(),sq:parseInt(m[4],10)});
      }
    }
    if (ship.items.length>0) ship.items.forEach(it => all.push({ externalCode:ship.ext, skuCode:it.sc, skuName:it.sn, skuSpec:it.ss, skuQuantity:String(it.sq), receiverStore:ship.rst, receiverName:ship.rnm, receiverPhone:ship.rph, receiverAddress:ship.rad, note:ship.nt }));
  }
  return all;
}

// 9. 黔寨寨配送单.txt
function parseQianZhaiZhai(text) {
  const blocks = text.split(/\n=+\n/).filter(s=>s.trim());
  const all = [];
  for (const blk of blocks) {
    const lines = blk.split("\n").map(l=>l.trim()).filter(Boolean);
    const ship = { ext:"",rst:"",rnm:"",rph:"",rad:"",nt:"",items:[] };
    let sec = "";
    for (const l of lines) {
      if (l==="黔寨寨配送单"||l==="第二页") continue;
      if (l.startsWith("单据编号：")) { ship.ext=l.replace("单据编号：","").trim(); continue; }
      if (l.startsWith("配送日期：")) continue;
      if (l==="收货信息：") { sec="recv"; continue; }
      if (l==="物品明细：") { sec="items"; continue; }
      if (l==="配送信息：") { sec=""; continue; }
      if (l.startsWith("备注：")) { ship.nt=l.replace("备注：","").trim(); continue; }
      if (l.startsWith("合计")||l.startsWith("配送方式")||l.startsWith("承运商")||l.startsWith("物流单号")||l.startsWith("预计送达")) continue;
      if (sec==="recv") {
        if (l.startsWith("收货门店：")) ship.rst=l.replace("收货门店：","").trim();
        if (l.startsWith("收货人姓名：")) ship.rnm=l.replace("收货人姓名：","").trim();
        if (l.startsWith("联系电话：")) ship.rph=l.replace("联系电话：","").trim();
        if (l.startsWith("收货地址：")) ship.rad=l.replace("收货地址：","").trim();
        continue;
      }
      if (sec==="items") {
        const m = l.match(/^\d+\s+(SKU\d+)\s+(.+?)\s{2,}(.+?)\s{2,}(\d+)/i);
        if (m) ship.items.push({sc:m[1],sn:m[2].trim(),ss:m[3].trim(),sq:parseInt(m[4],10)});
      }
    }
    if (ship.items.length>0) ship.items.forEach(it => all.push({ externalCode:ship.ext, skuCode:it.sc, skuName:it.sn, skuSpec:it.ss, skuQuantity:String(it.sq), receiverStore:ship.rst, receiverName:ship.rnm, receiverPhone:ship.rph, receiverAddress:ship.rad, note:ship.nt }));
  }
  return all;
}

function readTxt(name) { return readFileSync(join(DEMOS, name), "utf-8"); }

// ======================== Main ========================

async function processOne(baseName, fileName, rawRows, sheetName) {
  console.log(`    📊 原始: ${rawRows.length} 行`);
  const rows = normalizeRows(rawRows, baseName);
  console.log(`    🔧 规整: ${rows.length} 行`);

  const ruleId = await ensureRule(baseName, sheetName, STD_HEADERS, STD_MAPPING);
  return await submitShipment(`${baseName} ${TS}`, fileName, sheetName, STD_HEADERS, rows, STD_MAPPING, ruleId);
}

async function main() {
  console.log("=".repeat(60));
  console.log("🚀 9 文件完整导入 V2 - 本地解析 + 规则去重 + 自动补全");
  console.log("=".repeat(60));

  // Check server
  try {
    await new Promise((resolve, reject) => {
      http.get(BASE + "/api/universal-import/templates?take=1", r => r.statusCode===200 ? resolve() : reject()).on("error", reject);
    });
    console.log("✅ 服务器在线\n");
  } catch { console.log("❌ 服务器未运行!"); process.exit(1); }

  await getRules();
  console.log(`📋 已有 ${ruleCache.length} 条规则\n`);

  const stats = { ok:0, fail:0, rows:0 };

  const tasks = [
    ["多门店分Sheet出库单", "多门店分Sheet出库单.xlsx", () => parseMultiSheet(join(DEMOS,"多门店分Sheet出库单.xlsx")), "多门店"],
    ["湖南仓发货明细", "湖南仓发货明细.xlsx", () => parseHunan(join(DEMOS,"湖南仓发货明细.xlsx")), "发货明细"],
    ["欢乐牧场模板", "欢乐牧场模板.xlsx", () => parseHuanle(join(DEMOS,"欢乐牧场模板.xlsx")), "门店配送"],
    ["黎明屯配送发货单", "黎明屯配送发货单.xlsx", () => parseLimingtun(join(DEMOS,"黎明屯配送发货单.xlsx")), "Sheet1"],
    ["门店调拨单（卡片式）", "门店调拨单（卡片式）.xlsx", () => parseCard(join(DEMOS,"门店调拨单（卡片式）.xlsx")), "调拨单"],
    ["周配送计划", "周配送计划.xlsx", () => parseWeeklyPlan(join(DEMOS,"周配送计划.xlsx")), "周配送计划"],
    ["门店配送确认单", "门店配送确认单.txt", () => parseDeliveryConfirm(readTxt("门店配送确认单.txt")), "门店配送确认单"],
    ["配送签收单（多单）", "配送签收单（多单）.txt", () => parseSignConfirm(readTxt("配送签收单（多单）.txt")), "配送签收单"],
    ["黔寨寨配送单", "黔寨寨配送单.txt", () => parseQianZhaiZhai(readTxt("黔寨寨配送单.txt")), "黔寨寨配送单"],
  ];

  let idx = 0;
  for (const [baseName, fileName, fn, sheet] of tasks) {
    idx++;
    console.log(`\n📄 [${idx}/9] ${baseName}`);
    try {
      const raw = fn();
      const result = await processOne(baseName, fileName, raw, sheet);
      if (result.ok) { stats.ok++; stats.rows += result.count; }
      else { stats.fail++; }
    } catch (e) {
      console.log(`    ❌ 异常: ${e.message}`);
      stats.fail++;
    }
    await sleep(200);
  }

  console.log("\n" + "=".repeat(60));
  console.log("📊 导入完成");
  console.log("=".repeat(60));
  console.log(`  成功: ${stats.ok}/9 | 失败: ${stats.fail} | 总行: ${stats.rows}`);

  // Final rule stats
  const finalRes = await get("/api/universal-import/templates?take=200");
  const all = (finalRes.templates || []);
  const active = all.filter(t => t.status === "ACTIVE");
  const uniq = new Set(active.map(r => r.ruleName.split(" ")[0]));
  console.log(`  活跃规则: ${active.length} | 唯一: ${uniq.size} | 重复: ${active.length-uniq.size}`);
}

main().catch(e => { console.error("💥", e); process.exit(1); });
