import { getOperatorNameFromSession } from "@/lib/operator-session";
import { NextResponse } from "next/server";

export async function GET() {
  const operatorName = await getOperatorNameFromSession();

  return NextResponse.json({
    authenticated: true,
    username: operatorName,
    operatorName,
    examMode: true,
  });
}

export async function POST() {
  // 登录模块不属于本次考试范围，考试模式下无需账号密码即可进入系统。
  return GET();
}

export async function PUT() {
  // 注册模块不属于本次考试范围，保留接口兼容但不创建真实账号。
  return GET();
}

export async function DELETE() {
  // 退出登录模块已停用，返回当前访问状态。
  return GET();
}
