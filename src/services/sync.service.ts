import { prisma } from '../db/prisma.js';
import { supabase } from '../db/supabase.js';
import type { Producto } from '@prisma/client';

export async function syncProductosToCloud(): Promise<void> {
  let productos: Producto[] = [];

  try {
    // Raw SQL: synced_at IS NULL o updated_at > synced_at (Prisma no soporta comparación entre campos en where)
    productos = await prisma.$queryRaw<Producto[]>`
      SELECT * FROM Producto
      WHERE synced_at IS NULL OR updated_at > synced_at
    `;
  } catch (err) {
    console.error('[SYNC] ❌ ERROR CRÍTICO al leer productos pendientes desde la BD local:', err instanceof Error ? err.message : err);
    return;
  }

  if (productos.length === 0) {
    console.info('[SYNC] 💤 Productos: nada nuevo para sincronizar en este ciclo.');
    return;
  }

  console.info(`[SYNC] 📦 Se encontraron ${productos.length} producto(s) pendientes de subir.`);

  let exitosos = 0;

  for (const producto of productos) {
    try {
      const { error } = await supabase.from('Producto').upsert({
        id:            producto.id,
        codigo_barras: producto.codigo_barras,
        nombre:        producto.nombre,
        precio_actual: producto.precio_actual,
        stock:         producto.stock,
        activo:        producto.activo,
        eliminado:     producto.eliminado,
        updated_at:    producto.updated_at,
      });

      if (error) throw new Error(error.message);

      // $executeRaw evita que @updatedAt modifique updated_at y genere un bucle infinito.
      // SET synced_at = updated_at garantiza igualdad exacta entre ambos campos.
      await prisma.$executeRaw`
        UPDATE "Producto" SET synced_at = updated_at WHERE id = ${producto.id}
      `;

      exitosos++;
    } catch (err) {
      console.error(`[SYNC] ❌ ERROR CRÍTICO al sincronizar producto "${producto.nombre}" (${producto.id}): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (exitosos > 0) {
    console.info(`[SYNC] ✅ ${exitosos} producto(s) sincronizados exitosamente.`);
  }
  if (exitosos < productos.length) {
    console.warn(`[SYNC] ⚠️  ${productos.length - exitosos} producto(s) fallaron y se reintentarán en el próximo ciclo.`);
  }
}

export async function syncVentasToCloud(): Promise<void> {
  const ventasPendientes = await prisma.venta.findMany({
    where: { synced_at: null },
    include: {
      detalles: { include: { producto: true } },
      pagos: true,
      sesion: { include: { caja: true } },
    },
  }).catch(err => {
    console.error('[SYNC] ❌ ERROR CRÍTICO al leer ventas pendientes desde la BD local:', err instanceof Error ? err.message : err);
    return null;
  });

  if (!ventasPendientes) return;

  if (ventasPendientes.length === 0) {
    console.info('[SYNC] 💤 Ventas: nada nuevo para sincronizar en este ciclo.');
    return;
  }

  console.info(`[SYNC] 📦 Se encontraron ${ventasPendientes.length} venta(s) pendientes de subir.`);

  let exitosos = 0;

  for (const venta of ventasPendientes) {
    try {
      // Paso A: Dependencias de sesión y caja
      if (venta.sesion && venta.sesion.caja) {
        const { error: eCaja } = await supabase.from('Caja').upsert({
          id: venta.sesion.caja.id,
          nombre: venta.sesion.caja.nombre,
        });
        if (eCaja) throw new Error(`Caja upsert: ${eCaja.message}`);

        const { caja: _caja, ...sesionData } = venta.sesion;
        const { error: eSesion } = await supabase.from('SesionCaja').upsert({
          ...sesionData,
          cajero_nombre: sesionData.cajero_nombre || 'Cajero Desconocido',
        });
        if (eSesion) throw new Error(`SesionCaja upsert: ${eSesion.message}`);
      }

      // Paso B: Productos referenciados en los detalles
      for (const detalle of venta.detalles) {
        const { error: eProducto } = await supabase
          .from('Producto')
          .upsert(detalle.producto);
        if (eProducto) throw new Error(`Producto upsert (${detalle.producto.id}): ${eProducto.message}`);
      }

      // Paso C: Venta, detalles y pagos
      const { error: eVenta } = await supabase.from('Venta').upsert({
        id:              venta.id,
        estado:          venta.estado,
        total:           venta.total,
        descuento_total: venta.descuento_total,
        vendedor_nombre: venta.vendedor_nombre || 'Vendedor Desconocido',
        created_at:      venta.created_at,
        updated_at:      venta.updated_at,
        sesion_id:       venta.sesion_id,
      });
      if (eVenta) throw new Error(`Venta upsert: ${eVenta.message}`);

      for (const detalle of venta.detalles) {
        const { producto: _producto, ...detalleData } = detalle;
        const { error: eDetalle } = await supabase.from('DetalleVenta').upsert(detalleData);
        if (eDetalle) throw new Error(`DetalleVenta upsert (${detalle.id}): ${eDetalle.message}`);
      }

      for (const pago of venta.pagos) {
        const { error: ePago } = await supabase.from('Pago').upsert(pago);
        if (ePago) throw new Error(`Pago upsert (${pago.id}): ${ePago.message}`);
      }

      // Paso D: Marcar como sincronizada localmente.
      // $executeRaw evita que @updatedAt modifique updated_at y genere un bucle infinito.
      await prisma.$executeRaw`
        UPDATE "Venta" SET synced_at = updated_at WHERE id = ${venta.id}
      `;

      exitosos++;
    } catch (err) {
      console.error(`[SYNC] ❌ ERROR CRÍTICO al sincronizar venta ${venta.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (exitosos > 0) {
    console.info(`[SYNC] ✅ ${exitosos} venta(s) sincronizadas exitosamente.`);
  }
  if (exitosos < ventasPendientes.length) {
    console.warn(`[SYNC] ⚠️  ${ventasPendientes.length - exitosos} venta(s) fallaron y se reintentarán en el próximo ciclo.`);
  }
}
