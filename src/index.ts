import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { productoRoutes } from './routes/producto.routes.js';
import { ventaRoutes } from './routes/venta.routes.js';
import { cajaRoutes } from './routes/caja.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { syncRoutes } from './routes/sync.routes.js';
import { syncVentasToCloud } from './services/sync.service.js';
import { authHook } from './plugins/auth.plugin.js';
import { authRoutes } from './routes/auth.routes.js';

const SYNC_INTERVAL_MS = 60_000;

const fastify = Fastify({ logger: true });

const start = async () => {
  try {
    await fastify.register(cors, {
      origin:         true,
      credentials:    true,
      methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    });
    await fastify.register(helmet);

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
    });

    // ── Ruta pública ──────────────────────────────────────────────────────────
    fastify.get('/', async (_request, _reply) => {
      return { status: 'ok', message: 'POS Edge Sync API funcionando' };
    });

    setInterval(() => { void syncVentasToCloud(); }, SYNC_INTERVAL_MS);
    fastify.log.info(`☁️  Sync worker iniciado. Sincronizando cada ${SYNC_INTERVAL_MS / 1000}s.`);

    await fastify.listen({ port: 3000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();