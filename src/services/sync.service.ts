import { prisma } from '../db/prisma.js';
import { supabase } from '../db/supabase.js';

export async function syncVentasToCloud(): Promise<void> {
  const ventasPendientes = await prisma.venta.findMany({
    where: { synced_at: null },
    include: {
      detalles: { include: { producto: true } },
      pagos: true,
      sesion: { include: { caja: true } },
    },
  });

  if (ventasPendientes.length === 0) return;

  console.log(`[Sync] Sincronizando ${ventasPendientes.length} venta(s)...`);

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

      // Paso D: Marcar como sincronizada localmente
      await prisma.venta.update({
        where: { id: venta.id },
        data: { synced_at: new Date() },
      });

      console.log(`[Sync] ✅ Venta ${venta.id} sincronizada.`);
    } catch (err) {
      console.error(`[Sync] ❌ Error al sincronizar venta ${venta.id}:`, err);
      continue;
    }
  }
}
