import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // 测试 1：检查 db-base64 模块是否可用
    let dbBase64Status: string;
    let dbBase64Length: number;
    try {
      const mod = await import("@/lib/db-base64");
      dbBase64Length = (mod.DB_BASE64 || "").length;
      dbBase64Status = "loaded";
    } catch (e: any) {
      dbBase64Status = `error: ${e.message}`;
      dbBase64Length = 0;
    }

    // 测试 2：检查 Prisma client 初始化
    let prismaStatus: string;
    let prismaError: string | null = null;
    try {
      const { prisma } = await import("@/lib/prisma");
      prismaStatus = "initialized";

      // 测试 3：尝试查询
      try {
        const count = await prisma.universalImportRule.count();
        prismaStatus = `ok - rules count: ${count}`;
      } catch (e: any) {
        prismaStatus = `init ok but query failed: ${e.message}`;
        prismaError = e.stack || e.message;
      }
    } catch (e: any) {
      prismaStatus = `init failed: ${e.message}`;
      prismaError = e.stack || e.message;
    }

    // 测试 4：Datasource URL
    let dsUrl: string;
    try {
      const { prisma } = await import("@/lib/prisma");
      // Access via any - private field
      dsUrl = (prisma as any)._datasourceUrl || (prisma as any)._engineConfig?.datamodel || "unknown";
    } catch {
      dsUrl = "could not access";
    }

    return NextResponse.json({
      dbBase64: { status: dbBase64Status, length: dbBase64Length },
      prisma: { status: prismaStatus, error: prismaError },
      datasourceUrl: dsUrl,
      env: {
        DATABASE_URL: process.env.DATABASE_URL || "(not set)",
        NODE_ENV: process.env.NODE_ENV || "(not set)",
        VERCEL: process.env.VERCEL || "(not set)",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e.message, stack: e.stack },
      { status: 500 }
    );
  }
}
