/**
 * 清空所有历史导入数据（保留规则可选）
 * 用法: node scripts/clear-db.mjs [--keep-rules]
 */
import { PrismaClient } from "@prisma/client";

const keepRules = process.argv.includes("--keep-rules");
const prisma = new PrismaClient();

async function main() {
  console.log("清空数据库...");
  
  await prisma.universalImportShipmentItem.deleteMany();
  console.log("  ✅ ShipmentItem 已清空");
  
  await prisma.universalImportShipmentReceiverGroup.deleteMany();
  console.log("  ✅ ShipmentReceiverGroup 已清空");
  
  await prisma.universalImportShipment.deleteMany();
  console.log("  ✅ Shipment 已清空");
  
  await prisma.universalImportBatch.deleteMany();
  console.log("  ✅ Batch 已清空");
  
  if (!keepRules) {
    await prisma.universalImportRule.deleteMany();
    console.log("  ✅ Rule 已清空");
  } else {
    console.log("  ⏭ Rule 保留");
  }
  
  console.log("\n✅ 清库完成！");
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("清库失败:", err);
  process.exit(1);
});
