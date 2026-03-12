import type { FastifyInstance } from 'fastify';
import { getProductos, createProducto } from '../controllers/producto.controller.js';

export async function productoRoutes(fastify: FastifyInstance) {
  fastify.get('/productos', getProductos);
  fastify.post('/productos', createProducto);
}
