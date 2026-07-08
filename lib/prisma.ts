import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getDatasourceUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const tmpPath = "/tmp/dev.db";
  // 检查 /tmp 是否已有复制过的 db（Vercel 函数热启动）
  if (fs.existsSync(tmpPath)) return `file:${tmpPath}`;

  // 从只读源路径复制到 /tmp 可写目录（Vercel serverless）
  const src = path.join(process.cwd(), "prisma", "dev.db");
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, tmpPath);
      return `file:${tmpPath}`;
    }
  } catch {
    // Vercel 上复制失败，尝试直接用（可能只读，会触发锁文件错误）
  }

  // 本地开发回退
  return "file:./prisma/dev.db";
}

function createPrismaClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    datasourceUrl: getDatasourceUrl(),
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
