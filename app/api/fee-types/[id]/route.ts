import { NextResponse } from "next/server";

export async function PUT() {
  // 非本次考试功能：费用类型编辑接口已停用，仅保留明确响应避免误访问。
  return NextResponse.json(
    {
      error: "费用类型管理不属于本次考试范围，已在考试模式下停用。",
      examMode: true,
    },
    { status: 410 },
  );
}
