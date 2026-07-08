import { PrismaClient } from "@prisma/client";
import fs from "fs";
import path from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getDatasourceUrl(): string {
  // 环境变量优先
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const tmpPath = "/tmp/dev.db";

  // 热启动：/tmp 已有数据库
  if (fs.existsSync(tmpPath)) return `file:${tmpPath}`;

  // 冷启动：尝试多种路径找到数据库文件并复制到 /tmp
  const candidates = [
    // outputFileTracingIncludes 打包后的位置
    path.join(process.cwd(), "lib", "dev.db"),
    // 直接在根目录
    path.join(process.cwd(), "prisma", "dev.db"),
    // .next 构建目录内
    path.join(process.cwd(), ".next", "server", "lib", "dev.db"),
    // 本地开发路径
    path.join(process.cwd(), "..", "prisma", "dev.db"),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.copyFileSync(p, tmpPath);
      console.log(`[prisma] copied db from ${p} → ${tmpPath}`);
      return `file:${tmpPath}`;
    }
  }

  // 最终回退：本地开发
  return "file:./prisma/dev.db";
}

function createPrismaClient(): PrismaClient {
  try {
    return new PrismaClient({
      log:
        process.env.NODE_ENV === "development"
          ? ["warn", "error"]
          : ["error"],
      datasourceUrl: getDatasourceUrl(),
    });
  } catch (err) {
    console.error("[prisma] PrismaClient construction failed:", err);
    throw err;
  }
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
