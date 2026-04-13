import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

// ── Helper compartido ─────────────────────────────────────────────────────────
function buildRangoDia(fecha?: string): { gte: Date; lte: Date } {
  const base = fecha ? new Date(`${fecha}T00:00:00`) : new Date();
  const inicio = new Date(base);
  inicio.setHours(0, 0, 0, 0);
  const fin = new Date(base);
  fin.setHours(23, 59, 59, 999);
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

    const [ventasTotales, ventasCanceladas, recaudacion, productosStockBajo, pagosPorMetodo] =
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

        // Stock crítico — filtra por tienda si se pide, si no muestra cualquier tienda
        prisma.producto.count({
          where: {
            activo: true,
            stocks: {
              some: {
                cantidad: { lte: 5 },
                ...(filtrotiendaId
                  ? { tienda_id: filtrotiendaId }
                  : {}),
              },
            },
          },
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

    // Convertir el array de groupBy en un objeto clave→monto
    const desglosePagosGlobal: Record<string, number> = {};
    for (const row of pagosPorMetodo) {
      desglosePagosGlobal[row.metodo] = row._sum?.monto ?? 0;
    }

    return reply.send({
      fecha:               fecha ?? new Date().toISOString().slice(0, 10),
      tienda_id:           filtrotiendaId ?? null,
      ventasTotales,
      ventasCanceladas,
      recaudacionTotal:    recaudacion._sum?.total ?? 0,
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
        by: ['vendedor_nombre'],
        where: {
          created_at: rango,
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        _count: { _all: true },
        orderBy: { _count: { vendedor_nombre: 'desc' } },
      }),

      // 2. Solo PAGADAS: para calcular recaudacionTotal
      prisma.venta.groupBy({
        by: ['vendedor_nombre'],
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
        by: ['vendedor_nombre'],
        where: {
          created_at: rango,
          estado: 'ANULADA',
          ...(filtrotiendaId && { tienda_id: filtrotiendaId }),
        },
        _count: { _all: true },
        orderBy: { _count: { vendedor_nombre: 'desc' } },
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
    const mapaRecaudacion = new Map(
      ventasCobradas.map((v) => [v.vendedor_nombre, v._sum?.total ?? 0])
    );
    const mapaAnulaciones = new Map(
      ventasAnuladas.map((v) => [
        v.vendedor_nombre,
        (v._count as { _all: number })._all ?? 0,
      ])
    );

    const rendimientoVendedores = todasVentas.map((v) => ({
      vendedor:         v.vendedor_nombre,
      cantidadVentas:   (v._count as { _all: number })._all ?? 0,
      recaudacionTotal: mapaRecaudacion.get(v.vendedor_nombre) ?? 0,
      cantidadAnuladas: mapaAnulaciones.get(v.vendedor_nombre) ?? 0,
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
