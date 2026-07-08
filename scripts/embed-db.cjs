/**
 * 将 prisma/dev.db 编码为 base64 JSON 文件。
 * Vercel 构建时执行，Next.js 原生支持 JSON import，无需额外 webpack 配置。
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "prisma", "dev.db");
const dest = path.join(__dirname, "..", "lib", "db-base64.json");

if (!fs.existsSync(src)) {
  console.warn("[embed-db] dev.db not found, skipping");
  process.exit(0);
}

const buffer = fs.readFileSync(src);
const base64 = buffer.toString("base64");

fs.writeFileSync(dest, JSON.stringify({ base64, size: buffer.length }));
console.log(`[embed-db] wrote ${(buffer.length / 1024).toFixed(1)} KB → lib/db-base64.json`);
