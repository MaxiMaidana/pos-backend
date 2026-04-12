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
  vendedor_nombre: string;
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
    const { vendedor_nombre, descuento_total, detalles } = request.body;

    const subtotalBruto = detalles.reduce(
      (sum, d) => sum + d.cantidad * d.precio_unitario_historico,
      0
    );
    const total = subtotalBruto - descuento_total;

    const venta = await prisma.$transaction(async (tx) => {
      const nuevaVenta = await tx.venta.create({
        data: {
          estado: 'PENDIENTE',
          vendedor_nombre,
          total,
          descuento_total,
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

export async function getVentas(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const { estado, fecha, vendedor_nombre, sesion_id } = request.query as {
      estado?:          string;
      fecha?:           string;
      vendedor_nombre?: string;
      sesion_id?:       string;
    };

    const where: Prisma.VentaWhereInput = {
      // Si viene sesion_id sin estado explícito, devolvemos PAGADA y ANULADA
      // (las PENDIENTE no tienen sesion_id asignado todavía)
      estado: estado
        ? estado
        : sesion_id
          ? { in: ['PAGADA', 'ANULADA'] }
          : undefined,
      ...(vendedor_nombre && { vendedor_nombre: { contains: vendedor_nombre } }),
      ...(sesion_id       && { sesion_id }),
      ...(fecha           && {
        created_at: {
          gte: new Date(`${fecha}T00:00:00`),
          lte: new Date(`${fecha}T23:59:59.999`),
        },
      }),
    };

    const ventas = await prisma.venta.findMany({
      where,
      orderBy: { created_at: 'desc' },
      include: {
        detalles: {
          include: { producto: true },
        },
        pagos: true,
        sesion: {
          include: { caja: true },
        },
      },
    });

    return reply.send(ventas);
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
    if (venta.estado !== 'PENDIENTE') {
      return reply
        .status(400)
        .send({ error: `Solo se pueden anular ventas en estado PENDIENTE. Estado actual: ${venta.estado}` });
    }

    await prisma.$transaction(async (tx) => {
      for (const detalle of venta.detalles) {
        await tx.stockTienda.updateMany({
          where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
          data:  { cantidad: { increment: detalle.cantidad } },
        });
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
    if (venta.estado !== 'PENDIENTE') {
      return reply.status(400).send({ error: `La venta ya está en estado ${venta.estado}` });
    }

    const ventaCancelada = await prisma.$transaction(async (tx) => {
      for (const detalle of venta.detalles) {
        await tx.stockTienda.updateMany({
          where: { producto_id: detalle.producto_id, tienda_id: TIENDA_LOCAL_ID },
          data:  { cantidad: { increment: detalle.cantidad } },
        });
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
