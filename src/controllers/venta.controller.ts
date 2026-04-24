import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';

const TIENDA_LOCAL_ID = process.env.TIENDA_LOCAL_ID!;

interface DetalleInput {
  producto_id: string;
  cantidad: number;
  precio_unitario_historico: number;
}

interface PagoInput {
  metodo: string;
  monto:  number;
  cuotas?: number;
}

interface CreateComandaBody {
  vendedorId: string;
  descuento_total: number;
  detalles: DetalleInput[];
}

interface CobrarVentaBody {
  caja_id: string;
  pagos: PagoInput[];
}

interface VentaParams {
  id: string;
}

export async function createComanda(
  request: FastifyRequest<{ Body: CreateComandaBody }>,
  reply: FastifyReply
) {
  try {
    const { vendedorId, descuento_total, detalles } = request.body;

    // Validar que el vendedorId existe y está activo
    if (vendedorId) {
      const vendedor = await prisma.vendedor.findUnique({ where: { id: vendedorId } });
      if (!vendedor) {
        return reply.status(400).send({ error: 'Vendedor no encontrado' });
      }
      if (!vendedor.activo) {
        return reply.status(400).send({ error: 'El vendedor no está activo' });
      }
    }

    const subtotalBruto = detalles.reduce(
      (sum, d) => sum + d.cantidad * d.precio_unitario_historico,
      0
    );
    const total = subtotalBruto - descuento_total;

    const venta = await prisma.$transaction(async (tx) => {
      const nuevaVenta = await tx.venta.create({
        data: {
          estado:          'PENDIENTE',
          vendedorId,
          total,
          descuento_total,
          tienda_id: TIENDA_LOCAL_ID,
        },
      });

      await tx.detalleVenta.createMany({
        data: detalles.map((d) => ({
          venta_id: nuevaVenta.id,
          producto_id: d.producto_id,
          cantidad: d.cantidad,
          precio_unitario_historico: d.precio_unitario_historico,
          subtotal: d.cantidad * d.precio_unitario_historico,
        })),
      });

      for (const detalle of detalles) {
        await tx.stockTienda.updateMany({
          where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
          data:  { cantidad: { decrement: detalle.cantidad } },
        });
      }

      return tx.venta.findUnique({
        where: { id: nuevaVenta.id },
        include: { detalles: true },
      });
    });

    return reply.status(201).send(venta);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al crear la comanda' });
  }
}

interface CreateBorradorBody {
  vendedorId: string;
  descuento_total?: number;
  detalles: DetalleInput[];
}

interface UpdateBorradorBody {
  descuento_total?: number;
  detalles: DetalleInput[];
}

export async function createBorrador(
  request: FastifyRequest<{ Body: CreateBorradorBody }>,
  reply: FastifyReply
) {
  try {
    const { vendedorId, descuento_total = 0, detalles } = request.body;

    if (vendedorId) {
      const vendedor = await prisma.vendedor.findUnique({ where: { id: vendedorId } });
      if (!vendedor) {
        return reply.status(400).send({ error: 'Vendedor no encontrado' });
      }
      if (!vendedor.activo) {
        return reply.status(400).send({ error: 'El vendedor no está activo' });
      }
    }

    const subtotalBruto = (detalles ?? []).reduce(
      (sum, d) => sum + d.cantidad * d.precio_unitario_historico,
      0
    );
    const total = subtotalBruto - descuento_total;

    const venta = await prisma.$transaction(async (tx) => {
      const nuevaVenta = await tx.venta.create({
        data: {
          estado: 'BORRADOR',
          vendedorId,
          total,
          descuento_total,
          tienda_id: TIENDA_LOCAL_ID,
        },
      });

      if (detalles && detalles.length > 0) {
        await tx.detalleVenta.createMany({
          data: detalles.map((d) => ({
            venta_id: nuevaVenta.id,
            producto_id: d.producto_id,
            cantidad: d.cantidad,
            precio_unitario_historico: d.precio_unitario_historico,
            subtotal: d.cantidad * d.precio_unitario_historico,
          })),
        });
      }

      // NO se descuenta stock — el borrador no afecta inventario

      return tx.venta.findUnique({
        where: { id: nuevaVenta.id },
        include: { detalles: { include: { producto: true } }, vendedor: true },
      });
    });

    return reply.status(201).send(venta);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al crear el borrador' });
  }
}

export async function updateBorrador(
  request: FastifyRequest<{ Params: VentaParams; Body: UpdateBorradorBody }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    const { descuento_total, detalles } = request.body;

    const venta = await prisma.venta.findUnique({ where: { id } });
    if (!venta) {
      return reply.status(404).send({ error: 'Venta no encontrada' });
    }
    if (venta.estado !== 'BORRADOR') {
      return reply.status(400).send({ error: `Solo se pueden editar borradores. Estado actual: ${venta.estado}` });
    }

    const subtotalBruto = (detalles ?? []).reduce(
      (sum, d) => sum + d.cantidad * d.precio_unitario_historico,
      0
    );
    const descuento = descuento_total ?? venta.descuento_total;
    const total = subtotalBruto - descuento;

    const ventaActualizada = await prisma.$transaction(async (tx) => {
      // Eliminar los detalles anteriores
      await tx.detalleVenta.deleteMany({ where: { venta_id: id } });

      // Crear los nuevos detalles
      if (detalles && detalles.length > 0) {
        await tx.detalleVenta.createMany({
          data: detalles.map((d) => ({
            venta_id: id,
            producto_id: d.producto_id,
            cantidad: d.cantidad,
            precio_unitario_historico: d.precio_unitario_historico,
            subtotal: d.cantidad * d.precio_unitario_historico,
          })),
        });
      }

      // Actualizar total y descuento
      return tx.venta.update({
        where: { id },
        data: { total, descuento_total: descuento },
        include: { detalles: { include: { producto: true } }, vendedor: true },
      });
    });

    // NO se descuenta stock — sigue siendo borrador

    return reply.send(ventaActualizada);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al actualizar el borrador' });
  }
}

export async function confirmarBorrador(
  request: FastifyRequest<{ Params: VentaParams }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;

    const venta = await prisma.venta.findUnique({
      where: { id },
      include: { detalles: true },
    });

    if (!venta) {
      return reply.status(404).send({ error: 'Venta no encontrada' });
    }
    if (venta.estado !== 'BORRADOR') {
      return reply.status(400).send({ error: `Solo se pueden confirmar borradores. Estado actual: ${venta.estado}` });
    }
    if (venta.detalles.length === 0) {
      return reply.status(400).send({ error: 'No se puede confirmar un borrador sin productos' });
    }

    const ventaConfirmada = await prisma.$transaction(async (tx) => {
      // Descontar stock (permite stock negativo — el negocio acepta vender sin stock)
      for (const detalle of venta.detalles) {
        await tx.stockTienda.updateMany({
          where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
          data:  { cantidad: { decrement: detalle.cantidad } },
        });
      }

      return tx.venta.update({
        where: { id },
        data: { estado: 'PENDIENTE' },
        include: { detalles: { include: { producto: true } }, vendedor: true },
      });
    });

    return reply.send(ventaConfirmada);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al confirmar el borrador' });
  }
}

// Recargos por cuotas con tarjeta de crédito
const RECARGOS_POR_CUOTAS: Record<number, number> = {
  1: 0.05,   //  5 %
  2: 0.07,   //  7 %
  3: 0.10,   // 10 %
  6: 0.15,   // 15 %
};

function calcularTotalConRecargos(
  totalBase: number,
  pagos: PagoInput[]
): number {
  let recargosAcumulados = 0;

  for (const pago of pagos) {
    const esTarjetaCredito = pago.metodo === 'TARJETA_CREDITO';
    if (!esTarjetaCredito) continue;

    const cuotas          = pago.cuotas ?? 1;
    const recargoDecimal  = RECARGOS_POR_CUOTAS[cuotas] ?? 0;

    // Ingeniería inversa: el frontend ya envía monto CON recargo incluido.
    // Extraemos el monto base para obtener el recargo real sin duplicarlo.
    const montoBasePago       = pago.monto / (1 + recargoDecimal);
    const recargoRealAplicado = pago.monto - montoBasePago;

    recargosAcumulados += recargoRealAplicado;
  }

  return totalBase + recargosAcumulados;
}

export async function cobrarVenta(
  request: FastifyRequest<{ Params: VentaParams; Body: CobrarVentaBody }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    const { caja_id, pagos } = request.body;

    const venta = await prisma.venta.findUnique({ where: { id } });

    if (!venta) {
      return reply.status(404).send({ error: 'Venta no encontrada' });
    }
    if (venta.estado !== 'PENDIENTE') {
      return reply.status(400).send({ error: `La venta ya está en estado ${venta.estado}` });
    }

    const sesionAbierta = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
    });
    if (!sesionAbierta) {
      return reply.status(400).send({ error: 'Esa caja no está abierta' });
    }

    const totalPagado        = pagos.reduce((sum, p) => sum + p.monto, 0);
    const totalConRecargos   = calcularTotalConRecargos(venta.total, pagos);
    const hayRecargo         = Math.abs(totalConRecargos - venta.total) > 0.01;

    // Validar que lo que manda el frontend coincide con el total esperado
    if (Math.abs(totalPagado - totalConRecargos) > 0.01) {
      return reply.status(400).send({
        error: `El total de pagos (${totalPagado.toFixed(2)}) no coincide con el total esperado (${totalConRecargos.toFixed(2)})`,
      });
    }

    const ventaCobrada = await prisma.$transaction(async (tx) => {
      await tx.pago.createMany({
        data: pagos.map((p) => ({
          venta_id: id,
          metodo:   p.metodo,
          monto:    p.monto,
          cuotas:   p.cuotas ?? 1,
        })),
      });

      return tx.venta.update({
        where: { id },
        data: {
          estado:     'PAGADA',
          sesion_id:  sesionAbierta.id,
          synced_at:  null, // Resetear para que el sync la vuelva a detectar como pendiente
          // Actualiza el total solo si hay recargo para mantener trazabilidad
          ...(hayRecargo && { total: totalConRecargos }),
        },
        include: { detalles: true, pagos: true },
      });
    });

    return reply.send(ventaCobrada);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al cobrar la venta' });
  }
}

interface GetVentasQuery {
  page?:       string;
  limit?:      string;
  id?:         string;
  estado?:     string;
  fecha?:      string;
  vendedorId?: string;
  sesion_id?:  string;
}

// Misma constante que el dashboard: Argentina es UTC-3 sin DST.
const ARGENTINA_OFFSET_MS = 3 * 60 * 60 * 1000;

function buildRangoDiaVentas(fecha: string): { gte: Date; lte: Date } {
  const inicio = new Date(`${fecha}T03:00:00.000Z`);
  const fin    = new Date(inicio.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { gte: inicio, lte: fin };
}

function todayArgentina(): string {
  const arDate = new Date(Date.now() - ARGENTINA_OFFSET_MS);
  return arDate.toISOString().slice(0, 10);
}

export async function getVentas(
  request: FastifyRequest<{ Querystring: GetVentasQuery }>,
  reply: FastifyReply
) {
  try {
    const { id, estado, fecha, vendedorId, sesion_id } = request.query;

    const page  = Math.max(1, parseInt(request.query.page  ?? '1',  10));
    const limit = Math.max(1, parseInt(request.query.limit ?? '30', 10));
    const skip  = (page - 1) * limit;

    // Si viene un id exacto, devolvemos solo ese ticket (sin paginación necesaria).
    if (id) {
      const venta = await prisma.venta.findUnique({
        where: { id },
        include: {
          detalles: { include: { producto: true } },
          pagos:    true,
          sesion:   { include: { caja: true } },
          vendedor: true,
        },
      });
      if (!venta) return reply.status(404).send({ error: 'Venta no encontrada' });
      return reply.send({ data: [venta], meta: { total: 1, page: 1, limit: 1, totalPages: 1 } });
    }

    // Filtro de fecha: si no se especifica, se usa el día de hoy en Argentina.
    const fechaFiltro = fecha ?? todayArgentina();

    const where: Prisma.VentaWhereInput = {
      created_at: buildRangoDiaVentas(fechaFiltro),
      estado: estado
        ? estado
        : sesion_id
          ? { in: ['PAGADA', 'ANULADA'] }
          : undefined,
      ...(vendedorId && { vendedorId }),
      ...(sesion_id  && { sesion_id }),
    };

    const [total, data] = await prisma.$transaction([
      prisma.venta.count({ where }),
      prisma.venta.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip,
        take: limit,
        include: {
          detalles: { include: { producto: true } },
          pagos:    true,
          sesion:   { include: { caja: true } },
          vendedor: true,
        },
      }),
    ]);

    return reply.send({
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las ventas' });
  }
}

export async function anularVenta(
  request: FastifyRequest<{ Params: VentaParams; Body: { sesion_id?: string } }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    const { sesion_id } = request.body ?? {};

    const venta = await prisma.venta.findUnique({
      where: { id },
      include: { detalles: true },
    });

    if (!venta) {
      return reply.status(404).send({ error: 'Venta no encontrada' });
    }
    if (venta.estado !== 'PENDIENTE' && venta.estado !== 'BORRADOR') {
      return reply
        .status(400)
        .send({ error: `Solo se pueden anular ventas en estado PENDIENTE o BORRADOR. Estado actual: ${venta.estado}` });
    }

    await prisma.$transaction(async (tx) => {
      // Solo devolver stock si la venta estaba en PENDIENTE (BORRADOR nunca descontó)
      if (venta.estado === 'PENDIENTE') {
        for (const detalle of venta.detalles) {
          await tx.stockTienda.updateMany({
            where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
            data:  { cantidad: { increment: detalle.cantidad } },
          });
        }
      }

      // Construimos data explícitamente para evitar que el spread con && ignore valores falsy
      const dataToUpdate: Prisma.VentaUpdateInput = { estado: 'ANULADA' };
      if (sesion_id) dataToUpdate.sesion = { connect: { id: sesion_id } };

      await tx.venta.update({ where: { id }, data: dataToUpdate });
    });

    return reply.status(200).send({ message: `Venta ${id} anulada correctamente.` });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al anular la venta' });
  }
}

export async function cancelarVenta(
  request: FastifyRequest<{ Params: VentaParams }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;

    const venta = await prisma.venta.findUnique({
      where: { id },
      include: { detalles: true },
    });

    if (!venta) {
      return reply.status(404).send({ error: 'Venta no encontrada' });
    }
    if (venta.estado !== 'PENDIENTE' && venta.estado !== 'BORRADOR') {
      return reply.status(400).send({ error: `La venta ya está en estado ${venta.estado}` });
    }

    const ventaCancelada = await prisma.$transaction(async (tx) => {
      // Solo devolver stock si la venta estaba en PENDIENTE (BORRADOR nunca descontó)
      if (venta.estado === 'PENDIENTE') {
        for (const detalle of venta.detalles) {
          await tx.stockTienda.updateMany({
            where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
            data:  { cantidad: { increment: detalle.cantidad } },
          });
        }
      }

      return tx.venta.update({
        where: { id },
        data: { estado: 'CANCELADA' },
        include: { detalles: true },
      });
    });

    return reply.send(ventaCancelada);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al cancelar la venta' });
  }
}
