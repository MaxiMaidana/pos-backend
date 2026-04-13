import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import staticFiles from '@fastify/static';
import { productoRoutes } from './routes/producto.routes.js';
import { ventaRoutes } from './routes/venta.routes.js';
import { cajaRoutes } from './routes/caja.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { syncRoutes } from './routes/sync.routes.js';
import { tiendaRoutes } from './routes/tienda.routes.js';
import { syncVentasToCloud, syncProductosToCloud, syncCajasToCloud, syncSesionesCajaToCloud, syncStockTiendaToCloud, pullFromCloud } from './services/sync.service.js';
import { authHook } from './plugins/auth.plugin.js';
import { authRoutes } from './routes/auth.routes.js';

const SYNC_INTERVAL_MS = 60_000;

const fastify = Fastify({ logger: true });

const start = async () => {
  try {
    // ── CORS "Modo Dios" ──────────────────────────────────────────────────────
    // Acepta cualquier origen, cualquier header. Ideal para depurar móviles.
    // TODO: reemplazar por la configuración restrictiva antes de ir a producción.
    await fastify.register(cors, {
      origin:            true,          // refleja el Origin del request en Allow-Origin
      credentials:       true,
      methods:           ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders:    ['*'],         // acepta cualquier header que mande el cliente
      exposedHeaders:    ['Authorization'],
      strictPreflight:   false,         // responde 204 a OPTIONS en CUALQUIER ruta
      preflight:         true,
      preflightContinue: false,
    });

    // Helmet con las políticas de cross-origin desactivadas para que no
    // sobreescriba los headers Access-Control-* en errores y preflights.
    await fastify.register(helmet, {
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy:   false,
    });

    // Asegura que los errores (401, 403, 500) también devuelvan headers CORS.
    // Sin esto, el browser interpreta las respuestas de error como "Network Error".
    fastify.addHook('onSend', async (request, reply) => {
      const origin = request.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin',      origin);
        reply.header('Access-Control-Allow-Credentials', 'true');
      }
    });

    // ── Ruta pública de autenticación (sin authHook) ─────────────────────────
    await fastify.register(authRoutes);

    // ── Rutas protegidas (/api/*) ─────────────────────────────────────────────
    // El plugin encapsulado garantiza que el hook SOLO aplica a estas rutas,
    // sin afectar al health-check público GET /
    fastify.register(async (apiScope) => {
      apiScope.addHook('onRequest', authHook);

      await apiScope.register(productoRoutes,  { prefix: '/api' });
      await apiScope.register(ventaRoutes,     { prefix: '/api' });
      await apiScope.register(cajaRoutes,      { prefix: '/api' });
      await apiScope.register(dashboardRoutes, { prefix: '/api' });
      await apiScope.register(syncRoutes,      { prefix: '/api' });
      await apiScope.register(tiendaRoutes,    { prefix: '/api' });
    });

    // ── Archivos estáticos del frontend (dist/) ─────────────────────────────
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const distPath  = join(__dirname, '..', 'dist');

    await fastify.register(staticFiles, {
      root:       distPath,
      prefix:     '/',
      // No lanza error si el archivo no existe; lo manejamos con el wildcard
      decorateReply: false,
    });

    // SPA fallback: cualquier ruta que no sea /api/* devuelve index.html
    // para que React Router / Vue Router manejen la navegación del lado cliente.
    fastify.setNotFoundHandler(async (_request, reply) => {
      return reply.sendFile('index.html', distPath);
    });

    setInterval(async () => {
      console.info('[SYNC] 🔄 Iniciando ciclo de sincronización...');
      // ── Pull (nube → local) ─────────────────────────────────────────────────
      // Se ejecuta PRIMERO para que los datos remotos estén disponibles offline
      // antes de que el frontend los consulte en este ciclo.
      await pullFromCloud();
      // ── Push (local → nube) ─────────────────────────────────────────────────
      await syncCajasToCloud();          // Cajas primero (dep. de SesionCaja y Venta)
      await syncSesionesCajaToCloud();   // Sesiones (dep. de Venta)
      await syncProductosToCloud();      // Productos (dep. de StockTienda y DetalleVenta)
      await syncStockTiendaToCloud();    // Stock por tienda
      await syncVentasToCloud();
      console.info('[SYNC] 🏁 Ciclo de sincronización finalizado.');
    }, SYNC_INTERVAL_MS);
    fastify.log.info(`☁️  Sync worker iniciado. Sincronizando cada ${SYNC_INTERVAL_MS / 1000}s.`);

    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    console.error('[FATAL] Error al iniciar el servidor:');
    if (err instanceof Error) {
      console.error(err.message);
      if (err.stack) console.error(err.stack);
    } else {
      // Los errores de Fastify/ts-node no heredan de Error; usamos inspect para ver el mensaje real.
      const { inspect } = await import('node:util');
      console.error(inspect(err, { depth: null }));
    }
    process.exit(1);
  }
};

start();