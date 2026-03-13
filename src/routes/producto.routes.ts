import type { FastifyInstance } from 'fastify';
import { getProductos, createProducto, updateProducto, deleteProducto, toggleActivo } from '../controllers/producto.controller.js';

export async function productoRoutes(fastify: FastifyInstance) {
  fastify.get('/productos', getProductos);
  fastify.post('/productos', createProducto);
  fastify.put('/productos/:id', updateProducto);
  fastify.patch('/productos/:id/toggle-activo', toggleActivo);
  fastify.delete('/productos/:id', deleteProducto);
}
