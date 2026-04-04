import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';

interface CreateProductoBody {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
}

interface ImportProductoItem {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
}

interface ImportProductosBody {
  productos: ImportProductoItem[];
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
  page?:        string;
  limit?:       string;
  search?:      string;
  stockBajo?:   string;
  soloActivos?: string;
}

export async function getProductos(
  request: FastifyRequest<{ Querystring: GetProductosQuery }>,
  reply: FastifyReply
) {
  try {
    const page  = Math.max(1, parseInt(request.query.page  ?? '1',  10));
    const limit = Math.max(1, parseInt(request.query.limit ?? '20', 10));
    const skip  = (page - 1) * limit;

    const { search, stockBajo, soloActivos } = request.query;

    const where: Prisma.ProductoWhereInput = {
      eliminado: false,
      // soloActivos=true  → solo activos (POS)  |  omitido o false → todos (inventario)
      ...(soloActivos === 'true' && { activo: true }),
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
        synced_at: null,
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
        synced_at: null,
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
      data: { eliminado: true, synced_at: null },
    });

    return reply.send(producto);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al eliminar el producto' });
  }
}

export async function toggleActivo(
  request: FastifyRequest<{ Params: ProductoParams }>,
  reply: FastifyReply
) {
  try {
    const { id } = request.params;

    const producto = await prisma.producto.findUnique({ where: { id } });
    if (!producto) {
      return reply.status(404).send({ error: 'Producto no encontrado' });
    }

    const actualizado = await prisma.producto.update({
      where: { id },
      data:  { activo: !producto.activo, synced_at: null },
    });

    return reply.send(actualizado);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al cambiar el estado del producto' });
  }
}

const IMPORT_BATCH_SIZE = 500;

export async function importarProductos(
  request: FastifyRequest<{ Body: ImportProductosBody }>,
  reply: FastifyReply
) {
  try {
    const { productos } = request.body;

    if (!Array.isArray(productos) || productos.length === 0) {
      return reply.status(400).send({ error: 'El campo "productos" debe ser un array no vacío' });
    }

    // Validar campos requeridos en cada fila antes de tocar la BD
    const filasInvalidas: number[] = [];
    for (let i = 0; i < productos.length; i++) {
      const p = productos[i];
      if (
        !p ||
        !p.nombre ||
        p.precio_actual == null || !Number.isFinite(Number(p.precio_actual)) ||
        p.stock == null        || !Number.isFinite(Number(p.stock))
      ) {
        filasInvalidas.push(i + 1); // 1-based para el mensaje al usuario
      }
    }
    if (filasInvalidas.length > 0) {
      return reply.status(400).send({
        error: `Filas con datos inválidos (nombre, precio_actual o stock faltantes): ${filasInvalidas.slice(0, 20).join(', ')}${filasInvalidas.length > 20 ? '...' : ''}`,
      });
    }

    // Obtener códigos de barras ya existentes para poder omitir duplicados
    // (createMany con skipDuplicates no está soportado en SQLite por Prisma)
    const codigosEnviados = productos
      .map(p => p.codigo_barras)
      .filter((c): c is string => !!c);

    const existentes = codigosEnviados.length > 0
      ? await prisma.producto.findMany({
          where: { codigo_barras: { in: codigosEnviados } },
          select: { codigo_barras: true },
        })
      : [];

    const codigosExistentes = new Set(existentes.map(e => e.codigo_barras));

    const productosNuevos = productos.filter(
      p => !p.codigo_barras || !codigosExistentes.has(p.codigo_barras)
    );
    const omitidos = productos.length - productosNuevos.length;

    // Insertar en lotes para no saturar SQLite con una transacción de 15k filas
    let insertados = 0;
    for (let i = 0; i < productosNuevos.length; i += IMPORT_BATCH_SIZE) {
      const lote = productosNuevos.slice(i, i + IMPORT_BATCH_SIZE);
      const resultado = await prisma.producto.createMany({
        data: lote.map(p => ({
          nombre:        p.nombre,
          precio_actual: Number(p.precio_actual),
          stock:         Number(p.stock),
          codigo_barras: p.codigo_barras ?? null,
          activo:        true,
          eliminado:     false,
          synced_at:     null,
        })),
      });
      insertados += resultado.count;
    }

    return reply.status(201).send({
      success:    true,
      insertados,
      omitidos,
      message:    `${insertados} producto(s) importados correctamente. ${omitidos} omitido(s) por código de barras duplicado.`,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al importar productos' });
  }
}

// Escapa un valor para que sea seguro dentro de una celda CSV:
// - Envuelve en comillas dobles si contiene coma, comilla doble o salto de línea.
// - Duplica las comillas dobles internas.
function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export async function exportarProductos(
  request: FastifyRequest,
  reply: FastifyReply
) {
  try {
    const productos = await prisma.producto.findMany({
      where:   { eliminado: false },
      orderBy: { nombre: 'asc' },
      select: {
        codigo_barras: true,
        nombre:        true,
        precio_actual: true,
        stock:         true,
        activo:        true,
      },
    });

    const HEADERS = ['codigo_barras', 'nombre', 'precio_actual', 'stock', 'activo'];
    const rows = productos.map(p =>
      [
        csvCell(p.codigo_barras),
        csvCell(p.nombre),
        csvCell(p.precio_actual),
        csvCell(p.stock),
        csvCell(p.activo),
      ].join(',')
    );

    const csv = [HEADERS.join(','), ...rows].join('\n');
    const fecha = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="inventario_${fecha}.csv"`)
      .send(csv);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al exportar productos' });
  }
}
