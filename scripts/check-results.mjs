/**
 * 检查数据库中的规则和下单情况
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rules = await prisma.universalImportRule.findMany({ orderBy: { ruleName: "asc" } });
  console.log(`=== 规则列表 (${rules.length}条) ===`);
  rules.forEach(r => console.log(`  ${r.ruleName} v${r.version}`));

  const batches = await prisma.universalImportBatch.findMany({
    include: { rule: true, _count: { select: { shipments: true } } },
    orderBy: { createdAt: "asc" },
  });
  console.log(`\n=== 批次汇总 (${batches.length}批次) ===`);
  batches.forEach(b => {
    console.log(`  ${b.originalFileName.padEnd(25)} | ${b._count.shipments}单/${b.successRows}行 | ${b.rule?.ruleName || "N/A"}`);
  });

  const shipments = await prisma.universalImportShipment.count();
  const items = await prisma.universalImportShipmentItem.count();
  const groups = await prisma.universalImportShipmentReceiverGroup.count();
  console.log(`\n总计: ${rules.length}规则, ${batches.length}批次, ${shipments}单, ${groups}组, ${items}行`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
