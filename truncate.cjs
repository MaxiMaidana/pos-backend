const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const s = await prisma.stockTienda.deleteMany();
  console.log(`StockTienda eliminados: ${s.count}`);

  const p = await prisma.producto.deleteMany();
  console.log(`Productos eliminados:   ${p.count}`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
