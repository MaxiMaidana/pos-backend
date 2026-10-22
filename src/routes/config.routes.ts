import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import { supabase } from '../db/supabase.js';

const COMERCIO_ID = process.env.COMERCIO_ID;
if (!COMERCIO_ID) {
  throw new Error('[CONFIG] La variable de entorno COMERCIO_ID no está configurada.');
}

const DEFAULT_RECARGOS: Record<string, number> = {
  '1': 0.05,
  '2': 0.07,
  '3': 0.10,
  '6': 0.15,
};

// ── Helper reutilizable ──────────────────────────────────────────────────────
// Parsea el string JSON de recargos_credito y devuelve un Record<number, number>.
// En caso de error de parseo retorna los valores por defecto.
export function parseRecargosCredito(raw?: string | null): Record<number, number> {
  if (!raw) {
    return Object.fromEntries(
      Object.entries(DEFAULT_RECARGOS).map(([k, v]) => [Number(k), v])
    );
  }
  try {
    const parsed: Record<string, number> = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [Number(k), v])
    );
  } catch {
    return Object.fromEntries(
      Object.entries(DEFAULT_RECARGOS).map(([k, v]) => [Number(k), v])
    );
  }
}

// ── GET /api/config ──────────────────────────────────────────────────────────
async function getConfig(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const config = await prisma.configuracionTienda.findUnique({ where: { id: 1 } });

    if (!config) {
      return reply.status(404).send({ error: 'Configuración no encontrada' });
    }

    return reply.send({
      ...config,
      recargos_credito: parseRecargosCredito(config.recargos_credito),
      modoCajaSimple: process.env.MODO_CAJA_SIMPLE === 'true',
      cajaId: process.env.CAJA_ID ?? null,
    });
  } catch (error) {
    _request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener la configuración' });
  }
}

// ── PUT /api/config/recargos ─────────────────────────────────────────────────
interface UpdateRecargosBody {
  recargos_credito: Record<string, number>;
}

async function updateRecargos(
  request: FastifyRequest<{ Body: UpdateRecargosBody }>,
  reply: FastifyReply,
) {
  try {
    const { recargos_credito } = request.body;

    if (!recargos_credito || typeof recargos_credito !== 'object') {
      return reply.status(400).send({ error: 'recargos_credito debe ser un objeto { cuotas: porcentaje }' });
    }

    // Validar que las claves sean números válidos y los valores porcentajes razonables
    for (const [key, value] of Object.entries(recargos_credito)) {
      const cuota = Number(key);
      if (isNaN(cuota) || cuota < 1) {
        return reply.status(400).send({ error: `Cuota inválida: "${key}". Debe ser un número >= 1` });
      }
      if (typeof value !== 'number' || value < 0 || value > 1) {
        return reply.status(400).send({ error: `Porcentaje inválido para cuota ${key}: ${value}. Debe ser un número entre 0 y 1` });
      }
    }

    const recargosJson = JSON.stringify(recargos_credito);

    const config = await prisma.configuracionTienda.upsert({
      where: { id: 1 },
      update: { recargos_credito: recargosJson },
      create: {
        id:                1,
        cuit:              '00000000000',
        razonSocial:       'Sin configurar',
        condicionFiscal:   'MONOTRIBUTO',
        puntoVenta:        1,
        entornoProduccion: false,
        recargos_credito:  recargosJson,
      },
    });

    return reply.send({
      ...config,
      recargos_credito: parseRecargosCredito(config.recargos_credito),
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al actualizar los recargos' });
  }
}

// ── PUT /api/config ──────────────────────────────────────────────────────────
interface UpdateConfigBody {
  cuit?: string;
  razonSocial?: string;
  condicionFiscal?: 'MONOTRIBUTO' | 'RESPONSABLE_INSCRIPTO';
  puntoVenta?: number;
  entornoProduccion?: boolean;
  facturacionHabilitada?: boolean;
  transferenciaConsumidorFinal?: boolean;
  colorPrimario?: string;
}

async function updateConfig(
  request: FastifyRequest<{ Body: UpdateConfigBody }>,
  reply: FastifyReply,
) {
  try {
    const { cuit, razonSocial, condicionFiscal, puntoVenta, entornoProduccion, facturacionHabilitada, transferenciaConsumidorFinal, colorPrimario } = request.body;

    const config = await prisma.configuracionTienda.upsert({
      where: { id: 1 },
      update: {
        ...(cuit                          !== undefined && { cuit }),
        ...(razonSocial                   !== undefined && { razonSocial }),
        ...(condicionFiscal               !== undefined && { condicionFiscal }),
        ...(puntoVenta                    !== undefined && { puntoVenta }),
        ...(entornoProduccion             !== undefined && { entornoProduccion }),
        ...(facturacionHabilitada         !== undefined && { facturacionHabilitada }),
        ...(transferenciaConsumidorFinal  !== undefined && { transferenciaConsumidorFinal }),
        ...(colorPrimario                 !== undefined && { colorPrimario }),
      },
      create: {
        id:                           1,
        cuit:                         cuit                  ?? '00000000000',
        razonSocial:                  razonSocial           ?? 'Sin configurar',
        condicionFiscal:              condicionFiscal       ?? 'MONOTRIBUTO',
        puntoVenta:                   puntoVenta            ?? 1,
        entornoProduccion:            entornoProduccion     ?? false,
        facturacionHabilitada:        facturacionHabilitada ?? false,
        transferenciaConsumidorFinal: transferenciaConsumidorFinal ?? false,
        colorPrimario:                colorPrimario ?? null,
      },
    });

    // Propaga color/identidad fiscal a los otros locales del mismo comercio
    // vía la nube — fire-and-forget, el guardado local ya está confirmado.
    // puntoVenta queda afuera a propósito: es un dato por local, no del
    // comercio. Cada local lo toma recién al arrancar su backend (ver
    // pullConfiguracionGlobalOnce en index.ts), no hay polling.
    if (colorPrimario !== undefined || cuit !== undefined || razonSocial !== undefined || condicionFiscal !== undefined) {
      const payloadGlobal: Record<string, unknown> = { comercio_id: COMERCIO_ID, updated_at: new Date().toISOString() };
      if (colorPrimario   !== undefined) payloadGlobal.colorPrimario   = colorPrimario;
      if (cuit             !== undefined) payloadGlobal.cuit            = cuit;
      if (razonSocial      !== undefined) payloadGlobal.razonSocial     = razonSocial;
      if (condicionFiscal  !== undefined) payloadGlobal.condicionFiscal = condicionFiscal;

      supabase
        .from('ConfiguracionGlobal')
        .upsert(payloadGlobal)
        .then(({ error }) => {
          if (error) request.log.error({ error }, 'Error al propagar config global a la nube');
        });
    }

    return reply.send({
      ...config,
      recargos_credito: parseRecargosCredito(config.recargos_credito),
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al actualizar la configuración' });
  }
}

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/config', getConfig);
  fastify.put('/config', updateConfig);
  fastify.put('/config/recargos', updateRecargos);
}
