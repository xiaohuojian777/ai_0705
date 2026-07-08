import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Clearing test data...');
  
  const deletedItems = await prisma.universalImportShipmentItem.deleteMany();
  console.log(`  ShipmentItems: ${deletedItems.count} rows deleted`);
  
  const deletedGroups = await prisma.universalImportShipmentReceiverGroup.deleteMany();
  console.log(`  ReceiverGroups: ${deletedGroups.count} rows deleted`);
  
  const deletedShipments = await prisma.universalImportShipment.deleteMany();
  console.log(`  Shipments: ${deletedShipments.count} rows deleted`);
  
  const deletedBatches = await prisma.universalImportBatch.deleteMany();
  console.log(`  Batches: ${deletedBatches.count} rows deleted`);
  
  console.log('Done.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
