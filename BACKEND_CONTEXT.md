# POS Backend — Documentación Completa de Contexto

## 1. Arquitectura General

Sistema de Punto de Venta (POS) multi-sucursal con arquitectura **Hub & Spoke Offline-First**:

- **Nube (Hub):** PostgreSQL en Supabase. Fuente central de verdad para catálogo y datos consolidados.
- **Locales (Spokes):** Cada tienda física corre este backend localmente con **Node.js + Fastify + SQLite**. Funciona offline; sincroniza cuando hay internet.
- **Frontend:** React 18 + Vite. Se comunica con este backend vía API REST en `localhost:3000`.
- **Sync automático:** Cada 60 segundos se ejecuta un ciclo completo (Pull nube→local, luego Push local→nube).

### Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Runtime | Node.js (ESM, `"type": "module"`) |
| Framework HTTP | Fastify 5 |
| ORM | Prisma 5 (SQLite local / PostgreSQL cloud) |
| BD Local | SQLite (`prisma/schema.prisma`) |
| BD Nube | PostgreSQL en Supabase (`prisma/schema.cloud.prisma`) |
| Lenguaje | TypeScript estricto (evitar `any`) |
| Facturación | AFIP SDK (`@afipsdk/afip.js`) — campos en modelo Venta |

### Variables de Entorno Requeridas

```env
DATABASE_URL=file:./dev.db          # SQLite local
DATABASE_CLOUD_URL=postgresql://...  # Supabase (pooler)
DIRECT_URL=postgresql://...          # Supabase (directa, para migraciones)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_KEY=eyJ...

TIENDA_LOCAL_ID=uuid-de-esta-tienda  # Identifica esta sucursal
TIENDA_LOCAL_NOMBRE=Mi Librería      # Nombre visible en login

API_SECRET=mi-secret-token           # Token Bearer para auth
ADMIN_PASSWORD=1234                  # Password del rol ADMIN
EMPLEADO_PASSWORD=5678               # Password del rol EMPLEADO
```

---

## 2. Esquema de Base de Datos (Prisma)

Ambos schemas (`schema.prisma` para SQLite y `schema.cloud.prisma` para PostgreSQL) son idénticos en estructura. Diferencias: `provider` y `url`.

### Modelos

#### Tienda
```
id         String   @id UUID
nombre     String
direccion  String?
creado_en  DateTime
updated_at DateTime @updatedAt
```
Relaciones: `stocks[]`, `ventas[]`, `sesiones[]`, `vendedores[]`

#### Vendedor
```
id         String   @id UUID
nombre     String
activo     Boolean  (default: true)
tienda_id  String   → FK a Tienda
updated_at DateTime @updatedAt
synced_at  DateTime?
```
Relaciones: `tienda`, `ventas[]`

#### Producto
```
id                  String   @id UUID
codigo_barras       String?  @unique
nombre              String
precio_actual       Float
costo               Float    (default: 0)
marca               String?
categoria           String?
proveedor           String?
activo              Boolean  (default: true)
eliminado           Boolean  (default: false) — soft-delete
stock_minimo        Int      (default: 5)
margen              Float?   (default: 1)
precio_sin_redondear Float?
updated_at          DateTime @updatedAt
synced_at           DateTime?
```
Relaciones: `detalles_ventas[]`, `stocks[]`

**Nota:** El Producto NO tiene stock directo. El stock está en `StockTienda`.

#### StockTienda
```
id          String   @id UUID
producto_id String   → FK a Producto
tienda_id   String   → FK a Tienda
cantidad    Int      (default: 0)
updated_at  DateTime @updatedAt
synced_at   DateTime?

@@unique([producto_id, tienda_id])
```
Cada fila representa el stock de un producto en una tienda específica.

#### Venta
```
id                String   @id UUID
estado            String   (default: "PENDIENTE")  — PENDIENTE | PAGADA | CANCELADA | ANULADA
total             Float
descuento_total   Float    (default: 0)
vendedorId        String?  → FK a Vendedor
created_at        DateTime
updated_at        DateTime @updatedAt
synced_at         DateTime?

# Facturación electrónica (AFIP/ARCA)
estadoFacturacion String   (default: "NO_APLICA")  — NO_APLICA | PENDIENTE | FACTURADA | ERROR
cae               String?
vencimientoCae    String?
numeroFactura     Int?
tipoFactura       String?  — "C", "B", "A"
errorFacturacion  String?

sesion_id         String?  → FK a SesionCaja
tienda_id         String?  → FK a Tienda
```
Relaciones: `detalles[]`, `pagos[]`, `vendedor?`, `sesion?`, `tienda?`

**Ciclo de vida de una Venta:**
1. `PENDIENTE` — Se crea la comanda (se reserva stock)
2. `PAGADA` — Se cobra (se asocia a sesión de caja y se registran pagos)
3. `CANCELADA` — Se cancela antes de cobrar (se devuelve stock)
4. `ANULADA` — Se anula una venta pendiente (se devuelve stock)

#### DetalleVenta
```
id                        String @id UUID
venta_id                  String → FK a Venta
producto_id               String → FK a Producto
cantidad                  Int
precio_unitario_historico Float   — precio al momento de la venta
subtotal                  Float   — cantidad × precio_unitario_historico
```

#### Pago
```
id       String @id UUID
venta_id String → FK a Venta
metodo   String — EFECTIVO | TARJETA | TARJETA_CREDITO | MERCADOPAGO | TRANSFERENCIA
monto    Float
cuotas   Int?
```

#### SesionCaja
```
id                    String   @id UUID
cajero_nombre         String
fecha_apertura        DateTime
fecha_cierre          DateTime?
monto_inicial         Float
estado                String   (default: "ABIERTA") — ABIERTA | CERRADA
monto_efectivo_cierre Float?   — monto contado físicamente al cerrar
diferencia            Float?   — positivo = sobrante, negativo = faltante
updated_at            DateTime @updatedAt
synced_at             DateTime?
caja_id               String   → FK a Caja
tienda_id             String?  → FK a Tienda
```
Relaciones: `ventas[]`, `movimientos[]`, `caja`

#### MovimientoCaja
```
id         String   @id UUID
monto      Float
motivo     String
tipo       String   — RETIRO | INGRESO
sesion_id  String   → FK a SesionCaja
creado_en  DateTime
updated_at DateTime @updatedAt
synced_at  DateTime?
```

#### Caja
```
id        String @id UUID
nombre    String @unique  — "Caja 1", "Caja 2"
synced_at DateTime?
```

#### ConfiguracionTienda
```
id                Int     @id (siempre 1, singleton)
cuit              String
razonSocial       String
condicionFiscal   String  — MONOTRIBUTO | RESPONSABLE_INSCRIPTO
puntoVenta        Int
entornoProduccion Boolean (default: false)
```

---

## 3. Autenticación

### Mecanismo
Auth por **API Key estática** vía header `Authorization: Bearer <API_SECRET>`.

- Los preflights OPTIONS pasan sin auth (para que CORS funcione).
- El token se obtiene haciendo login con rol + password.

### Rutas Públicas (sin auth)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/config/identidad` | Devuelve `{ nombre_tienda }` — se usa en la pantalla de login |
| `POST` | `/api/auth/login` | Autenticar usuario |

#### POST /api/auth/login
```json
// Request Body
{ "rol": "ADMIN", "password": "1234" }
// Roles válidos: "ADMIN", "EMPLEADO"

// Response 200
{ "token": "mi-secret-token", "rol": "ADMIN" }

// Response 401 — password incorrecto
{ "error": "Credenciales incorrectas" }
```

### Rutas Protegidas
Todas las rutas bajo `/api/*` (excepto auth e identidad) requieren:
```
Authorization: Bearer <token>
```

---

## 4. Endpoints — Referencia Completa

> **Convención de respuesta:** Todos usan `reply.send()` / `reply.status(N).send()` de Fastify.
> Las listas paginadas devuelven `{ data: [...], meta: { total, page, limit, totalPages } }`.
> Los errores devuelven `{ error: "mensaje" }`.

### 4.1 Productos (`/api/productos`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/productos` | Listar productos (paginado, con filtros) |
| `GET` | `/api/productos/export` | Exportar catálogo |
| `POST` | `/api/productos` | Crear un producto |
| `POST` | `/api/productos/import` | Importación masiva (CSV/Excel) |
| `PUT` | `/api/productos/:id` | Actualizar producto |
| `PATCH` | `/api/productos/:id/toggle-activo` | Activar/desactivar producto |
| `DELETE` | `/api/productos/:id` | Soft-delete (marca `eliminado: true`) |

#### GET /api/productos
Query params:
- `page` (default: 1)
- `limit` (default: 20)
- `search` — busca en nombre, codigo_barras, marca, categoria, proveedor
- `stockBajo` — `"true"` filtra productos con stock ≤ stock_minimo
- `soloActivos` — `"true"` filtra solo activos
- `tienda_id` — filtra stock por tienda específica
- `stockExacto` — filtra productos con stock exactamente igual a N

```json
// Response
{
  "data": [
    {
      "id": "uuid",
      "codigo_barras": "7790001",
      "nombre": "Cuaderno Rivadavia",
      "precio_actual": 1500.00,
      "costo": 800.00,
      "marca": "Rivadavia",
      "categoria": "Cuadernos",
      "proveedor": "Dist. X",
      "activo": true,
      "eliminado": false,
      "stock_minimo": 5,
      "margen": 1,
      "stocks": [...],
      "stock_local": 25,    // stock en TIENDA_LOCAL_ID
      "stock_otro": 40      // suma del stock en OTRAS tiendas
    }
  ],
  "meta": { "total": 150, "page": 1, "limit": 20, "totalPages": 8 }
}
```

#### POST /api/productos
```json
// Request Body
{
  "nombre": "Lapicera BIC",
  "precio_actual": 350.00,
  "stock": 100,
  "codigo_barras": "7790002",
  "costo": 150.00,
  "marca": "BIC",
  "categoria": "Escritura",
  "proveedor": "BIC Argentina",
  "stock_minimo": 10,
  "margen": 1.5,
  "precio_sin_redondear": 345.50
}
// Response 201: producto con stock_local y stock_otro
```

#### POST /api/productos/import
```json
// Request Body
{
  "productos": [
    {
      "nombre": "Producto 1",          // o alias "PRODUCTO"
      "precio_actual": 100,            // o alias "VENTA" / "SUGERIDO"
      "stock": 50,
      "codigo_barras": "123",          // o alias "CODIGO"
      "costo": "$7.686,00",            // soporta formato AR y US
      "marca": "X",                    // o alias "MARCA"
      "categoria": "Cat",             // o alias "MODELO"
      "proveedor": "Y",               // o alias "PROVEEDOR"
      "stock_minimo": 5               // o alias "STOCK_MINIMO"
    }
  ]
}
// Lotes de 500 items en transacción. Upsert por codigo_barras si existe.
// Response 201: { creados: N, actualizados: M }
```

#### PUT /api/productos/:id
```json
// Request Body — todos los campos opcionales
{
  "nombre": "Nuevo nombre",
  "precio_actual": 400,
  "stock": 50,
  "codigo_barras": "789"
}
// Si se envía "stock", actualiza StockTienda para TIENDA_LOCAL_ID
```

### 4.2 Vendedores (`/api/vendedores`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/vendedores` | Lista vendedores activos de la tienda local |
| `POST` | `/api/vendedores` | Crear un vendedor |

#### GET /api/vendedores
```json
// Response 200
[
  { "id": "uuid", "nombre": "Juan", "activo": true, "tienda_id": "uuid", "updated_at": "..." },
  { "id": "uuid", "nombre": "María", "activo": true, "tienda_id": "uuid", "updated_at": "..." }
]
```

#### POST /api/vendedores
```json
// Request Body
{ "nombre": "Carlos" }

// Response 201
{ "id": "uuid", "nombre": "Carlos", "activo": true, "tienda_id": "uuid", "updated_at": "..." }
```

### 4.3 Ventas (`/api/ventas`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/ventas` | Listar ventas (paginado, con filtros) |
| `POST` | `/api/ventas` | Crear comanda (venta en estado PENDIENTE) |
| `POST` | `/api/ventas/:id/cobrar` | Cobrar una venta pendiente |
| `POST` | `/api/ventas/:id/cancelar` | Cancelar venta (devuelve stock) |
| `PATCH` | `/api/ventas/:id` | Anular venta (devuelve stock) |
| `DELETE` | `/api/ventas/:id` | Anular venta (alias, misma función que PATCH) |

#### GET /api/ventas
Query params:
- `page` (default: 1)
- `limit` (default: 30)
- `id` — si se pasa, devuelve solo esa venta con todos los includes
- `estado` — filtra por estado exacto (ej: `BORRADOR`, `PENDIENTE`, `PAGADA`)
- `fecha` — formato `YYYY-MM-DD` (default: hoy en Argentina UTC-3)
- `vendedorId` — filtra por UUID del vendedor
- `sesion_id` — filtra por sesión de caja (auto-filtra estado PAGADA/ANULADA)

**Caso de uso principal para borradores:** `GET /api/ventas?vendedorId=XXX&estado=PENDIENTE`
Devuelve las ventas pendientes de ese vendedor para que retome su trabajo.

```json
// Response
{
  "data": [
    {
      "id": "uuid",
      "estado": "PENDIENTE",
      "total": 5000.00,
      "descuento_total": 0,
      "vendedorId": "uuid",
      "vendedor": { "id": "uuid", "nombre": "Juan", "activo": true, ... },
      "created_at": "2026-04-24T15:30:00.000Z",
      "detalles": [
        {
          "id": "uuid",
          "producto_id": "uuid",
          "cantidad": 2,
          "precio_unitario_historico": 1500,
          "subtotal": 3000,
          "producto": { "id": "uuid", "nombre": "Cuaderno", ... }
        }
      ],
      "pagos": [],
      "sesion": null
    }
  ],
  "meta": { "total": 5, "page": 1, "limit": 30, "totalPages": 1 }
}
```

#### POST /api/ventas (Crear Comanda)
```json
// Request Body
{
  "vendedorId": "uuid-del-vendedor",
  "descuento_total": 500,
  "detalles": [
    { "producto_id": "uuid", "cantidad": 2, "precio_unitario_historico": 1500 },
    { "producto_id": "uuid", "cantidad": 1, "precio_unitario_historico": 350 }
  ]
}
```
- Valida que el `vendedorId` existe y está activo
- Calcula `total = Σ(cantidad × precio) - descuento_total`
- Crea la venta en estado `PENDIENTE`
- **Descuenta stock** inmediatamente de `StockTienda` para `TIENDA_LOCAL_ID`
- Asocia `tienda_id` automáticamente

```json
// Response 201
{
  "id": "uuid",
  "estado": "PENDIENTE",
  "vendedorId": "uuid",
  "total": 2850,
  "detalles": [...]
}
```

#### POST /api/ventas/:id/cobrar
```json
// Request Body
{
  "caja_id": "uuid-de-la-caja",
  "pagos": [
    { "metodo": "EFECTIVO", "monto": 2000 },
    { "metodo": "TARJETA_CREDITO", "monto": 850, "cuotas": 3 }
  ]
}
```
- La venta debe estar en estado `PENDIENTE`
- La caja debe tener una sesión `ABIERTA`
- Valida que la suma de pagos coincida con el total (con recargos por cuotas si aplica)
- **Recargos por cuotas tarjeta crédito:** 1 cuota = 5%, 2 = 7%, 3 = 10%, 6 = 15%
- El frontend envía montos CON recargo incluido; el backend hace ingeniería inversa
- Cambia estado a `PAGADA`, asocia `sesion_id`, resetea `synced_at` para re-sync

#### POST /api/ventas/:id/cancelar
- Solo se puede cancelar si estado es `PENDIENTE`
- **Devuelve stock** a `StockTienda`
- Cambia estado a `CANCELADA`

#### PATCH /api/ventas/:id (Anular)
```json
// Request Body (opcional)
{ "sesion_id": "uuid-de-la-sesion" }
```
- Solo se puede anular si estado es `PENDIENTE`
- **Devuelve stock** a `StockTienda`
- Cambia estado a `ANULADA`
- Opcionalmente asocia a una sesión de caja

### 4.4 Caja (`/api/caja`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/caja` | Lista todas las cajas |
| `POST` | `/api/caja/abrir` | Abrir sesión de caja |
| `GET` | `/api/caja/:caja_id/estado` | Estado actual de la caja (sesión abierta) |
| `GET` | `/api/caja/:caja_id/arqueo` | Arqueo de caja en vivo |
| `POST` | `/api/caja/:caja_id/cerrar` | Cerrar sesión de caja |
| `POST` | `/api/caja/:caja_id/movimiento` | Registrar retiro/ingreso de efectivo |

#### POST /api/caja/abrir
```json
// Request Body
{
  "caja_id": "uuid",
  "cajero_nombre": "María López",
  "monto_inicial": 5000
}
// Valida que no haya una sesión ya abierta para esa caja.
// Response 201: SesionCaja con include caja
```

#### GET /api/caja/:caja_id/arqueo
```json
// Response 200 — datos en vivo de la sesión abierta
{
  "caja": { "id": "uuid", "nombre": "Caja 1" },
  "cajero": "María López",
  "fecha_apertura": "2026-04-24T10:00:00.000Z",
  "monto_inicial": 5000,
  "ventas_por_metodo": [
    { "metodo": "EFECTIVO", "total": 15000 },
    { "metodo": "TARJETA", "total": 8000 }
  ],
  "ventas_efectivo": 15000,
  "total_recaudado": 23000,
  "total_retiros": 2000,
  "total_ingresos": 500,
  "efectivo_esperado_en_cajon": 18500
}
```

#### POST /api/caja/:caja_id/cerrar
```json
// Request Body
{ "monto_efectivo_contado": 18300 }

// Response 200
{
  "sesion": { ... },
  "resumen_pagos": [...],
  "total_recaudado": 23000,
  "efectivo_esperado": 18500,
  "diferencia": -200,
  "mensaje": "Faltante de $200.00"
}
```

#### POST /api/caja/:caja_id/movimiento
```json
// Request Body
{ "monto": 2000, "motivo": "Retiro para comprar suministros", "tipo": "RETIRO" }
// tipo: "RETIRO" | "INGRESO"
// Response 201: MovimientoCaja
```

### 4.5 Dashboard (`/api/dashboard`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/dashboard/stats` | Estadísticas del día (ventas, recaudación, stock bajo) |
| `GET` | `/api/dashboard/analiticas` | Rendimiento por vendedor + reporte de cajas |

#### GET /api/dashboard/stats
Query params: `fecha?` (YYYY-MM-DD), `tienda_id?`

```json
// Response 200
{
  "fecha": "2026-04-24",
  "tienda_id": null,
  "ventasTotales": 45,
  "ventasCanceladas": 3,
  "recaudacionTotal": 125000,
  "productosStockBajo": 12,
  "desglosePagosGlobal": {
    "EFECTIVO": 80000,
    "TARJETA": 35000,
    "TRANSFERENCIA": 10000
  }
}
```

#### GET /api/dashboard/analiticas
Query params: `fecha?`, `tienda_id?`

```json
// Response 200
{
  "fecha": "2026-04-24",
  "tienda_id": null,
  "rendimientoVendedores": [
    {
      "vendedorId": "uuid",
      "vendedor": "Juan",
      "cantidadVentas": 20,
      "recaudacionTotal": 65000,
      "cantidadAnuladas": 1
    }
  ],
  "reporteCajas": [
    {
      "sesion_id": "uuid",
      "caja_id": "uuid",
      "caja": "Caja 1",
      "cajero_nombre": "María",
      "estado": "CERRADA",
      "monto_inicial": 5000,
      "monto_cierre": 18300,
      "desglosePagos": { "EFECTIVO": 15000, "TARJETA": 8000 },
      "retiros": 2000,
      "ingresos": 500,
      "monto_esperado": 18500,
      "diferencia": -200,
      "resultado": "Faltante"
    }
  ]
}
```

### 4.6 Tiendas (`/api/tiendas`)

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/tiendas` | Lista todas las tiendas |

```json
// Response 200
[
  { "id": "uuid", "nombre": "Sucursal Centro", "direccion": "Av. Corrientes 1234" },
  { "id": "uuid", "nombre": "Sucursal Norte", "direccion": "Av. Cabildo 567" }
]
```

### 4.7 Sincronización (`/api/sync`)

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/sync/manual` | Dispara un ciclo completo de sync manualmente |

```json
// Response 200
{ "success": true, "message": "Sincronización completada" }
```

---

## 5. Sincronización (Sync Service)

### Ciclo Automático
Se ejecuta cada 60 segundos (`setInterval` en `index.ts`).

**Orden de ejecución:**
1. **Pull (nube → local):**
   - Tiendas (full sync, siempre)
   - Productos (cursor `lastProductPullAt`, incremental)
   - StockTienda (cursor `lastStockPullAt`, incremental, independiente de productos)
2. **Push (local → nube):**
   - Cajas → SesionesCaja → Productos → StockTienda → Ventas (respeta FK)

### Mecanismo de Detección de Cambios
Todos los modelos sincronizables tienen `updated_at` y `synced_at`:
- Un registro necesita sincronizarse cuando `synced_at IS NULL` o `updated_at > synced_at`
- Raw SQL (`$queryRaw`) porque Prisma no soporta comparación entre campos en `where`
- Al sincronizar exitosamente: `$executeRaw SET synced_at = updated_at` (evita que `@updatedAt` de Prisma cree un bucle infinito)

### Push de Ventas (detalle)
Sube en secuencia respetando FKs:
1. Caja (si tiene sesión)
2. SesionCaja
3. Productos referenciados en detalles
4. Venta principal
5. DetalleVenta
6. Pagos
7. Marca `synced_at = updated_at` localmente

### Pull desde la Nube
- **Tiendas:** Full sync (pocas filas). Usa `INSERT ... ON CONFLICT(id) DO UPDATE` con SQLite.
- **Productos:** Cursor incremental. Solo descarga productos con `updated_at > cursor`.
- **StockTienda:** Cursor independiente. Procesa registro a registro para que un error FK no aborte el lote.

### Nota sobre Timestamps (Supabase)
Supabase usa `timestamp without time zone`. PostgREST compara lexicográficamente. El backend convierte UTC → hora local argentina antes de enviar cursores para evitar desfasajes.

---

## 6. Estructura de Archivos

```
src/
  index.ts                    — Entry point. CORS, Helmet, auth hook, registro de rutas, sync worker
  db/
    prisma.ts                 — Singleton de PrismaClient
    supabase.ts               — Singleton de SupabaseClient
  plugins/
    auth.plugin.ts            — Hook de auth por Bearer token
  routes/
    auth.routes.ts            — Rutas públicas: login + identidad
    producto.routes.ts        — CRUD + import/export de productos
    venta.routes.ts           — CRUD de ventas (comanda, cobro, anulación)
    vendedor.routes.ts        — GET/POST vendedores
    caja.routes.ts            — Abrir/cerrar caja, arqueo, movimientos
    dashboard.routes.ts       — Stats y analíticas (inline, sin controller separado)
    sync.routes.ts            — Trigger manual de sincronización
    tienda.routes.ts          — Lista tiendas (inline)
  controllers/
    producto.controller.ts    — Lógica de productos (con import masivo y mapeo stock_local/stock_otro)
    venta.controller.ts       — Lógica de ventas (comanda, cobro, recargos, anulación)
    caja.controller.ts        — Lógica de caja (apertura, cierre, arqueo, movimientos)
    vendedor.controller.ts    — Lógica de vendedores
  services/
    sync.service.ts           — Todo el motor de sincronización bidireccional
prisma/
  schema.prisma               — Schema SQLite (local)
  schema.cloud.prisma         — Schema PostgreSQL (nube/Supabase)
```

---

## 7. Convenciones y Reglas

1. **Fastify SIEMPRE:** Nunca `res.json()` ni `res.sendFile()`. Usar `reply.send()`, `reply.status()`.
2. **Transacciones Prisma:** Operaciones críticas (crear venta + descontar stock, cerrar caja) van en `prisma.$transaction`.
3. **Soft-delete de productos:** `eliminado: true`, nunca `DELETE` real.
4. **Zona horaria:** Todo el filtrado por fecha usa hora Argentina (UTC-3). El helper `buildRangoDia()` convierte: `00:00 AR = 03:00 UTC`.
5. **synced_at:** Se resetea a `null` cuando un registro se modifica localmente, para que el sync lo recoja.
6. **Stock distribuido:** El stock de un producto se consulta vía `StockTienda`. El controller de productos expone `stock_local` y `stock_otro` como campos calculados.
7. **Errores:** Siempre `{ error: "mensaje" }`. Bloques catch nunca vacíos. Errores fatales de arranque → `process.exit(1)`.
8. **Body limit:** 50 MB para permitir importaciones masivas de catálogo.

---

## 8. Headers Requeridos para Todas las Requests

```http
Content-Type: application/json
Authorization: Bearer <token-obtenido-en-login>
```

Excepto:
- `GET /api/config/identidad` → sin Authorization
- `POST /api/auth/login` → sin Authorization

---

## 9. Comandos Útiles

```bash
# Desarrollo
npm run dev                  # Arranca con nodemon + ts-node (ESM)

# Base de datos local
npx prisma db push           # Aplica schema a SQLite
npx prisma generate          # Regenera el client

# Base de datos cloud
npx prisma generate --schema=./prisma/schema.cloud.prisma
npx prisma db push --schema=./prisma/schema.cloud.prisma

# Build producción
npm run build                # tsc → dist/
npm start                    # node dist/index.js
```
