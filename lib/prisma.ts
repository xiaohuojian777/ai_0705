import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

/**
 * 在 Vercel serverless 环境中，文件系统只读（除 /tmp）。
 * 我们探测多个可能路径找到 dev.db，复制到 /tmp 后使用。
 */
function findAndPrepareDb(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const tmpPath = "/tmp/dev.db";
  if (fs.existsSync(tmpPath)) return `file:${tmpPath}`;

  // 按优先级探测源路径（覆盖 Vercel serverless 各种目录结构）
  const candidates = [
    path.join(process.cwd(), "prisma", "dev.db"),
    path.resolve(process.cwd(), "prisma", "dev.db"),
    "/var/task/prisma/dev.db",
    path.join(__dirname || "", "..", "prisma", "dev.db"),
  ];

  for (const src of candidates) {
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, tmpPath);
        console.log(`[prisma] db copied: ${src} → ${tmpPath}`);
        return `file:${tmpPath}`;
      }
    } catch (e) {
      console.log(`[prisma] copy failed for ${src}:`, (e as Error).message);
    }
  }

  // 最终回退 — 本地开发场景
  const fallback = "file:./prisma/dev.db";
  console.log(`[prisma] using fallback: ${fallback}`);
  return fallback;
}

function createPrismaClient() {
  const url = findAndPrepareDb();
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    datasourceUrl: url,
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
