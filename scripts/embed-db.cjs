/**
 * 将 prisma/dev.db 复制到 lib/ 目录。
 * Vercel 构建时执行，配合 outputFileTracingIncludes 确保数据库文件被包含在 serverless 函数包中。
 */
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "prisma", "dev.db");
const dest = path.join(__dirname, "..", "lib", "dev.db");

if (!fs.existsSync(src)) {
  console.warn("[copy-db] dev.db not found, skipping");
  process.exit(0);
}

fs.copyFileSync(src, dest);
const sizeKB = (fs.statSync(dest).size / 1024).toFixed(1);
console.log(`[copy-db] copied ${sizeKB} KB → lib/dev.db`);
