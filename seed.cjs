const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // ── Caja ──────────────────────────────────────────────────────────────────
  const caja = await prisma.caja.upsert({
    where:  { id: 'bbeafc22-3a03-44b6-b8c3-f4ab9aa26b38' },
    update: {},
    create: {
      id:     'bbeafc22-3a03-44b6-b8c3-f4ab9aa26b38',
      nombre: 'Caja 1',
    },
  });
  console.log(`Caja upserted: ${caja.nombre} (${caja.id})`);

  // ── Tiendas ───────────────────────────────────────────────────────────────
  const tiendas = [
    { id: 'tienda-local-1', nombre: 'Local Jesica', direccion: null },
    { id: 'tienda-local-2', nombre: 'Local Pablo',  direccion: null },
  ];

  for (const t of tiendas) {
    const tienda = await prisma.tienda.upsert({
      where:  { id: t.id },
      update: { nombre: t.nombre, direccion: t.direccion },
      create: { id: t.id, nombre: t.nombre, direccion: t.direccion },
    });
    console.log(`Tienda upserted: ${tienda.nombre} (${tienda.id})`);
  }
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
