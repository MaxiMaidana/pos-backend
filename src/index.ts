import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { productoRoutes } from './routes/producto.routes.js';
import { ventaRoutes } from './routes/venta.routes.js';
import { cajaRoutes } from './routes/caja.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';
import { syncVentasToCloud } from './services/sync.service.js';

const SYNC_INTERVAL_MS = 60_000;

const fastify = Fastify({ logger: true });

const start = async () => {
  try {
    await fastify.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']});
    await fastify.register(helmet);

    await fastify.register(productoRoutes, { prefix: '/api' });
    await fastify.register(ventaRoutes, { prefix: '/api' });
    await fastify.register(cajaRoutes, { prefix: '/api' });
    await fastify.register(dashboardRoutes, { prefix: '/api' });

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