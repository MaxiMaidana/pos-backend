import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';

interface CreateProductoBody {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
}

interface UpdateProductoBody {
  nombre?: string;
  precio_actual?: number;
  stock?: number;
  codigo_barras?: string;
}

interface ProductoParams {
  id: string;
}

interface GetProductosQuery {
  page?: string;
  limit?: string;
  search?: string;
  stockBajo?: string;
}

export async function getProductos(
  request: FastifyRequest<{ Querystring: GetProductosQuery }>,
  reply: FastifyReply
) {
  try {
    const page  = Math.max(1, parseInt(request.query.page  ?? '1',  10));
    const limit = Math.max(1, parseInt(request.query.limit ?? '20', 10));
    const skip  = (page - 1) * limit;

    const { search, stockBajo } = request.query;

    const where: Prisma.ProductoWhereInput = {
      activo: true,
      ...(search && {
        OR: [
          { nombre:        { contains: search } },
          { codigo_barras: { contains: search } },
        ],
      }),
      ...(stockBajo === 'true' && { stock: { lte: 5 } }),
    };

    const [total, data] = await prisma.$transaction([
      prisma.producto.count({ where }),
      prisma.producto.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { nombre: 'asc' },
      }),
    ]);

    return reply.send({
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
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

export async function updateProducto(
  request: FastifyRequest<{ Params: ProductoParams; Body: UpdateProductoBody }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;
    const { nombre, precio_actual, stock, codigo_barras } = request.body;

    const producto = await prisma.producto.update({
      where: { id },
      data: {
        ...(nombre !== undefined && { nombre }),
        ...(precio_actual !== undefined && { precio_actual }),
        ...(stock !== undefined && { stock }),
        ...(codigo_barras !== undefined && { codigo_barras }),
      },
    });

    return reply.send(producto);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al actualizar el producto' });
  }
}

export async function deleteProducto(
  request: FastifyRequest<{ Params: ProductoParams }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;

    const producto = await prisma.producto.update({
      where: { id },
      data: { activo: false },
    });

    return reply.send(producto);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al eliminar el producto' });
  }
}
