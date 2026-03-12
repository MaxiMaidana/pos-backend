import type { FastifyInstance } from 'fastify';
import { createComanda, cobrarVenta, cancelarVenta, getVentas } from '../controllers/venta.controller.js';

export async function ventaRoutes(fastify: FastifyInstance) {
  fastify.get('/ventas', getVentas);
  fastify.post('/ventas', createComanda);
  fastify.post('/ventas/:id/cobrar', cobrarVenta);
  fastify.post('/ventas/:id/cancelar', cancelarVenta);
}
