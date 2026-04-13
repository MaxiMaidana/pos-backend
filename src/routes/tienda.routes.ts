import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

// ── GET /api/tiendas ──────────────────────────────────────────────────────────
async function getTiendas(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const tiendas = await prisma.tienda.findMany({
      select: { id: true, nombre: true, direccion: true },
      orderBy: { nombre: 'asc' },
    });
    return reply.send(tiendas);
  } catch (error) {
    _request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener las tiendas' });
  }
}

export async function tiendaRoutes(fastify: FastifyInstance) {
  fastify.get('/tiendas', getTiendas);
}
