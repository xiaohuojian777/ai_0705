import { validateImportRows, type UniversalImportRow } from "@/lib/universal-import";

function createBenchmarkRows(total = 1000): UniversalImportRow[] {
  return Array.from({ length: total }, (_, index) => ({
    externalCode: `BENCH-${String(Math.floor(index / 2) + 1).padStart(4, "0")}`,
    receiverStore: `测试门店${(index % 25) + 1}`,
    receiverName: "性能测试",
    receiverPhone: "13800138000",
    receiverAddress: `上海市闵行区测试路 ${index + 1} 号`,
    skuCode: `SKU-${String(index + 1).padStart(5, "0")}`,
    skuName: `测试商品${index + 1}`,
    skuQuantity: String((index % 6) + 1),
    skuSpec: `${(index % 10) + 1}kg/箱`,
    note: index % 7 === 0 ? "压测样例" : "",
    rowIndex: index + 1,
  }));
}

function estimateRenderMs(totalRows: number, renderedRows: number) {
  const visibleCost = renderedRows * 0.9;
  const bufferedCost = Math.max(totalRows - renderedRows, 0) * 0.04;
  return Math.round(visibleCost + bufferedCost);
}

function main() {
  const totalRows = Number(process.argv[2] ?? "1000");
  const renderRows = Math.min(Number(process.argv[3] ?? "160"), totalRows);

  const startedAt = performance.now();
  const rows = createBenchmarkRows(totalRows);
  const validation = validateImportRows(rows);
  const parseMs = Math.round(performance.now() - startedAt);
  const renderEstimateMs = estimateRenderMs(totalRows, renderRows);
  const totalEstimateMs = parseMs + renderEstimateMs;

  console.log(
    JSON.stringify(
      {
        totalRows,
        renderRows,
        parseMs,
        renderEstimateMs,
        totalEstimateMs,
        validationIssueCount: validation.issues.length,
        withinTenSeconds: totalEstimateMs <= 10000,
        withinThreeSecondsRender: renderEstimateMs <= 3000,
      },
      null,
      2,
    ),
  );
}

main();
