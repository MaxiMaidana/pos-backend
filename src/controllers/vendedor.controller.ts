import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';

const TIENDA_LOCAL_ID = process.env.TIENDA_LOCAL_ID!;

interface CreateVendedorBody {
  nombre: string;
}

export async function getVendedores(
  _request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const vendedores = await prisma.vendedor.findMany({
      where: { tienda_id: TIENDA_LOCAL_ID, activo: true },
      orderBy: { nombre: 'asc' },
    });

    return reply.send(vendedores);
  } catch (error) {
    _request.log.error(error);
    return reply.status(500).send({ error: 'Error al obtener los vendedores' });
  }
}

export async function createVendedor(
  request: FastifyRequest<{ Body: CreateVendedorBody }>,
  reply: FastifyReply
) {
  try {
    const { nombre } = request.body;

    if (!nombre || nombre.trim().length === 0) {
      return reply.status(400).send({ error: 'El nombre del vendedor es obligatorio' });
    }

    const vendedor = await prisma.vendedor.create({
      data: {
        nombre: nombre.trim(),
        tienda_id: TIENDA_LOCAL_ID,
      },
    });

    return reply.status(201).send(vendedor);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al crear el vendedor' });
  }
}
