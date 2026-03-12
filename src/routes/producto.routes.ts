import type { FastifyInstance } from 'fastify';
import { getProductos, createProducto, updateProducto, deleteProducto } from '../controllers/producto.controller.js';

export async function productoRoutes(fastify: FastifyInstance) {
  fastify.get('/productos', getProductos);
  fastify.post('/productos', createProducto);
  fastify.put('/productos/:id', updateProducto);
  fastify.delete('/productos/:id', deleteProducto);
}
