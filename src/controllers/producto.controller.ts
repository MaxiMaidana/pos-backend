import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

interface CreateProductoBody {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
}

export async function getProductos(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const productos = await prisma.producto.findMany({
      where: { activo: true },
    });
    return reply.send(productos);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener productos' });
  }
}

export async function createProducto(
  request: FastifyRequest<{ Body: CreateProductoBody }>,
  reply: FastifyReply
) {
  try {
    const { nombre, precio_actual, stock, codigo_barras } = request.body;

    const producto = await prisma.producto.create({
      data: {
        nombre,
        precio_actual,
        stock,
        codigo_barras,
      },
    });

    return reply.status(201).send(producto);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al crear el producto' });
  }
}
