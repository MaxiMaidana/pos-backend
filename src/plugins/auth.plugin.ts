import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

/**
 * Hook de autenticación por API Key estática.
 * Se espera el header:  Authorization: Bearer <API_SECRET>
 *
 * Aplicar únicamente en plugins encapsulados (scoped) para que
 * NO afecte rutas públicas como GET /.
 */
export function authHook(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  // Los preflights OPTIONS no llevan Authorization; dejarlos pasar
  // para que @fastify/cors los resuelva correctamente.
  if (request.method === 'OPTIONS') {
    done();
    return;
  }

  const secret = process.env.API_SECRET;

  if (!secret) {
    // Si no está configurada la variable de entorno, el servidor no debe arrancar
    request.log.error('API_SECRET no está definida en las variables de entorno');
    reply.status(500).send({ error: 'Error de configuración del servidor' });
    return;
  }

  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'No autorizado: se requiere token Bearer' });
    return;
  }

  const token = authHeader.slice(7); // quita "Bearer "

  if (token !== secret) {
    reply.status(403).send({ error: 'Prohibido: token inválido' });
    return;
  }

  done();
}
