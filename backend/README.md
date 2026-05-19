# Gestiva SaaS · Backend

Sistema SaaS para administración de restaurantes/bares con:
- **Auth**: JWT + bcrypt (registro + login)
- **Multi-tenant**: cada cliente tiene sus propios productos, mesas, mozos, órdenes y caja
- **MercadoPago Preapproval**: suscripción mensual recurrente de $40.000 ARS
- **7 días de gracia** después del vencimiento antes de bloquear

## Arquitectura

- **Node.js + Express** — un solo `server.js` con todas las rutas
- **PostgreSQL** — schema definido en `schema.sql`, se aplica automático al deployar (`scripts/migrate.js`)
- **MercadoPago SDK v2** — Preapproval para suscripciones recurrentes
- Independiente de `entradasjujuy` (no comparte código ni base de datos)

## Estructura

```
backend/
├── server.js           ← todo el código del backend
├── schema.sql          ← tablas (tenants, products, tables, waiters, orders, cash, etc.)
├── scripts/migrate.js  ← aplica schema.sql al iniciar
├── package.json
└── .env.example

(El render.yaml está en la raíz del proyecto)
```

## Endpoints

### Auth
- `POST /auth/register` `{email, password, restaurantName, ownerName, phone}` → `{token, user}`
- `POST /auth/login` `{email, password}` → `{token, user}`
- `GET  /auth/me` (auth) → `{user}`

### Billing (MercadoPago)
- `POST /billing/subscribe` (auth) → `{initPoint}` — genera URL de checkout MP
- `POST /billing/webhook` — webhook de MP (sin auth)
- `GET  /billing/status` (auth) → estado de suscripción
- `POST /billing/dev-activate` (auth + `MP_TEST_MODE=1`) — simula pago para testing

### API (requiere auth + suscripción activa o gracia)
Todo bajo `/api/*`:
- `GET/POST/PUT/DELETE /api/products`
- `GET/POST/PUT/DELETE /api/tables`
- `GET/POST/PUT/DELETE /api/waiters`
- `GET/POST/PUT/DELETE /api/open-tables`
- `GET/POST /api/orders`
- `GET /api/cash`, `POST /api/cash/open`, `POST /api/cash/close`, `POST /api/cash/movement`
- `GET /api/dashboard` — stats agregadas
- `PUT /api/settings` — actualizar datos del negocio

## Setup local

```bash
cd gestiva-backend
npm install
cp .env.example .env
# editar .env con DATABASE_URL y MP_ACCESS_TOKEN

# crear DB local (postgres)
createdb gestiva
psql gestiva < schema.sql

# correr
npm run dev          # nodemon
# o
npm start            # node
```

Backend escucha en `http://localhost:3100` por defecto.

## Deploy en Render

1. Crear nuevo **Web Service** en Render apuntando a este repo
2. Root directory: `gestiva-backend`
3. Build: `npm install` · Start: `npm run start:render`
4. Crear PostgreSQL en Render (plan free)
5. Configurar variables de entorno:
   - `DATABASE_URL` (link al PostgreSQL creado)
   - `JWT_SECRET` (auto-generado)
   - `MP_ACCESS_TOKEN` (de https://www.mercadopago.com.ar/developers/panel/credentials — usar **TEST**)
   - `MP_TEST_MODE=1`
   - `APP_URL=https://tu-frontend.vercel.app`
   - `BACKEND_URL=https://gestiva-backend.onrender.com`
   - `SUB_PRICE_ARS=40000`
   - `GRACE_DAYS=7`

El archivo `render.yaml` define el servicio + DB. Si lo usás como blueprint, Render crea todo automáticamente.

## MercadoPago — modo TEST

1. Crear cuenta MP de Argentina
2. Ir a https://www.mercadopago.com.ar/developers/panel/credentials
3. Copiar **Public Key TEST** y **Access Token TEST**
4. Crear usuarios de prueba (vendedor + comprador) en https://www.mercadopago.com.ar/developers/panel/test-users
5. Iniciar sesión en MP con el usuario comprador antes de probar checkout
6. Para pagar usá tarjetas de prueba: https://www.mercadopago.com.ar/developers/es/docs/checkout-api/integration-test/test-cards

Mientras `MP_TEST_MODE=1`, el endpoint `POST /billing/dev-activate` permite simular un pago exitoso sin pasar por MP — útil para testear el flujo durante desarrollo.

## Flujo de suscripción

1. Cliente se registra → `/auth/register` → recibe JWT, status `pending`
2. Cliente va a checkout → `POST /billing/subscribe` → MP devuelve `init_point`
3. Cliente paga en MP
4. MP llama webhook → backend marca `subscription_status=active`, calcula `subscription_ends_at` (30 días) y `grace_ends_at` (+7 días)
5. Cliente puede usar la app
6. Si MP cobra exitosamente el mes siguiente → webhook actualiza fechas
7. Si MP no logra cobrar → cuando `subscription_ends_at < now()` el status pasa a `grace` (lazy, en cada login/request)
8. Después de `grace_ends_at` → status `expired`, no puede usar la app

## Multi-tenancy

- Cada tenant tiene un `id` (UUID)
- JWT incluye `id` → middleware `requireAuth` carga el tenant y lo pone en `req.tenant`
- Todos los queries de la API agregan `WHERE tenant_id=$1` para aislamiento
- Tablas con `tenant_id NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`

## Seguridad

- `helmet` para headers
- `cors` configurado para credentials
- `express-rate-limit`: 30 req/15min para auth, 240 req/min para API
- Passwords con `bcryptjs` (10 rounds)
- JWT con expiración de 30 días
- DB queries siempre con parámetros (`$1, $2...`) — sin string concat
