import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

async function getIdentidad(_request: FastifyRequest, reply: FastifyReply) {
  return reply.send({
    nombre_tienda: process.env.TIENDA_LOCAL_NOMBRE || 'Punto de Venta',
  });
}

interface LoginBody {
  rol:      string;
  password: string;
}

const ROLES_VALIDOS = ['ADMIN', 'EMPLEADO'] as const;
type Rol = typeof ROLES_VALIDOS[number];

async function login(
  request: FastifyRequest<{ Body: LoginBody }>,
  reply: FastifyReply
) {
  const { rol, password } = request.body;

  if (!rol || !password) {
    return reply.status(400).send({ error: 'Los campos rol y password son requeridos' });
  }

  if (!ROLES_VALIDOS.includes(rol as Rol)) {
    return reply.status(400).send({ error: `Rol inválido. Los roles válidos son: ${ROLES_VALIDOS.join(', ')}` });
  }

  const passwordEsperada =
    rol === 'ADMIN'
      ? process.env.ADMIN_PASSWORD
      : process.env.EMPLEADO_PASSWORD;

  if (!passwordEsperada) {
    request.log.error(`Variable de entorno no definida para el rol: ${rol}`);
    return reply.status(500).send({ error: 'Error de configuración del servidor' });
  }

  if (password !== passwordEsperada) {
    return reply.status(401).send({ error: 'Credenciales incorrectas' });
  }

  const token = process.env.API_SECRET;
  if (!token) {
    request.log.error('API_SECRET no está definida en las variables de entorno');
    return reply.status(500).send({ error: 'Error de configuración del servidor' });
  }

  return reply.status(200).send({ token, rol });
}

export async function authRoutes(fastify: FastifyInstance) {
  // GET /api/config/identidad  →  pública, la consume el login ANTES de tener token
  fastify.get('/api/config/identidad', getIdentidad);
  // POST /api/auth/login       →  pública, NO pasa por authHook
  fastify.post('/api/auth/login', login);
}
