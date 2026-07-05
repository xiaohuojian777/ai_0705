import type { Metadata } from "next";
import { getOperatorNameFromSession } from "@/lib/operator-session";
import { UniversalImportClient } from "./universal-import-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "万能导入",
  description: "万能导入，支持运单管理、规则管理与历史运单查询。",
};

type UniversalImportPageProps = {
  searchParams?: Promise<{
    tab?: string;
  }>;
};

export default async function UniversalImportPage({ searchParams }: UniversalImportPageProps) {
  // 当前入口直接进入万能导入，不再展示非考试范围模块。
  const operatorName = await getOperatorNameFromSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const initialTab =
    resolvedSearchParams?.tab === "history" || resolvedSearchParams?.tab === "rules"
      ? resolvedSearchParams.tab
      : "import";

  return <UniversalImportClient operatorName={operatorName} initialTab={initialTab} />;
}
