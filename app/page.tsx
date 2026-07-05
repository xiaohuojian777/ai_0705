import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default function HomePage() {
  // 考试专用入口：登录页和费用类型管理属于历史功能，不在本次考试范围内。
  // 首页直接进入万能导入，避免展示任何非考试菜单或模块。
  redirect("/universal-import");
}
