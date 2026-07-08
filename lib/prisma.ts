import { PrismaClient } from "@prisma/client";
import fs from "fs";
import { DB_BASE64 } from "./db-base64";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function getDatasourceUrl(): string {
  // 环境变量优先
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const tmpPath = "/tmp/dev.db";

  // 热启动：/tmp 已有数据库
  if (fs.existsSync(tmpPath)) return `file:${tmpPath}`;

  // 冷启动：从内嵌 base64 还原数据库到 /tmp
  if (DB_BASE64) {
    fs.writeFileSync(tmpPath, Buffer.from(DB_BASE64, "base64"));
    console.log(`[prisma] restored db from embedded base64 → ${tmpPath}`);
    return `file:${tmpPath}`;
  }

  // 本地开发回退
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
