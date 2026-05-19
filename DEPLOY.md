# Gestiva — Guía de despliegue

Esta guía te lleva paso a paso desde el código hasta tener Gestiva funcionando en producción.

## Lo que vas a desplegar

- **Frontend** (estático) → Vercel — landing + signup + login + checkout + app
- **Backend** (Node + Express + Postgres) → Render
- **Pagos** → MercadoPago Preapproval (suscripción mensual recurrente)

## Paso 1 — Subir a GitHub

```bash
cd C:\Users\anton\OneDrive\Documentos\Gestiva
git init
git add .
git commit -m "Gestiva: SaaS completo - backend + frontend + multi-tenant + MP"

# crear repo en GitHub.com (vacío) y pegar la URL acá:
git remote add origin https://github.com/Antonioberno99/gestiva.git
git branch -M main
git push -u origin main
```

## Paso 2 — Crear MercadoPago (modo TEST)

1. https://www.mercadopago.com.ar/developers/panel
2. Si no tenés app, crear una nueva
3. Sección **Credenciales** → copiar el **Access Token de PRUEBA** (empieza con `TEST-`)
4. Crear **usuarios de prueba** en https://www.mercadopago.com.ar/developers/panel/test-users:
   - Vendedor (vos)
   - Comprador (para probar)

## Paso 3 — Desplegar el backend en Render

### 3a. Crear la base de datos
1. https://dashboard.render.com → **New +** → **PostgreSQL**
2. Configuración:
   - **Name**: `gestiva-db`
   - **Database**: `gestiva`
   - **User**: `gestiva`
   - **Plan**: Free
3. Click **Create Database** → esperar 1-2 min
4. Copiar el **Internal Database URL** (lo vas a necesitar abajo)

### 3b. Crear el Web Service
1. **New +** → **Web Service**
2. Conectar tu repo de GitHub (`gestiva`)
3. Configuración:
   - **Name**: `gestiva-backend`
   - **Region**: la misma que la DB
   - **Branch**: `main`
   - **Root Directory**: `backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm run start:render`
   - **Plan**: Free
4. **Advanced** → agregar variables de entorno:

| Variable | Valor |
|----------|-------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | (pegar el Internal URL del paso 3a) |
| `JWT_SECRET` | (algo random largo) |
| `MP_ACCESS_TOKEN` | (el `TEST-...` del paso 2) |
| `MP_TEST_MODE` | `1` |
| `SUB_PRICE_ARS` | `40000` |
| `GRACE_DAYS` | `7` |
| `APP_URL` | `https://gestiva.vercel.app` (lo vas a definir en paso 4) |
| `BACKEND_URL` | `https://gestiva-backend.onrender.com` |

5. **Create Web Service** → esperar deploy (~5-7 min la primera vez)
6. Verificar: abrir `https://gestiva-backend.onrender.com/health` → debe responder `{"ok":true,"db":"up"}`

## Paso 4 — Desplegar el frontend en Vercel

1. https://vercel.com → **Add New** → **Project**
2. Import el repo `gestiva`
3. Configuración:
   - **Framework**: Other
   - **Root Directory**: `.` (raíz)
   - **Build Command**: vacío
   - **Output Directory**: `frontend`
4. **Deploy**
5. Tu URL será `https://gestiva.vercel.app` (o el subdominio que te asigne)
6. Volver a Render → editar `APP_URL` con esta URL → restart

## Paso 5 — Configurar webhook de MercadoPago

1. Volver al panel de MP → tu aplicación → **Webhooks**
2. **Configurar notificaciones**:
   - URL: `https://gestiva-backend.onrender.com/billing/webhook`
   - Eventos: marcar `Suscripciones (subscription_preapproval)` y `Pagos (payment)`
3. Guardar

## Paso 6 — Actualizar la URL del backend en el frontend

Editar `frontend/gestiva-config.js` para que apunte a tu backend de Render:

```js
window.API_URL = 'https://gestiva-backend.onrender.com';
```

Commitear y pushear → Vercel auto-deploya.

## Paso 7 — Probar el flujo completo

1. Abrir `https://gestiva.vercel.app/signup.html`
2. Registrarse con email + password + nombre del restaurante
3. Te redirige a `checkout.html`
4. Click en **"Pagar con MercadoPago"** → te lleva a MP
5. Iniciar sesión con el usuario **comprador** de prueba (paso 2)
6. Pagar con una tarjeta TEST:
   - Visa: `4509 9535 6623 3704`
   - Mastercard: `5031 7557 3453 0604`
   - Venc: cualquier futuro · CVV: cualquier 3 dígitos
   - Para aprobar: titular `APRO`
   - Para rechazar: titular `OTHE`
7. Te redirige a `billing-return.html` que pollea el estado
8. Cuando MP llame al webhook → status pasa a `active`
9. Auto-redirige a `app.html` → ya podés usar todo el sistema

### Atajo para probar el panel sin pasar por MP

En `checkout.html` hay un botón **"🧪 Simular pago (modo TEST)"** que activa la suscripción directamente. Funciona solo cuando `MP_TEST_MODE=1`. Útil mientras armás el flujo.

## Paso 8 — Pasar a producción real

Cuando todo esté probado en TEST:

1. En MP, copiar **Access Token de PRODUCCIÓN**
2. En Render, editar:
   - `MP_ACCESS_TOKEN` → token de producción
   - `MP_TEST_MODE` → `0` (o borrar la variable)
3. Restart del servicio
4. Verificar que el webhook siga apuntando a `/billing/webhook` (no cambia)
5. Listo — desde ahora cobra plata real

## Troubleshooting

### "Error de conexión con el backend"
- Verificar que el backend de Render esté corriendo: `https://gestiva-backend.onrender.com/health`
- En Render Free el servicio se duerme tras 15 min de inactividad. La primera request lo despierta (~30s)

### "subscription_required" al entrar al panel
- El status no pasó a `active`. Revisar:
  - El webhook de MP llegó al backend (logs en Render)
  - Las credenciales MP son correctas
  - Mientras tanto: usar el botón "Simular pago" en checkout

### MP rechaza el pago en TEST
- Estar logueado con el usuario **comprador** de prueba, no con tu cuenta real
- Usar las tarjetas test exactas que figuran arriba

### "tenant_id NOT NULL" o errores de DB
- El schema no se aplicó. Ver logs de Render — `scripts/migrate.js` corre antes de `server.js`
- Manual: conectar con psql al DATABASE_URL y ejecutar `\i schema.sql`

## Costos

- **Render Free**: $0/mes (limitado, se duerme tras 15 min)
- **Vercel Hobby**: $0/mes (ilimitado para proyectos personales)
- **PostgreSQL Render Free**: $0/mes (90 días, después se borra — pasar a paid o migrar)
- **MercadoPago**: comisión por transacción (no hay costo fijo)

Para producción seria, pasar Render a plan paid (~$7/mes) y la DB también.
