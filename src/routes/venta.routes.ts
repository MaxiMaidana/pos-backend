import type { FastifyInstance } from 'fastify';
import { createComanda, createBorrador, updateBorrador, confirmarBorrador, cobrarVenta, cancelarVenta, anularVenta, getVentas } from '../controllers/venta.controller.js';

export async function ventaRoutes(fastify: FastifyInstance) {
  fastify.get('/ventas', getVentas);
  fastify.post('/ventas', createComanda);
  fastify.post('/ventas/borrador', createBorrador);
  fastify.put('/ventas/:id/borrador', updateBorrador);
  fastify.post('/ventas/:id/confirmar', confirmarBorrador);
  fastify.post('/ventas/:id/cobrar', cobrarVenta);
  fastify.post('/ventas/:id/cancelar', cancelarVenta);
  fastify.patch('/ventas/:id', anularVenta);  // PATCH para anular (soft-delete con sesion_id)
  fastify.delete('/ventas/:id', anularVenta); // DELETE mantenido por compatibilidad
}
