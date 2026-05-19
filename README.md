# Gestiva

**SaaS de administración para restaurantes, bares y negocios gastronómicos.**

Sistema completo: registro de clientes → suscripción mensual de $40.000 ARS con MercadoPago → panel con dashboard, mesas, comandas, caja, productos, mozos y reportes.

## Estructura del proyecto

```
Gestiva/
├── README.md                ← este archivo
├── DEPLOY.md                ← guía paso a paso de despliegue
├── render.yaml              ← blueprint de Render (backend + DB)
├── vercel.json              ← config de Vercel (frontend)
├── .gitignore
│
├── frontend/                ← estático (deploy en Vercel)
│   ├── landing.html         página de venta
│   ├── signup.html          registro
│   ├── login.html           inicio de sesión
│   ├── checkout.html        activar/renovar suscripción
│   ├── billing-return.html  confirmación post-pago
│   ├── app.html             panel completo
│   └── gestiva-config.js    URL del backend
│
└── backend/                 ← Node + Express + Postgres (deploy en Render)
    ├── server.js            todas las rutas (auth, billing, API)
    ├── schema.sql           tablas multi-tenant
    ├── package.json
    ├── README.md            doc técnica del backend
    ├── .env.example
    └── scripts/
        └── migrate.js       aplica schema.sql al iniciar
```

## Stack

| Capa     | Tecnología                                |
|----------|-------------------------------------------|
| Frontend | HTML/CSS/JS vanilla (zero build, sin framework) |
| Backend  | Node.js + Express                         |
| Auth     | JWT + bcryptjs                            |
| DB       | PostgreSQL (multi-tenant con `tenant_id`) |
| Pagos    | MercadoPago Preapproval (recurrente)      |
| Deploy   | Vercel (frontend) + Render (backend + DB) |

## Flujo del negocio

1. Cliente entra al **landing**
2. Hace **signup** con su email + nombre del restaurante
3. Backend genera JWT y devuelve `status: pending`
4. Cliente va al **checkout** y paga con MercadoPago
5. MP llama al webhook → backend marca `status: active`
6. Cliente accede al **panel** y usa todas las funciones
7. Cada 30 días MP cobra automático
8. Si falla → 7 días de gracia → bloqueo

## Multi-tenancy

Cada cliente que se registra recibe su propio "tenant":
- Sus productos, mesas, mozos, comandas, caja y reportes son aislados
- Al registrarse se crean 12 mesas + 1 mozo por defecto
- Todas las queries del API filtran por `tenant_id` (middleware automático)

## Setup local

### Backend
```bash
cd backend
npm install
cp .env.example .env
# editar .env con DATABASE_URL y MP_ACCESS_TOKEN
createdb gestiva
psql gestiva < schema.sql
npm run dev   # arranca en :3100
```

### Frontend
```bash
cd frontend
npx serve -p 3000
# abrir http://localhost:3000/landing.html
```

## Deploy

Ver **`DEPLOY.md`** para guía completa paso a paso.

Resumen:
1. Subir el repo a GitHub
2. Render → crear PostgreSQL `gestiva-db` + Web Service desde `backend/`
3. Vercel → import del repo (outputDirectory = `frontend`)
4. MercadoPago → credenciales TEST + webhook a `/billing/webhook`
5. Editar `frontend/gestiva-config.js` con la URL del backend

## Precio

**$40.000 ARS / mes** · facturación automática · sin permanencia · 7 días de gracia
