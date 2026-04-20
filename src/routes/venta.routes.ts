import type { FastifyInstance } from 'fastify';
import { createComanda, cobrarVenta, cancelarVenta, anularVenta, getVentas, updateBorrador } from '../controllers/venta.controller.js';

export async function ventaRoutes(fastify: FastifyInstance) {
  fastify.get('/ventas', getVentas);
  fastify.post('/ventas', createComanda);
  fastify.put('/ventas/:id', updateBorrador);          // Editar detalles de un BORRADOR
  fastify.post('/ventas/:id/cobrar', cobrarVenta);
  fastify.post('/ventas/:id/cancelar', cancelarVenta);
  fastify.patch('/ventas/:id', anularVenta);  // PATCH para anular (soft-delete con sesion_id)
  fastify.delete('/ventas/:id', anularVenta); // DELETE mantenido por compatibilidad
}
