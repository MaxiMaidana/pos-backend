import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

const TIENDA_LOCAL_ID = process.env.TIENDA_LOCAL_ID!;

interface AbrirCajaBody {
  caja_id: string;
  cajero_nombre: string;
  monto_inicial: number;
}

interface CajaParams {
  caja_id: string;
}

interface CerrarCajaBody {
  monto_efectivo_contado: number;
}

interface MovimientoCajaBody {
  monto:  number;
  motivo: string;
  tipo:   'RETIRO' | 'INGRESO';
}

// Helper reutilizable para calcular el resumen de pagos de una sesión.
// Resta RETIROS y suma INGRESOS de MovimientoCaja para que el efectivo
// esperado en cajón sea matemáticamente correcto.
async function calcularResumenSesion(sesion_id: string, monto_inicial: number) {
  const ventaIds = await prisma.venta
    .findMany({
      where: { sesion_id, estado: 'PAGADA' },
      select: { id: true },
    })
    .then((vs) => vs.map((v) => v.id));

  const [pagosAgrupados, movimientos] = await Promise.all([
    prisma.pago.groupBy({
      by: ['metodo'],
      where: { venta_id: { in: ventaIds } },
      _sum: { monto: true },
    }),
    prisma.movimientoCaja.findMany({
      where: { sesion_id },
      select: { tipo: true, monto: true },
    }),
  ]);

  const resumenPagos = pagosAgrupados.map((p) => ({
    metodo: p.metodo,
    total:  p._sum?.monto ?? 0,
  }));

  const totalRecaudado  = resumenPagos.reduce((sum, p) => sum + p.total, 0);
  const efectivoVentas  = resumenPagos.find((p) => p.metodo === 'EFECTIVO')?.total ?? 0;

  const totalRetiros  = movimientos.filter(m => m.tipo === 'RETIRO').reduce((s, m) => s + m.monto, 0);
  const totalIngresos = movimientos.filter(m => m.tipo === 'INGRESO').reduce((s, m) => s + m.monto, 0);

  const efectivo_esperado = monto_inicial + efectivoVentas - totalRetiros + totalIngresos;

  return { resumenPagos, totalRecaudado, efectivoVentas, efectivo_esperado, totalRetiros, totalIngresos };
}

export async function abrirCaja(
  request: FastifyRequest<{ Body: AbrirCajaBody }>,
  reply: FastifyReply
) {
  try {
    const { caja_id, cajero_nombre, monto_inicial } = request.body;

    const caja = await prisma.caja.findUnique({ where: { id: caja_id } });
    if (!caja) {
      return reply.status(404).send({ error: 'Caja no encontrada' });
    }

    const sesionAbierta = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
    });
    if (sesionAbierta) {
      return reply.status(400).send({ error: `La ${caja.nombre} ya tiene una sesión abierta` });
    }

    const sesion = await prisma.sesionCaja.create({
      data: {
        cajero_nombre,
        monto_inicial,
        estado:    'ABIERTA',
        caja_id,
        tienda_id: TIENDA_LOCAL_ID,
      },
      include: { caja: true },
    });

    return reply.status(201).send(sesion);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al abrir la caja' });
  }
}

export async function obtenerArqueo(
  request: FastifyRequest<{ Params: CajaParams }>,
  reply: FastifyReply
) {
  try {
    const { caja_id } = request.params;

    const sesionAbierta = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
      include: { caja: true },
    });
    if (!sesionAbierta) {
      return reply.status(400).send({ error: 'Esa caja no tiene ninguna sesión abierta' });
    }

    const { resumenPagos, totalRecaudado, efectivoVentas, efectivo_esperado, totalRetiros, totalIngresos } =
      await calcularResumenSesion(sesionAbierta.id, sesionAbierta.monto_inicial);

    return reply.send({
      caja:                       sesionAbierta.caja,
      cajero:                     sesionAbierta.cajero_nombre,
      fecha_apertura:             sesionAbierta.fecha_apertura,
      monto_inicial:              sesionAbierta.monto_inicial,
      ventas_por_metodo:          resumenPagos,
      ventas_efectivo:            efectivoVentas,
      total_recaudado:            totalRecaudado,
      total_retiros:              totalRetiros,
      total_ingresos:             totalIngresos,
      efectivo_esperado_en_cajon: efectivo_esperado,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener el arqueo' });
  }
}

export async function cerrarCaja(
  request: FastifyRequest<{ Params: CajaParams; Body: CerrarCajaBody }>,
  reply: FastifyReply
) {
  try {
    const { caja_id } = request.params;
    const { monto_efectivo_contado } = request.body;

    if (monto_efectivo_contado == null || !Number.isFinite(Number(monto_efectivo_contado))) {
      return reply.status(400).send({ error: 'El campo monto_efectivo_contado es requerido y debe ser un número válido' });
    }

    // Garantiza que sea number aunque el cliente lo haya enviado como string
    const montoContado = Number(monto_efectivo_contado);

    const sesionAbierta = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
    });
    if (!sesionAbierta) {
      return reply.status(400).send({ error: 'Esa caja no tiene ninguna sesión abierta' });
    }

    const { resumenPagos, totalRecaudado, efectivo_esperado, totalRetiros, totalIngresos } =
      await calcularResumenSesion(sesionAbierta.id, sesionAbierta.monto_inicial);

    const diferencia = montoContado - efectivo_esperado;

    const mensaje =
      diferencia === 0
        ? 'Cierre exacto. Sin diferencias.'
        : diferencia > 0
          ? `Sobrante de $${diferencia.toFixed(2)}`
          : `Faltante de $${Math.abs(diferencia).toFixed(2)}`;

    const sesionCerrada = await prisma.sesionCaja.update({
      where: { id: sesionAbierta.id },
      data: {
        estado: 'CERRADA',
        fecha_cierre: new Date(),
        monto_efectivo_cierre: montoContado,
        diferencia,
      },
      include: { caja: true },
    });

    return reply.send({
      sesion: sesionCerrada,
      resumen_pagos:    resumenPagos,
      total_recaudado:  totalRecaudado,
      total_retiros:    totalRetiros,
      total_ingresos:   totalIngresos,
      efectivo_esperado,
      diferencia,
      mensaje,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al cerrar la caja' });
  }
}

export async function getCajas(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const cajas = await prisma.caja.findMany();
    return reply.status(200).send(cajas);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las cajas' });
  }
}

export async function registrarMovimiento(
  request: FastifyRequest<{ Params: CajaParams; Body: MovimientoCajaBody }>,
  reply: FastifyReply
) {
  try {
    const { caja_id }             = request.params;
    const { monto, motivo, tipo } = request.body;

    if (!monto || !Number.isFinite(Number(monto)) || Number(monto) <= 0) {
      return reply.status(400).send({ error: 'El campo monto debe ser un número positivo' });
    }
    if (!motivo || motivo.trim() === '') {
      return reply.status(400).send({ error: 'El campo motivo es requerido' });
    }
    if (tipo !== 'RETIRO' && tipo !== 'INGRESO') {
      return reply.status(400).send({ error: 'El campo tipo debe ser RETIRO o INGRESO' });
    }

    const sesionAbierta = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
    });
    if (!sesionAbierta) {
      return reply.status(400).send({ error: 'Esa caja no tiene ninguna sesión abierta' });
    }

    const movimiento = await prisma.movimientoCaja.create({
      data: {
        monto:     Number(monto),
        motivo:    motivo.trim(),
        tipo,
        sesion_id: sesionAbierta.id,
      },
    });

    return reply.status(201).send(movimiento);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al registrar el movimiento de caja' });
  }
}

export async function estadoCaja(
  request: FastifyRequest<{ Params: CajaParams }>,
  reply: FastifyReply
) {
  try {
    const { caja_id } = request.params;

    const sesion = await prisma.sesionCaja.findFirst({
      where: { caja_id, estado: 'ABIERTA' },
      include: {
        caja: true,
        ventas: {
          where: { estado: 'PAGADA' },
          include: { pagos: true },
        },
      },
    });

    return reply.send({ sesion: sesion ?? null });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener el estado de la caja' });
  }
}
