import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { syncVentasToCloud, syncProductosToCloud, syncCajasToCloud, syncSesionesCajaToCloud } from '../services/sync.service.js';

async function syncManual(_request: FastifyRequest, reply: FastifyReply) {
  try {
    await syncCajasToCloud();
    await syncSesionesCajaToCloud();
    await syncProductosToCloud();
    await syncVentasToCloud();
    return reply.send({ success: true, message: 'Sincronización completada' });
  } catch (error) {
    _request.log.error(error);
    return reply.status(500).send({ success: false, error: 'Error durante la sincronización' });
  }
}

export async function syncRoutes(fastify: FastifyInstance) {
  fastify.post('/sync/manual', syncManual);
}
