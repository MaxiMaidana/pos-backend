import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import { supabase } from '../db/supabase.js';

const COMERCIO_ID = process.env.COMERCIO_ID;
if (!COMERCIO_ID) {
  throw new Error('[CONFIG] La variable de entorno COMERCIO_ID no está configurada.');
}

// ── GET /api/tiendas ──────────────────────────────────────────────────────────
async function getTiendas(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const tiendas = await prisma.tienda.findMany({
      where: { comercio_id: COMERCIO_ID },
      select: { id: true, nombre: true, direccion: true, facturacionHabilitada: true },
      orderBy: { nombre: 'asc' },
    });
    return reply.send(tiendas);
  } catch (error) {
    _request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las tiendas' });
  }
}

// ── PUT /api/tiendas/:id/facturacion ──────────────────────────────────────────
async function updateTiendaFacturacion(
  request: FastifyRequest<{ Params: { id: string }; Body: { habilitada: boolean } }>,
  reply: FastifyReply,
) {
  const { id } = request.params;
  const { habilitada } = request.body;

  if (typeof habilitada !== 'boolean') {
    return reply.status(400).send({ error: 'habilitada debe ser boolean' });
  }

  try {
    // Actualizar local
    const tienda = await prisma.tienda.update({
      where: { id, comercio_id: COMERCIO_ID },
      data: { facturacionHabilitada: habilitada },
    });

    // Propagar a Supabase inmediatamente
    const { error } = await supabase
      .from('Tienda')
      .update({ facturacion_habilitada: habilitada })
      .eq('id', id);
    if (error) request.log.warn(`[TIENDA] Supabase update failed: ${error.message}`);

    // Si es la tienda local, actualizar ConfiguracionTienda también
    const tiendaLocalId = process.env.TIENDA_LOCAL_ID;
    if (tiendaLocalId && id === tiendaLocalId) {
      await prisma.configuracionTienda.updateMany({
        where: { id: 1 },
        data: { facturacionHabilitada: habilitada },
      });
    }

    return reply.send(tienda);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al actualizar la tienda' });
  }
}

export async function tiendaRoutes(fastify: FastifyInstance) {
  fastify.get('/tiendas', getTiendas);
  fastify.put('/tiendas/:id/facturacion', updateTiendaFacturacion);
}
