import { prisma } from '../db/prisma.js';
import { supabase } from '../db/supabase.js';
import type { Producto, SesionCaja } from '@prisma/client';

export async function syncProductosToCloud(): Promise<void> {
  let productos: Producto[] = [];

  try {
    // Raw SQL: synced_at IS NULL o updated_at > synced_at (Prisma no soporta comparación entre campos en where)
    productos = await prisma.$queryRaw<Producto[]>`
      SELECT * FROM "Producto"
      WHERE synced_at IS NULL OR updated_at > synced_at      LIMIT 500    `;
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

export async function syncStockTiendaToCloud(): Promise<void> {
  type StockRow = { id: string; producto_id: string; tienda_id: string; cantidad: number; updated_at: Date };
  let stocks: StockRow[] = [];

  try {
    stocks = await prisma.$queryRaw<StockRow[]>`
      SELECT id, producto_id, tienda_id, cantidad, updated_at
      FROM "StockTienda"
      WHERE synced_at IS NULL OR updated_at > synced_at
      LIMIT 500
    `;
  } catch (err) {
    console.error('[SYNC] ❌ ERROR CRÍTICO al leer stocks pendientes desde la BD local:', err instanceof Error ? err.message : err);
    return;
  }

  if (stocks.length === 0) {
    console.info('[SYNC] 💤 StockTienda: nada nuevo para sincronizar en este ciclo.');
    return;
  }

  console.info(`[SYNC] 📦 Se encontraron ${stocks.length} registro(s) de stock pendientes de subir.`);

  let exitosos = 0;

  for (const s of stocks) {
    try {
      const { error } = await supabase.from('StockTienda').upsert({
        id:          s.id,
        producto_id: s.producto_id,
        tienda_id:   s.tienda_id,
        cantidad:    s.cantidad,
        updated_at:  s.updated_at,
      });
      if (error) throw new Error(error.message);

      await prisma.$executeRaw`
        UPDATE "StockTienda" SET synced_at = updated_at WHERE id = ${s.id}
      `;

      exitosos++;
    } catch (err) {
      console.error(`[SYNC] ❌ ERROR CRÍTICO al sincronizar stock (${s.id}): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (exitosos > 0) {
    console.info(`[SYNC] ✅ ${exitosos} registro(s) de stock sincronizados exitosamente.`);
  }
  if (exitosos < stocks.length) {
    console.warn(`[SYNC] ⚠️  ${stocks.length - exitosos} registro(s) de stock fallaron y se reintentarán en el próximo ciclo.`);
  }
}

export async function syncVentasToCloud(): Promise<void> {
  // Raw SQL: synced_at IS NULL o updated_at > synced_at (Prisma no soporta comparación entre campos en where)
  const ventasPendientes = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Venta" WHERE synced_at IS NULL OR updated_at > synced_at
    LIMIT 100
  `.then(rows =>
    rows.length === 0
      ? Promise.resolve([])
      : prisma.venta.findMany({
          where: { id: { in: rows.map(r => r.id) } },
          include: {
            detalles: { include: { producto: true } },
            pagos: true,
            sesion: { include: { caja: true } },
          },
        })
  ).catch(err => {
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

        const { caja: _caja, synced_at: _synced, ...sesionData } = venta.sesion;
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

export async function syncCajasToCloud(): Promise<void> {
  let cajas: { id: string; nombre: string }[] = [];

  try {
    // Caja no tiene updated_at (nunca se modifica tras crearse), alcanza con synced_at IS NULL
    cajas = await prisma.$queryRaw<{ id: string; nombre: string }[]>`
      SELECT id, nombre FROM "Caja" WHERE synced_at IS NULL
    `;
  } catch (err) {
    console.error('[SYNC] ❌ ERROR CRÍTICO al leer cajas pendientes desde la BD local:', err instanceof Error ? err.message : err);
    return;
  }

  if (cajas.length === 0) {
    console.info('[SYNC] 💤 Cajas: nada nuevo para sincronizar en este ciclo.');
    return;
  }

  console.info(`[SYNC] 📦 Se encontraron ${cajas.length} caja(s) pendientes de subir.`);

  let exitosos = 0;

  for (const caja of cajas) {
    try {
      const { error } = await supabase.from('Caja').upsert({
        id:     caja.id,
        nombre: caja.nombre,
      });
      if (error) throw new Error(error.message);

      await prisma.$executeRaw`
        UPDATE "Caja" SET synced_at = CURRENT_TIMESTAMP WHERE id = ${caja.id}
      `;

      exitosos++;
    } catch (err) {
      console.error(`[SYNC] ❌ ERROR CRÍTICO al sincronizar caja "${caja.nombre}" (${caja.id}): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (exitosos > 0) {
    console.info(`[SYNC] ✅ ${exitosos} caja(s) sincronizadas exitosamente.`);
  }
  if (exitosos < cajas.length) {
    console.warn(`[SYNC] ⚠️  ${cajas.length - exitosos} caja(s) fallaron y se reintentarán en el próximo ciclo.`);
  }
}

export async function syncSesionesCajaToCloud(): Promise<void> {
  let sesiones: SesionCaja[] = [];

  try {
    // Raw SQL: updated_at > synced_at detecta cierres de caja posteriores a la última sync
    sesiones = await prisma.$queryRaw<SesionCaja[]>`
      SELECT * FROM "SesionCaja" WHERE synced_at IS NULL OR updated_at > synced_at
    `;
  } catch (err) {
    console.error('[SYNC] ❌ ERROR CRÍTICO al leer sesiones de caja pendientes desde la BD local:', err instanceof Error ? err.message : err);
    return;
  }

  if (sesiones.length === 0) {
    console.info('[SYNC] 💤 SesionesCaja: nada nuevo para sincronizar en este ciclo.');
    return;
  }

  console.info(`[SYNC] 📦 Se encontraron ${sesiones.length} sesión(es) de caja pendientes de subir.`);

  let exitosos = 0;

  for (const sesion of sesiones) {
    try {
      const { error } = await supabase.from('SesionCaja').upsert({
        id:                    sesion.id,
        cajero_nombre:         sesion.cajero_nombre || 'Cajero Desconocido',
        fecha_apertura:        sesion.fecha_apertura,
        fecha_cierre:          sesion.fecha_cierre,
        monto_inicial:         sesion.monto_inicial,
        estado:                sesion.estado,
        monto_efectivo_cierre: sesion.monto_efectivo_cierre,
        diferencia:            sesion.diferencia,
        caja_id:               sesion.caja_id,
        updated_at:            sesion.updated_at,
      });
      if (error) throw new Error(error.message);

      // $executeRaw evita que @updatedAt modifique updated_at y genere un bucle infinito.
      // SET synced_at = updated_at garantiza igualdad exacta entre ambos campos.
      await prisma.$executeRaw`
        UPDATE "SesionCaja" SET synced_at = updated_at WHERE id = ${sesion.id}
      `;

      exitosos++;
    } catch (err) {
      console.error(`[SYNC] ❌ ERROR CRÍTICO al sincronizar sesión de caja (${sesion.id}): ${err instanceof Error ? err.message : err}`);
    }
  }

  if (exitosos > 0) {
    console.info(`[SYNC] ✅ ${exitosos} sesión(es) de caja sincronizadas exitosamente.`);
  }
  if (exitosos < sesiones.length) {
    console.warn(`[SYNC] ⚠️  ${sesiones.length - exitosos} sesión(es) fallaron y se reintentarán en el próximo ciclo.`);
  }
}

// ── PULL: Cloud → Local (caché offline) ──────────────────────────────────────
//
// Cursores INDEPENDIENTES por entidad.
// Si compartieran un cursor, el timestamp del último producto podría avanzar
// por encima del updated_at de un stock recién creado, y ese stock quedaría
// fuera del filtro .gt() en el siguiente ciclo → nunca se descargaría.
// Con cursores separados cada entidad solo avanza cuando ella misma tiene datos.
// Al reiniciar el proceso vuelven a epoch → descarga completa (correcto).

let lastProductPullAt: Date = new Date(0);
let lastStockPullAt:   Date = new Date(0);

/**
 * Convierte una Date (UTC internamente) al string de fecha local sin 'Z'.
 *
 * Supabase almacena `timestamp without time zone` con la hora LOCAL del servidor
 * PostgreSQL (ej: '2026-04-12T14:55:46'). PostgREST no interpreta la 'Z' como
 * timezone — trata cualquier string como un valor plano y lo compara
 * lexicográficamente. Si le enviamos '2026-04-12T17:30:59.000Z', compara
 * '17:30' contra '14:55' y no devuelve los registros nuevos.
 *
 * Solución: restamos el offset local para obtener el equivalente en hora local
 * y quitamos la 'Z', enviando '2026-04-12T14:30:59.000' → comparación correcta.
 *
 * getTimezoneOffset() devuelve minutos POSITIVOS para zonas al oeste de UTC
 * (ej: UTC-3 Argentina → +180), por lo que restar offsetMs convierte UTC → local.
 */
function toSupabaseCursor(utcDate: Date): string {
  const offsetMs = utcDate.getTimezoneOffset() * 60 * 1000;
  const localDate = new Date(utcDate.getTime() - offsetMs);
  return localDate.toISOString().replace('Z', '');
}

/**
 * Descarga TODAS las tiendas de la nube y las cachea en SQLite.
 * No usa cursor intencional: las tiendas son pocas y deben estar
 * SIEMPRE completas localmente antes de procesar StockTienda (FK).
 * Un full-sync de 2-10 filas es despreciable en coste.
 */
async function pullTiendasFromCloud(): Promise<number> {
  const { data, error } = await supabase
    .from('Tienda')
    .select('id, nombre, direccion, creado_en, updated_at')
    .order('updated_at', { ascending: true });

  if (error) throw new Error(`Pull Tiendas: ${error.message}`);
  if (!data || data.length === 0) {
    console.warn('[SYNC] ⚠️  Pull Tiendas: la nube no devolvió ninguna tienda. Se cancela el pull de Stock para evitar errores de FK.');
    return 0;
  }

  // Transacción única para minimizar round-trips con SQLite
  await prisma.$transaction(
    data.map((t) =>
      prisma.$executeRaw`
        INSERT INTO "Tienda" (id, nombre, direccion, creado_en, updated_at)
        VALUES (${t.id}, ${t.nombre}, ${t.direccion ?? null}, ${new Date(t.creado_en)}, ${new Date(t.updated_at)})
        ON CONFLICT(id) DO UPDATE SET
          nombre     = excluded.nombre,
          direccion  = excluded.direccion,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at >= "Tienda".updated_at
      `
    )
  );

  return data.length;
}

/**
 * Descarga productos modificados en la nube y los cachea en SQLite.
 * Cursor propio: lastProductPullAt, independiente del cursor de stocks.
 */
async function pullProductosFromCloud(): Promise<void> {
  const cursor = toSupabaseCursor(lastProductPullAt);
  console.info(`[SYNC] 🔍 Pull Productos: buscando cambios desde ${cursor} (hora local)`);

  const { data, error } = await supabase
    .from('Producto')
    .select('id, codigo_barras, nombre, precio_actual, activo, eliminado, updated_at')
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(500);

  if (error) throw new Error(`Pull Productos: ${error.message}`);

  if (!data || data.length === 0) {
    console.info('[SYNC] 💤 Pull Productos: sin novedades desde la nube.');
    return;
  }

  console.info(`[SYNC] ⬇️  ${data.length} producto(s) descargando desde la nube.`);

  let newCursor = lastProductPullAt;

  await prisma.$transaction(
    data.map((p) => {
      const updatedAt = new Date(p.updated_at);
      if (updatedAt > newCursor) newCursor = updatedAt;
      return prisma.$executeRaw`
        INSERT INTO "Producto" (id, codigo_barras, nombre, precio_actual, activo, eliminado, updated_at, synced_at)
        VALUES (
          ${p.id},
          ${p.codigo_barras ?? null},
          ${p.nombre},
          ${p.precio_actual},
          ${p.activo},
          ${p.eliminado},
          ${updatedAt},
          ${updatedAt}
        )
        ON CONFLICT(id) DO UPDATE SET
          codigo_barras = excluded.codigo_barras,
          nombre        = excluded.nombre,
          precio_actual = excluded.precio_actual,
          activo        = excluded.activo,
          eliminado     = excluded.eliminado,
          updated_at    = excluded.updated_at,
          synced_at     = excluded.updated_at
        WHERE excluded.updated_at >= "Producto".updated_at
      `;
    })
  );

  lastProductPullAt = newCursor;
  console.info(`[SYNC] ✅ ${data.length} producto(s) guardados en SQLite local. Cursor → ${lastProductPullAt.toISOString()}`);
}

/**
 * Descarga el stock de TODAS las tiendas (L1, L2, …) y lo cachea en SQLite.
 * Cursor propio: lastStockPullAt, independiente del cursor de productos.
 * Así el timestamp de los últimos productos nunca oculta stocks más antiguos.
 *
 * Conflicto por (producto_id, tienda_id) porque es la clave de negocio real.
 */
async function pullStockTiendaFromCloud(): Promise<void> {
  const cursor = toSupabaseCursor(lastStockPullAt);
  console.info(`[SYNC] 🔍 Pull StockTienda: buscando cambios desde ${cursor} (hora local)`);

  const { data, error } = await supabase
    .from('StockTienda')
    .select('id, producto_id, tienda_id, cantidad, updated_at')
    .gt('updated_at', cursor)
    .order('updated_at', { ascending: true })
    .limit(1000);

  if (error) throw new Error(`Pull StockTienda: ${error.message}`);

  if (!data || data.length === 0) {
    console.info('[SYNC] 💤 Pull StockTienda: sin novedades desde la nube.');
    return;
  }

  console.info(`[SYNC] ⬇️  ${data.length} registro(s) de StockTienda descargando desde la nube.`);

  let newCursor = lastStockPullAt;

  // Procesamos registro a registro para que un FK error en uno no aborte el lote completo.
  let exitosos = 0;
  for (const s of data) {
    const updatedAt = new Date(s.updated_at);
    try {
      await prisma.$executeRaw`
        INSERT INTO "StockTienda" (id, producto_id, tienda_id, cantidad, updated_at, synced_at)
        VALUES (
          ${s.id},
          ${s.producto_id},
          ${s.tienda_id},
          ${s.cantidad},
          ${updatedAt},
          ${updatedAt}
        )
        ON CONFLICT(producto_id, tienda_id) DO UPDATE SET
          id         = excluded.id,
          cantidad   = excluded.cantidad,
          updated_at = excluded.updated_at,
          synced_at  = excluded.updated_at
        WHERE excluded.updated_at >= "StockTienda".updated_at
      `;
      if (updatedAt > newCursor) newCursor = updatedAt;
      exitosos++;
    } catch (err) {
      console.error(
        `[SYNC] ❌ Error al insertar StockTienda (producto=${s.producto_id}, tienda=${s.tienda_id}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // Avanza el cursor solo con los registros que efectivamente se guardaron
  if (newCursor > lastStockPullAt) lastStockPullAt = newCursor;

  console.info(`[SYNC] ✅ ${exitosos}/${data.length} registros de StockTienda guardados en SQLite. Cursor → ${lastStockPullAt.toISOString()}`);
  if (exitosos < data.length) {
    console.warn(`[SYNC] ⚠️  ${data.length - exitosos} registro(s) fallaron (ver errores arriba). Se reintentarán en el próximo ciclo.`);
  }
}

/**
 * Fase de Pull del ciclo de sincronización.
 * Orden: Tiendas → Productos → StockTienda (respeta dependencias FK).
 * Los errores se loguean pero NO abortan el ciclo de Push posterior.
 */
export async function pullFromCloud(): Promise<void> {
  try {
    // ── Paso 1: Tiendas (sin cursor, siempre completo) ────────────────────────
    // DEBE completar con éxito antes de continuar. Sin ellas, cualquier upsert
    // de StockTienda rompería la FK tienda_id → Tienda.id.
    const tiendas = await pullTiendasFromCloud();
    if (tiendas === 0) {
      return;
    }
    console.info(`[SYNC] ⬇️  ${tiendas} tienda(s) cacheadas localmente.`);

    // ── Paso 2: Productos (cursor independiente lastProductPullAt) ────────────
    await pullProductosFromCloud();

    // ── Paso 3: StockTienda (cursor independiente lastStockPullAt) ────────────
    // Cursores separados: el timestamp del último producto nunca puede
    // "adelantar" el cursor de stock y ocultar stocks más antiguos.
    await pullStockTiendaFromCloud();

    console.info('[SYNC] ✅ Pull completado.');
  } catch (err) {
    console.error('[SYNC] ❌ ERROR durante el pull desde la nube:', err instanceof Error ? err.message : err);
    // No re-throw: un fallo en el pull no debe bloquear el ciclo de push
  }
}
