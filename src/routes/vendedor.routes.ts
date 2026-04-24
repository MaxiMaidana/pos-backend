import type { FastifyInstance } from 'fastify';
import { getVendedores, createVendedor } from '../controllers/vendedor.controller.js';

export async function vendedorRoutes(fastify: FastifyInstance) {
  fastify.get('/vendedores', getVendedores);
  fastify.post('/vendedores', createVendedor);
}
