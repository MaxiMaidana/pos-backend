import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

interface DetalleInput {
  producto_id: string;
  cantidad: number;
  precio_unitario_historico: number;
}

interface PagoInput {
  metodo: string;
  monto: number;
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
        await tx.producto.update({
          where: { id: detalle.producto_id },
          data: { stock: { decrement: detalle.cantidad } },
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

    const totalPagado = pagos.reduce((sum, p) => sum + p.monto, 0);
    if (Math.abs(totalPagado - venta.total) > 0.01) {
      return reply.status(400).send({
        error: `El total de pagos (${totalPagado}) no coincide con el total de la venta (${venta.total})`,
      });
    }

    const ventaCobrada = await prisma.$transaction(async (tx) => {
      await tx.pago.createMany({
        data: pagos.map((p) => ({
          venta_id: id,
          metodo: p.metodo,
          monto: p.monto,
        })),
      });

      return tx.venta.update({
        where: { id },
        data: { estado: 'PAGADA', sesion_id: sesionAbierta.id },
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
    const { estado } = request.query as { estado?: string };

    const ventas = await prisma.venta.findMany({
      where: estado ? { estado } : undefined,
      orderBy: { created_at: 'desc' },
      include: {
        detalles: {
          include: { producto: true },
        },
        pagos: true,
      },
    });

    return reply.send(ventas);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las ventas' });
  }
}

export async function anularVenta(
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
      return reply
        .status(400)
        .send({ error: `Solo se pueden anular ventas en estado PENDIENTE. Estado actual: ${venta.estado}` });
    }

    await prisma.$transaction(async (tx) => {
      // Devolvemos el stock de cada producto a la estantería
      for (const detalle of venta.detalles) {
        await tx.producto.update({
          where: { id: detalle.producto_id },
          data: { stock: { increment: detalle.cantidad } },
        });
      }

      // Marcamos la venta como ANULADA (sin borrado físico)
      await tx.venta.update({
        where: { id },
        data: { estado: 'ANULADA' },
      });
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
        await tx.producto.update({
          where: { id: detalle.producto_id },
          data: { stock: { increment: detalle.cantidad } },
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
