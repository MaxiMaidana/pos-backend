import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import { parseRecargosCredito } from './config.routes.js';

// ── Helper compartido ─────────────────────────────────────────────────────────
// Argentina es UTC-3 sin DST. Para filtrar correctamente en Vercel (UTC):
//   00:00:00 AR = 03:00:00 UTC  →  inicio = `${fecha}T03:00:00.000Z`
//   23:59:59 AR = 02:59:59 UTC del día siguiente → fin = inicio + 24h - 1ms
//
// Si el frontend no envía `fecha`, calculamos "hoy en Argentina" manualmente
// restando 3 horas al reloj UTC del servidor (sin depender del TZ local).

const ARGENTINA_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 → 3h en ms

function toArgentinaDateStr(utcDate: Date): string {
  // Desplaza el Date al "reloj argentino" y extrae YYYY-MM-DD.
  const arDate = new Date(utcDate.getTime() - ARGENTINA_OFFSET_MS);
  return arDate.toISOString().slice(0, 10);
}

function buildRangoDia(fecha?: string): { gte: Date; lte: Date } {
  const dateStr = fecha ?? toArgentinaDateStr(new Date());
  // Midnight Argentina (UTC-3) expresado en UTC: sumar 3 horas al string de fecha.
  const inicio = new Date(`${dateStr}T03:00:00.000Z`);
  const fin    = new Date(inicio.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { gte: inicio, lte: fin };
}

interface StatsQuery { fecha?: string; tienda_id?: string; }
interface AnaliticasQuery { fecha?: string; tienda_id?: string; }

// ── GET /api/dashboard/stats ─────────────────────────────────────────────────
async function getDashboardStats(
  request: FastifyRequest<{ Querystring: StatsQuery }>,
  reply: FastifyReply
) {
  try {
    const { fecha, tienda_id } = request.query;
    const rango = buildRangoDia(fecha);
    const filtrotiendaId = tienda_id || undefined;

    // Reutilizable: ventas cobradas del día (mutable para que Prisma lo acepte)
    const whereVentasPagadas = {
      created_at: rango,
      estado: { notIn: ['PENDIENTE', 'ANULADA', 'CANCELADA'] as string[] },
      ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
    };

    const [ventasTotales, ventasCanceladas, recaudacion, pagosPorMetodo] =
      await prisma.$transaction([
        // Ventas efectivamente cobradas en la fecha
        prisma.venta.count({ where: whereVentasPagadas }),

        // Ventas anuladas en la fecha
        prisma.venta.count({
          where: {
            created_at: rango,
            estado: 'ANULADA',
            ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
          },
        }),

        // Suma total recaudado
        prisma.venta.aggregate({
          where: whereVentasPagadas,
          _sum: { total: true },
        }),

        // Desglose de pagos agrupado por método
        prisma.pago.groupBy({
          by: ['metodo'],
          where: {
            venta: {
              created_at: rango,
              estado: 'PAGADA',
              ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
            },
          },
          _sum:     { monto: true },
          orderBy:  { metodo: 'asc' },
        }),
      ]);

    // Stock crítico — usa LEFT JOIN para capturar productos sin registro en StockTienda
    // (cantidad NULL = stock 0, que también es stock bajo).
    //
    // Vista por sucursal: un producto aparece si su cantidad en esa tienda es <= stock_minimo
    //                     OR directamente no tiene fila en StockTienda para esa tienda.
    //
    // Vista global: un producto aparece si EN AL MENOS UNA tienda su cantidad es <= stock_minimo,
    //               O si le falta el registro de stock en alguna tienda (LEFT JOIN → NULL).
    let productosStockBajo: number;

    if (filtrotiendaId) {
      // Vista por sucursal: LEFT JOIN filtrando por tienda concreta.
      const rows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT p.id) AS count
        FROM "Producto" p
        LEFT JOIN "StockTienda" st
          ON st.producto_id = p.id AND st.tienda_id = ${filtrotiendaId}
        WHERE p.activo = true
          AND p.eliminado = false
          AND (st.cantidad IS NULL OR st.cantidad <= p.stock_minimo)
      `;
      productosStockBajo = Number(rows[0]?.count ?? 0);
    } else {
      // Vista global: obtenemos todos los ids de tiendas activas y el stock por producto.
      // Un producto alerta si en CUALQUIER tienda tiene stock <= stock_minimo o no tiene registro.
      const tiendas = await prisma.tienda.findMany({ select: { id: true } });
      const totalTiendas = tiendas.length;

      if (totalTiendas === 0) {
        productosStockBajo = 0;
      } else {
        // Contamos cuántas filas de StockTienda tiene cada producto y cuántas están bien.
        // "bien" = tiene registro Y cantidad > stock_minimo.
        // Si filasOk < totalTiendas → hay al menos una tienda con problema.
        const rows = await prisma.$queryRaw<{ count: bigint }[]>`
          SELECT COUNT(DISTINCT p.id) AS count
          FROM "Producto" p
          WHERE p.activo = true
            AND p.eliminado = false
            AND (
              -- Tiene al menos una tienda con stock bajo
              EXISTS (
                SELECT 1 FROM "StockTienda" st
                WHERE st.producto_id = p.id
                  AND st.cantidad <= p.stock_minimo
              )
              OR
              -- Le falta el registro en alguna tienda (stock implícito = 0 <= stock_minimo)
              (
                SELECT COUNT(*) FROM "StockTienda" st
                WHERE st.producto_id = p.id
              ) < ${totalTiendas}
            )
        `;
        productosStockBajo = Number(rows[0]?.count ?? 0);
      }
    }

    // Convertir el array de groupBy en un objeto clave→monto
    const desglosePagosGlobal: Record<string, number> = {};
    for (const row of pagosPorMetodo) {
      desglosePagosGlobal[row.metodo] = row._sum?.monto ?? 0;
    }

    // ── Recaudación neta: descontar recargos de tarjeta crédito ──────────────
    const recaudacionBruta = recaudacion._sum?.total ?? 0;
    let totalRecargos = 0;

    if (desglosePagosGlobal['TARJETA_CREDITO']) {
      const config = await prisma.configuracionTienda.findUnique({
        where: { id: 1 },
        select: { recargos_credito: true },
      });
      const recargosPorCuotas = parseRecargosCredito(config?.recargos_credito);

      // Obtener pagos individuales de tarjeta crédito para aplicar ingeniería inversa
      const pagosCredito = await prisma.pago.findMany({
        where: {
          metodo: 'TARJETA_CREDITO',
          venta: {
            created_at: rango,
            estado: 'PAGADA',
            ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
          },
        },
        select: { monto: true, cuotas: true },
      });

      for (const pago of pagosCredito) {
        const cuotas = pago.cuotas ?? 1;
        const recargoDecimal = recargosPorCuotas[cuotas] ?? 0;
        const montoBase = pago.monto / (1 + recargoDecimal);
        totalRecargos += pago.monto - montoBase;
      }
    }

    return reply.send({
      fecha:               fecha ?? new Date().toISOString().slice(0, 10),
      tienda_id:           filtrotiendaId ?? null,
      ventasTotales,
      ventasCanceladas,
      recaudacionTotal:    recaudacionBruta,
      recaudacionNeta:     recaudacionBruta - totalRecargos,
      totalRecargos,
      productosStockBajo,
      desglosePagosGlobal,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las estadísticas del dashboard' });
  }
}

// ── GET /api/dashboard/analiticas ────────────────────────────────────────────
async function getAnaliticas(
  request: FastifyRequest<{ Querystring: AnaliticasQuery }>,
  reply: FastifyReply
) {
  try {
    const { fecha, tienda_id } = request.query;
    const rango = buildRangoDia(fecha);
    const filtrotiendaId = tienda_id || undefined;

    const [todasVentas, ventasCobradas, ventasAnuladas, sesiones] = await prisma.$transaction([

      // 1. Volumen total: TODAS las ventas del vendedor ese día (todos los estados)
      prisma.venta.groupBy({
        by: ['vendedorId'],
        where: {
          created_at: rango,
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        _count: { _all: true },
        orderBy: { _count: { vendedorId: 'desc' } },
      }),

      // 2. Solo PAGADAS: para calcular recaudacionTotal
      prisma.venta.groupBy({
        by: ['vendedorId'],
        where: {
          created_at: rango,
          estado: 'PAGADA',
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        _sum: { total: true },
        orderBy: { _sum: { total: 'desc' } },
      }),

      // 3. Anulaciones agrupadas por vendedor
      prisma.venta.groupBy({
        by: ['vendedorId'],
        where: {
          created_at: rango,
          estado: 'ANULADA',
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        _count: { _all: true },
        orderBy: { _count: { vendedorId: 'desc' } },
      }),

      // 4. Sesiones de caja del día — incluye PAGADAS y ANULADAS con sus pagos y movimientos
      prisma.sesionCaja.findMany({
        where: {
          fecha_apertura: rango,
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        include: {
          caja: true,
          ventas: {
            where: { estado: { in: ['PAGADA', 'ANULADA'] } },
            include: { pagos: true },
          },
          movimientos: true,
        },
      }),
    ]);

    // ── Merge: un objeto por vendedor combinando las 3 fuentes ────────────────
    // Recolectar todos los vendedorId únicos para hacer un solo query
    const allVendedorIds = new Set<string>();
    for (const v of todasVentas) if (v.vendedorId) allVendedorIds.add(v.vendedorId);
    for (const v of ventasCobradas) if (v.vendedorId) allVendedorIds.add(v.vendedorId);
    for (const v of ventasAnuladas) if (v.vendedorId) allVendedorIds.add(v.vendedorId);

    const vendedoresDb = await prisma.vendedor.findMany({
      where: { id: { in: [...allVendedorIds] } },
      select: { id: true, nombre: true },
    });
    const mapaNombres = new Map(vendedoresDb.map((v) => [v.id, v.nombre]));

    const mapaRecaudacion = new Map(
      ventasCobradas.map((v) => [v.vendedorId, v._sum?.total ?? 0])
    );
    const mapaAnulaciones = new Map(
      ventasAnuladas.map((v) => [
        v.vendedorId,
        (v._count as { _all: number })._all ?? 0,
      ])
    );

    const rendimientoVendedores = todasVentas.map((v) => ({
      vendedorId:       v.vendedorId,
      vendedor:         mapaNombres.get(v.vendedorId ?? '') ?? 'Sin vendedor',
      cantidadVentas:   (v._count as { _all: number })._all ?? 0,
      recaudacionTotal: mapaRecaudacion.get(v.vendedorId) ?? 0,
      cantidadAnuladas: mapaAnulaciones.get(v.vendedorId) ?? 0,
    }));

    // Ordenar por recaudacionTotal descendente
    rendimientoVendedores.sort((a, b) => b.recaudacionTotal - a.recaudacionTotal);

    // ── Reporte de cajas con desglose por método de pago ─────────────────────
    const reporteCajas = sesiones.map((sesion) => {
      const todosLosPagos = sesion.ventas.flatMap((v) => v.pagos);

      // Agrupa montos por método (EFECTIVO, TARJETA, TRANSFERENCIA…)
      const desglosePagos: Record<string, number> = {};
      for (const pago of todosLosPagos) {
        desglosePagos[pago.metodo] = (desglosePagos[pago.metodo] ?? 0) + pago.monto;
      }

      const efectivoVentas = desglosePagos['EFECTIVO'] ?? 0;

      // Sumar retiros e ingresos manuales de caja
      const totalRetiros = sesion.movimientos
        .filter((m) => m.tipo === 'RETIRO')
        .reduce((acc, m) => acc + m.monto, 0);
      const totalIngresos = sesion.movimientos
        .filter((m) => m.tipo === 'INGRESO')
        .reduce((acc, m) => acc + m.monto, 0);

      const monto_esperado =
        sesion.monto_inicial + efectivoVentas - totalRetiros + totalIngresos;

      let diferencia: number | null = null;
      let resultado: 'Exacto' | 'Sobrante' | 'Faltante' | 'Pendiente de cierre' =
        'Pendiente de cierre';

      if (sesion.monto_efectivo_cierre != null) {
        diferencia = sesion.monto_efectivo_cierre - monto_esperado;
        resultado  =
          diferencia === 0 ? 'Exacto'   :
          diferencia  >  0 ? 'Sobrante' :
                             'Faltante';
      }

      return {
        sesion_id:     sesion.id,
        caja_id:       sesion.caja_id,
        caja:          sesion.caja.nombre,
        cajero_nombre: sesion.cajero_nombre,
        estado:        sesion.estado,
        fecha_apertura: sesion.fecha_apertura,
        fecha_cierre:  sesion.fecha_cierre ?? null,
        monto_inicial: sesion.monto_inicial,
        monto_cierre:  sesion.monto_efectivo_cierre ?? null,
        desglosePagos,
        retiros:       totalRetiros,
        ingresos:      totalIngresos,
        monto_esperado,
        diferencia,
        resultado,
      };
    });

    return reply.send({
      fecha:                 fecha ?? new Date().toISOString().slice(0, 10),
      tienda_id:             filtrotiendaId ?? null,
      rendimientoVendedores,
      reporteCajas,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las analíticas' });
  }
}

export async function dashboardRoutes(fastify: FastifyInstance) {
  fastify.get('/dashboard/stats',     getDashboardStats);
  fastify.get('/dashboard/analiticas', getAnaliticas);
}
