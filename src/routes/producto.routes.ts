import type { FastifyInstance } from 'fastify';
import { getProductos, createProducto, updateProducto, deleteProducto, toggleActivo, importarProductos, exportarProductos } from '../controllers/producto.controller.js';

export async function productoRoutes(fastify: FastifyInstance) {
  fastify.get('/productos', getProductos);
  fastify.get('/productos/export', exportarProductos);
  fastify.post('/productos', createProducto);
  fastify.post('/productos/import', importarProductos);
  fastify.put('/productos/:id', updateProducto);
  fastify.patch('/productos/:id/toggle-activo', toggleActivo);
  fastify.delete('/productos/:id', deleteProducto);
}
