import type { FastifyInstance } from 'fastify';
import { abrirCaja, cerrarCaja, estadoCaja, obtenerArqueo } from '../controllers/caja.controller.js';

export async function cajaRoutes(fastify: FastifyInstance) {
  fastify.post('/caja/abrir', abrirCaja);
  fastify.get('/caja/:caja_id/estado', estadoCaja);
  fastify.get('/caja/:caja_id/arqueo', obtenerArqueo);
  fastify.post('/caja/:caja_id/cerrar', cerrarCaja);
}
