import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../db/prisma.js';
import type { Prisma } from '@prisma/client';

const TIENDA_LOCAL_ID = process.env.TIENDA_LOCAL_ID;
if (!TIENDA_LOCAL_ID) {
  throw new Error('[CONFIG] La variable de entorno TIENDA_LOCAL_ID no está configurada.');
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

type ProductoConStocks = Prisma.ProductoGetPayload<{ include: { stocks: true } }>;

interface CreateProductoBody {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
  costo?: number;
  marca?: string;
  categoria?: string;
  proveedor?: string;
  stock_minimo?: number;
}

interface ImportProductoItem {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
  // Campos nuevos — nombres canónicos
  costo?: number | string;
  marca?: string;
  categoria?: string;
  proveedor?: string;
  stock_minimo?: number | string;
  // Aliases de las columnas del Excel del cliente (mayúsculas)
  COSTO?: string | number;
  MARCA?: string;
  MODELO?: string; // se mapea a categoria
  PROVEEDOR?: string;
  STOCK_MINIMO?: string | number;
}

interface ImportProductosBody {
  productos: ImportProductoItem[];
}

interface UpdateProductoBody {
  nombre?: string;
  precio_actual?: number;
  stock?: number;
  codigo_barras?: string;
  costo?: number;
  marca?: string;
  categoria?: string;
  proveedor?: string;
  stock_minimo?: number;
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
  tienda_id?:   string;
}

// ── Helper ────────────────────────────────────────────────────────────────────
// Expone stock_local (tienda propia) y stock_otro (suma de todas las demás)
// para que el frontend no tenga que iterar el array de stocks.
function mapProductoConStock(p: ProductoConStocks) {
  let stock_local = 0;
  let stock_otro  = 0;
  for (const s of p.stocks) {
    if (s.tienda_id === TIENDA_LOCAL_ID) {
      stock_local = s.cantidad;
    } else {
      stock_otro += s.cantidad;
    }
  }
  return { ...p, stock_local, stock_otro };
}

// ── Controladores ─────────────────────────────────────────────────────────────

export async function getProductos(
  request: FastifyRequest<{ Querystring: GetProductosQuery }>,
  reply: FastifyReply
) {
  try {
    const page  = Math.max(1, parseInt(request.query.page  ?? '1',  10));
    const limit = Math.max(1, parseInt(request.query.limit ?? '20', 10));
    const skip  = (page - 1) * limit;

    const { search, stockBajo, soloActivos, tienda_id } = request.query;

    let stockBajoIds: string[] | undefined;
    if (stockBajo === 'true') {
      if (tienda_id) {
        // Vista por sucursal: LEFT JOIN para capturar productos sin registro (stock = 0).
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT p.id
          FROM "Producto" p
          LEFT JOIN "StockTienda" st
            ON st.producto_id = p.id AND st.tienda_id = ${tienda_id}
          WHERE p.activo = true
            AND p.eliminado = false
            AND (st.cantidad IS NULL OR st.cantidad <= p.stock_minimo)
        `;
        stockBajoIds = rows.map(r => r.id);
      } else {
        // Vista global: un producto aparece si en AL MENOS UNA tienda tiene stock bajo
        // o le falta el registro de stock en alguna tienda activa.
        const tiendas = await prisma.tienda.findMany({ select: { id: true } });
        const totalTiendas = tiendas.length;

        if (totalTiendas === 0) {
          stockBajoIds = [];
        } else {
          const rows = await prisma.$queryRaw<{ id: string }[]>`
            SELECT p.id
            FROM "Producto" p
            WHERE p.activo = true
              AND p.eliminado = false
              AND (
                EXISTS (
                  SELECT 1 FROM "StockTienda" st
                  WHERE st.producto_id = p.id
                    AND st.cantidad <= p.stock_minimo
                )
                OR
                (
                  SELECT COUNT(*) FROM "StockTienda" st
                  WHERE st.producto_id = p.id
                ) < ${totalTiendas}
              )
          `;
          stockBajoIds = rows.map(r => r.id);
        }
      }
    }

    const where: Prisma.ProductoWhereInput = {
      eliminado: false,
      ...(soloActivos === 'true' && { activo: true }),
      ...(search && {
        OR: [
          { nombre:        { contains: search } },
          { codigo_barras: { contains: search } },
          { marca:         { contains: search } },
          { categoria:     { contains: search } },
          { proveedor:     { contains: search } },
        ],
      }),
      // Filtra por stock bajo: usa raw SQL con LEFT JOIN + stock_minimo por producto.
      ...(stockBajoIds !== undefined && { id: { in: stockBajoIds } }),
    };

    const [total, data] = await prisma.$transaction([
      prisma.producto.count({ where }),
      prisma.producto.findMany({
        where,
        skip,
        take:    limit,
        orderBy: { nombre: 'asc' },
        include: { stocks: true },
      }),
    ]);

    return reply.send({
      data: data.map(mapProductoConStock),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
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
    const { nombre, precio_actual, stock, codigo_barras, costo, marca, categoria, proveedor, stock_minimo } = request.body;

    const producto = await prisma.$transaction(async (tx) => {
      const nuevo = await tx.producto.create({
        data: {
          nombre,
          precio_actual,
          codigo_barras,
          costo:        costo        ?? 0,
          marca:        marca        ?? null,
          categoria:    categoria    ?? null,
          proveedor:    proveedor    ?? null,
          stock_minimo: stock_minimo ?? 5,
          synced_at:    null,
        },
      });

      await tx.stockTienda.create({
        data: { producto_id: nuevo.id, tienda_id: TIENDA_LOCAL_ID!, cantidad: stock ?? 0 },
      });

      return tx.producto.findUnique({
        where:   { id: nuevo.id },
        include: { stocks: true },
      });
    });

    return reply.status(201).send(mapProductoConStock(producto!));
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
    const { nombre, precio_actual, stock, codigo_barras, costo, marca, categoria, proveedor, stock_minimo } = request.body;

    const producto = await prisma.$transaction(async (tx) => {
      await tx.producto.update({
        where: { id },
        data: {
          ...(nombre        !== undefined && { nombre }),
          ...(precio_actual !== undefined && { precio_actual }),
          ...(codigo_barras !== undefined && { codigo_barras }),
          ...(costo         !== undefined && { costo }),
          ...(marca         !== undefined && { marca }),
          ...(categoria     !== undefined && { categoria }),
          ...(proveedor     !== undefined && { proveedor }),
          ...(stock_minimo  !== undefined && { stock_minimo }),
          synced_at: null,
        },
      });

      if (stock !== undefined) {
        await tx.stockTienda.upsert({
          where:  { producto_id_tienda_id: { producto_id: id, tienda_id: TIENDA_LOCAL_ID! } },
          update: { cantidad: stock },
          create: { producto_id: id, tienda_id: TIENDA_LOCAL_ID!, cantidad: stock },
        });
      }

      return tx.producto.findUnique({
        where:   { id },
        include: { stocks: true },
      });
    });

    return reply.send(mapProductoConStock(producto!));
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
      data:  { eliminado: true, synced_at: null },
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

// ── Importación CSV ───────────────────────────────────────────────────────────

const IMPORT_BATCH_SIZE = 500;

/**
 * Convierte un valor monetario a Float.
 * Soporta:
 *   Formato AR:  "$7.686,00"  → 7686
 *   Formato US:  "$1,234.56"  → 1234.56
 *   Limpio:      "7686"       → 7686
 */
function parseCosto(raw: string | number | undefined | null): number {
  if (raw == null) return 0;
  const str = String(raw).replace(/[$\s]/g, '').trim();
  if (!str) return 0;

  const lastComma = str.lastIndexOf(',');
  const lastDot   = str.lastIndexOf('.');

  let normalized: string;
  if (lastComma > lastDot) {
    // Formato AR: "7.686,00" — coma es decimal, punto es separador de miles
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > lastComma) {
    // Formato US/limpio: "1,234.56" — punto es decimal, coma es separador de miles
    normalized = str.replace(/,/g, '');
  } else {
    normalized = str.replace(',', '.');
  }

  const value = parseFloat(normalized);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Normaliza un item del CSV al formato interno.
 * Soporta nombres canónicos (codigo_barras, nombre, precio_actual, costo…)
 * y aliases del Excel del cliente (CODIGO, PRODUCTO, VENTA, MODELO, etc.).
 */
function normalizarItem(raw: ImportProductoItem): {
  nombre: string;
  precio_actual: number;
  stock: number;
  codigo_barras?: string;
  costo: number;
  marca:        string | null;
  categoria:    string | null;
  proveedor:    string | null;
  stock_minimo: number;
} {
  const r = raw as any;
  const rawMin = r.STOCK_MINIMO ?? r.stock_minimo;
  return {
    nombre:        String(r.PRODUCTO    ?? r.nombre        ?? ''),
    precio_actual: parseCosto(r.VENTA   ?? r.SUGERIDO      ?? r.precio_actual),
    stock:         r.stock != null ? Number(r.stock) : 0,
    codigo_barras: (r.CODIGO ?? r.codigo_barras) || undefined,
    costo:         parseCosto(r.COSTO   ?? r.costo),
    marca:         (r.MARCA     ?? r.marca     ?? null) as string | null,
    categoria:     (r.MODELO    ?? r.categoria ?? null) as string | null,
    proveedor:     (r.PROVEEDOR ?? r.proveedor ?? null) as string | null,
    stock_minimo:  rawMin != null && Number.isFinite(Number(rawMin)) ? Number(rawMin) : 5,
  };
}

export async function importarProductos(
  request: FastifyRequest<{ Body: ImportProductosBody }>,
  reply: FastifyReply
) {
  try {
    const { productos } = request.body;

    if (!Array.isArray(productos) || productos.length === 0) {
      return reply.status(400).send({ error: 'El campo "productos" debe ser un array no vacío' });
    }

    const filasInvalidas: number[] = [];
    for (let i = 0; i < productos.length; i++) {
      const raw = productos[i];
      if (!raw) { filasInvalidas.push(i + 1); continue; }
      const p = normalizarItem(raw);
      if (!p.nombre || !Number.isFinite(p.precio_actual) || p.precio_actual <= 0) {
        filasInvalidas.push(i + 1);
      }
    }
    if (filasInvalidas.length > 0) {
      return reply.status(400).send({
        error: `Filas con datos inválidos (nombre o precio_actual faltantes): ${filasInvalidas.slice(0, 20).join(', ')}${filasInvalidas.length > 20 ? '...' : ''}`,
      });
    }

    let creados = 0;
    let actualizados = 0;

    for (let i = 0; i < productos.length; i += IMPORT_BATCH_SIZE) {
      const lote = productos.slice(i, i + IMPORT_BATCH_SIZE).filter(Boolean) as ImportProductoItem[];

      await prisma.$transaction(async (tx) => {
        for (const raw of lote) {
          const p = normalizarItem(raw);
          let productoId: string;

          if (p.codigo_barras) {
            // Con código de barras: upsert (actualiza catálogo si ya existía)
            const existente = await tx.producto.findUnique({
              where:  { codigo_barras: p.codigo_barras },
              select: { id: true },
            });

            if (existente) {
              await tx.producto.update({
                where: { id: existente.id },
                data:  {
                  nombre:        p.nombre,
                  precio_actual: p.precio_actual,
                  costo:         p.costo,
                  marca:         p.marca,
                  categoria:     p.categoria,
                  proveedor:     p.proveedor,
                  stock_minimo:  p.stock_minimo,
                  synced_at:     null,
                },
              });
              productoId = existente.id;
              actualizados++;
            } else {
              const nuevo = await tx.producto.create({
                data: {
                  nombre:        p.nombre,
                  precio_actual: p.precio_actual,
                  codigo_barras: p.codigo_barras,
                  costo:         p.costo,
                  marca:         p.marca,
                  categoria:     p.categoria,
                  proveedor:     p.proveedor,
                  stock_minimo:  p.stock_minimo,
                  activo:        true,
                  eliminado:     false,
                  synced_at:     null,
                },
              });
              productoId = nuevo.id;
              creados++;
            }
          } else {
            // Sin código de barras: siempre crea nuevo (no hay clave única para deduplicar)
            const nuevo = await tx.producto.create({
              data: {
                nombre:        p.nombre,
                precio_actual: p.precio_actual,
                costo:         p.costo,
                marca:         p.marca,
                categoria:     p.categoria,
                proveedor:     p.proveedor,
                stock_minimo:  p.stock_minimo,
                activo:        true,
                eliminado:     false,
                synced_at:     null,
              },
            });
            productoId = nuevo.id;
            creados++;
          }

          // Registra o actualiza el stock en esta tienda
          await tx.stockTienda.upsert({
            where:  { producto_id_tienda_id: { producto_id: productoId, tienda_id: TIENDA_LOCAL_ID! } },
            update: { cantidad: p.stock },
            create: { producto_id: productoId, tienda_id: TIENDA_LOCAL_ID!, cantidad: p.stock },
          });
        }
      });
    }

    return reply.status(201).send({
      success:      true,
      creados,
      actualizados,
      message: `${creados} producto(s) creado(s), ${actualizados} actualizado(s).`,
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al importar productos' });
  }
}

// ── Exportación CSV ───────────────────────────────────────────────────────────

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
      include: { stocks: { where: { tienda_id: TIENDA_LOCAL_ID! } } },
    });

    const HEADERS = ['codigo_barras', 'nombre', 'precio_actual', 'costo', 'marca', 'categoria', 'proveedor', 'stock', 'activo'];
    const rows = productos.map(p => {
      const stockLocal = p.stocks[0]?.cantidad ?? 0;
      return [
        csvCell(p.codigo_barras),
        csvCell(p.nombre),
        csvCell(p.precio_actual),
        csvCell(p.costo),
        csvCell(p.marca),
        csvCell(p.categoria),
        csvCell(p.proveedor),
        csvCell(stockLocal),
        csvCell(p.activo),
      ].join(',');
    });

    const csv = [HEADERS.join(','), ...rows].join('\n');
    const fecha = new Date().toISOString().slice(0, 10);

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="inventario_${fecha}.csv"`)
      .send(csv);
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: 'Error al exportar productos' });
  }
}
