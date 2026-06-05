/* ============================================================
   Gestiva SaaS Backend
   - Auth (JWT + bcrypt)
   - Multi-tenant (tenant_id scoped)
   - MercadoPago Preapproval (suscripción mensual $40k ARS)
   - Webhook para confirmar pagos
   - REST API para products / tables / waiters / orders / cash
   ============================================================ */
'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { v4: uuid } = require('uuid');
const { MercadoPagoConfig, PreApproval, Payment } = require('mercadopago');
const mailer = require('./mailer');

// ---------- Config ----------
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod-gp';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const SUB_PRICE = parseFloat(process.env.SUB_PRICE_ARS || '39000'); // fallback = precio PRO
const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || '7', 10);
// Prueba gratis: usuarios nuevos arrancan con acceso completo (features Full) por TRIAL_DAYS días
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '30', 10);
// Panel del dueño (admin). Login con estas credenciales.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase().trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ---------- Planes de suscripción ----------
// Tres planes: start (más barato), pro (recomendado), full (premium)
// Diseñados para ser $2.000 más baratos que los equivalentes de Fudo (Inicial $20.900 / Avanzado $41.000 / Pro $65.000)
const PLANS = {
  start: {
    id: 'start',
    name: 'Start',
    price: 18900,
    description: 'Para food trucks, kioscos, take-away y emprendedores',
    features: [
      'Caja y arqueos',
      'Productos ilimitados',
      'Comandas',
      'Descuentos',
      'Menú QR público',
      'Hasta 5 mesas',
      '1 usuario admin',
      'Reportes básicos (día/semana)',
      'Soporte por email'
    ],
    limits: { tables: 5, waiters: 1, kds: false, delivery: false }
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    price: 39000,
    description: 'Para restaurantes y bares en operación normal',
    recommended: true,
    features: [
      'Todo lo de Start',
      'Mesas ilimitadas + plano visual',
      'KDS (Pantalla cocina) incluido',
      'App PWA para mozos',
      'Modificadores',
      'Stock y movimientos',
      'Clientes y cuenta corriente',
      'Reportes completos + Excel',
      'Hasta 10 mozos/cajeros',
      'Soporte por WhatsApp'
    ],
    limits: { tables: -1, waiters: 10, kds: true, delivery: false }
  },
  full: {
    id: 'full',
    name: 'Full',
    price: 63000,
    description: 'Para restaurantes grandes, bares de noche, boliches y multi-local',
    features: [
      'Todo lo de Pro',
      'Delivery / Takeaway',
      'Comisiones por mozo',
      'Múltiples cajas / turnos',
      'Multi-sucursal (próximamente)',
      'AFIP facturación (próximamente)',
      'Usuarios ilimitados',
      'Onboarding personalizado',
      'Soporte prioritario WhatsApp'
    ],
    limits: { tables: -1, waiters: -1, kds: true, delivery: true }
  }
};

function planFor(planId) {
  return PLANS[planId] || PLANS.pro;
}
// Si está vacío, el endpoint /auth/google rechaza pedidos
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
// SKIP_BILLING=1 desactiva todo cobro: registros quedan 'active' por 1 año.
// Útil mientras no esté integrado el banco. Para activar cobro real, poner SKIP_BILLING=0.
const SKIP_BILLING = process.env.SKIP_BILLING === '1' || !MP_TOKEN;

if (SKIP_BILLING) console.warn('[billing] SKIP_BILLING active — todos los registros se activan automáticamente');
else if (!MP_TOKEN) console.warn('[mp] MP_ACCESS_TOKEN missing — billing endpoints will fail');

// ---------- Database ----------
const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && (dbUrl.includes('render.com') || dbUrl.includes('amazonaws') || dbUrl.includes('neon.tech')) ? { rejectUnauthorized: false } : false
});
pool.on('error', (e) => console.error('[pg] pool error', e));

const q = (sql, params) => pool.query(sql, params);

// ---------- MercadoPago ----------
const mpClient = MP_TOKEN ? new MercadoPagoConfig({ accessToken: MP_TOKEN }) : null;

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 240 });

// ---------- Helpers ----------
function signToken(tenant) {
  return jwt.sign(
    { id: tenant.id, email: tenant.email, name: tenant.restaurant_name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function signWaiterToken(tenant, waiter) {
  return jwt.sign(
    { role: 'waiter', tenantId: tenant.id, waiterId: waiter.id, name: waiter.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function signVendorToken(vendor) {
  return jwt.sign(
    { role: 'vendor', vendorId: vendor.id, email: vendor.email },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function publicVendor(v) {
  return {
    id: v.id,
    email: v.email,
    name: v.name,
    phone: v.phone,
    refCode: v.ref_code,
    commissionPercent: parseFloat(v.commission_percent) || 0,
    status: v.status,
    hasApplication: !!v.application,
    googlePicture: v.google_picture || null,
    appliedAt: v.applied_at,
    createdAt: v.created_at
  };
}

// Genera un ref_code corto (ej: 'JUAN-3X9K') a partir del nombre del vendedor.
function makeRefCode(name) {
  const base = (name || 'GEST').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5) || 'GEST';
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}-${rand}`;
}

// Acredita comisión al vendedor si el tenant fue captado por uno.
async function creditVendorCommission(tenantId, paymentAmount) {
  try {
    const t = (await q('SELECT vendor_id FROM tenants WHERE id=$1', [tenantId])).rows[0];
    if (!t || !t.vendor_id) return;
    const v = (await q('SELECT id, commission_percent FROM vendors WHERE id=$1 AND status=$2',
      [t.vendor_id, 'active'])).rows[0];
    if (!v) return;
    const pct = parseFloat(v.commission_percent) || 0;
    if (pct <= 0) return;
    const amt = Math.round(parseFloat(paymentAmount) * pct) / 100;
    await q(
      `INSERT INTO vendor_commissions (vendor_id, tenant_id, payment_amount, commission_pct, commission_amt, status)
       VALUES ($1,$2,$3,$4,$5,'pending')`,
      [v.id, tenantId, paymentAmount, pct, amt]
    );
  } catch (e) { console.error('[commission]', e.message); }
}

function publicTenant(t) {
  const planId = t.plan || 'pro';
  const plan = planFor(planId);
  const isTrial = t.subscription_status === 'trial';
  // Durante la prueba, el acceso es completo (límites del plan Full)
  const effectiveLimits = isTrial ? planFor('full').limits : plan.limits;
  return {
    id: t.id, email: t.email,
    restaurantName: t.restaurant_name,
    ownerName: t.owner_name,
    phone: t.phone,
    currency: t.currency,
    googlePicture: t.google_picture || null,
    hasGoogle: !!t.google_id,
    subscriptionStatus: t.subscription_status,
    subscriptionEndsAt: t.subscription_ends_at,
    graceEndsAt: t.grace_ends_at,
    mpInitPoint: t.mp_init_point,
    daysLeft: computeDaysLeft(t),
    isTrial,
    trialEndsAt: isTrial ? t.subscription_ends_at : null,
    plan: planId,                 // plan elegido (lo que pagará al terminar la prueba)
    planName: plan.name,
    planPrice: plan.price,
    planFeatures: plan.features,
    planLimits: effectiveLimits
  };
}

function publicWaiter(w) {
  return {
    id: w.id,
    tenant_id: w.tenant_id,
    name: w.name,
    role: w.role || 'Mozo',
    color: w.color,
    hasPin: !!w.access_pin_hash,
    commissionPercent: parseFloat(w.commission_percent) || 0,
    created_at: w.created_at
  };
}

function computeDaysLeft(t) {
  if (!t.subscription_ends_at) return null;
  const end = new Date(t.subscription_ends_at);
  const now = new Date();
  return Math.ceil((end - now) / (1000 * 60 * 60 * 24));
}

const DEFAULT_PRODUCTS = [
  { cat: 'Comida', name: 'Plato 1', price: 5000 },
  { cat: 'Comida', name: 'Plato 2', price: 7000 },
  { cat: 'Comida', name: 'Plato 3', price: 9000 },
  { cat: 'Tragos', name: 'Trago 1', price: 3500 },
  { cat: 'Tragos', name: 'Trago 2', price: 4500 },
  { cat: 'Bebidas', name: 'Bebida 1', price: 1800 },
  { cat: 'Bebidas', name: 'Bebida 2', price: 2500 },
  { cat: 'Postres', name: 'Postre 1', price: 3000 }
];

async function seedDefaultProducts(tenantId, { onlyIfEmpty = true } = {}) {
  if (onlyIfEmpty) {
    const existing = await q('SELECT count(*)::int AS n FROM products WHERE tenant_id=$1', [tenantId]);
    if (existing.rows[0].n > 0) return 0;
  }

  for (const p of DEFAULT_PRODUCTS) {
    await q(`INSERT INTO products (tenant_id, name, cat, price, available)
             VALUES ($1,$2,$3,$4,true)`,
      [tenantId, p.name, p.cat, p.price]);
  }
  return DEFAULT_PRODUCTS.length;
}

// Refresca el estado de suscripción según fechas (lazy eval)
async function refreshSubscriptionStatus(tenantId) {
  const r = await q('SELECT * FROM tenants WHERE id=$1', [tenantId]);
  if (!r.rows[0]) return null;
  const t = r.rows[0];

  if (SKIP_BILLING && t.subscription_status !== 'active') {
    const now = new Date();
    const ends = new Date(now.getTime() + 365 * 86400000);
    const grace = new Date(ends.getTime() + GRACE_DAYS * 86400000);
    const updated = await q(
      `UPDATE tenants SET subscription_status='active',
       subscription_started_at=COALESCE(subscription_started_at, $1),
       subscription_ends_at=COALESCE(subscription_ends_at, $2),
       grace_ends_at=COALESCE(grace_ends_at, $3)
       WHERE id=$4 RETURNING *`,
      [now, ends, grace, tenantId]
    );
    return updated.rows[0];
  }

  const now = new Date();
  let newStatus = t.subscription_status;

  // Prueba gratis vencida → debe pagar (expired)
  if (t.subscription_status === 'trial' && t.subscription_ends_at && new Date(t.subscription_ends_at) < now) {
    newStatus = 'expired';
  }
  if (t.subscription_status === 'active' && t.subscription_ends_at && new Date(t.subscription_ends_at) < now) {
    newStatus = 'grace';
  }
  if (t.subscription_status === 'grace' && t.grace_ends_at && new Date(t.grace_ends_at) < now) {
    newStatus = 'expired';
  }

  if (newStatus !== t.subscription_status) {
    await q('UPDATE tenants SET subscription_status=$1 WHERE id=$2', [newStatus, tenantId]);
    t.subscription_status = newStatus;
  }
  return t;
}

// ---------- Middleware ----------
async function requireAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    const t = await refreshSubscriptionStatus(decoded.id);
    if (!t) return res.status(401).json({ error: 'tenant_not_found' });
    req.tenant = t;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function requireSubscription(req, res, next) {
  if (SKIP_BILLING) return next();
  const s = req.tenant.subscription_status;
  if (s === 'active' || s === 'grace' || s === 'trial') return next();
  return res.status(402).json({ error: 'subscription_required', status: s, initPoint: req.tenant.mp_init_point });
}

async function requireWaiterAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'waiter' || !decoded.tenantId || !decoded.waiterId) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const t = await refreshSubscriptionStatus(decoded.tenantId);
    if (!t) return res.status(401).json({ error: 'tenant_not_found' });
    if (!SKIP_BILLING && !['active', 'grace', 'trial'].includes(t.subscription_status)) {
      return res.status(402).json({ error: 'subscription_required' });
    }
    const waiter = (await q('SELECT * FROM waiters WHERE id=$1 AND tenant_id=$2', [decoded.waiterId, t.id])).rows[0];
    if (!waiter) return res.status(401).json({ error: 'waiter_not_found' });
    req.tenant = t;
    req.waiter = waiter;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

async function requireVendorAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'vendor' || !decoded.vendorId) {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const v = (await q('SELECT * FROM vendors WHERE id=$1', [decoded.vendorId])).rows[0];
    if (!v) return res.status(401).json({ error: 'vendor_not_found' });
    // 'pending' y 'active' pueden entrar al portal (pending ve estado de su solicitud).
    // 'rejected' y 'paused' quedan bloqueados.
    if (v.status === 'rejected') return res.status(403).json({ error: 'vendor_rejected' });
    if (v.status === 'paused') return res.status(403).json({ error: 'vendor_paused' });
    req.vendor = v;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

function signAdminToken() {
  return jwt.sign({ role: 'admin', email: ADMIN_EMAIL }, JWT_SECRET, { expiresIn: '7d' });
}

function requireAdminAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'no_token' });
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'admin') return res.status(401).json({ error: 'invalid_token' });
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

// ============================================================
//                       AUTH
// ============================================================

app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, restaurantName, ownerName, phone, plan, ref } = req.body || {};
    if (!email || !password || !restaurantName)
      return res.status(400).json({ error: 'missing_fields' });
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

    const exists = await q('SELECT id FROM tenants WHERE email=$1', [email.toLowerCase().trim()]);
    if (exists.rows[0]) return res.status(409).json({ error: 'email_taken' });

    const hash = await bcrypt.hash(password, 10);
    const chosenPlan = (plan && PLANS[plan]) ? plan : 'pro';

    // Si vino con código de vendedor (ref), buscamos al vendor
    let vendorId = null;
    if (ref && typeof ref === 'string') {
      const v = await q('SELECT id FROM vendors WHERE ref_code=$1 AND status=$2', [ref.toUpperCase().trim(), 'active']);
      if (v.rows[0]) vendorId = v.rows[0].id;
    }

    // Modo de alta:
    // - SKIP_BILLING (dev): activo 1 año
    // - Producción: prueba gratis con acceso completo por TRIAL_DAYS días, luego paga el plan elegido
    let initialStatus, endsAt, graceEndsAt, startedAt = new Date();
    if (SKIP_BILLING) {
      initialStatus = 'active';
      endsAt = new Date(startedAt.getTime() + 365 * 86400000);
      graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * 86400000);
    } else {
      initialStatus = 'trial';
      endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 86400000);   // fin de prueba
      graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * 86400000);
    }

    const ins = await q(
      `INSERT INTO tenants (email, password_hash, restaurant_name, owner_name, phone,
                            subscription_status, subscription_started_at, subscription_ends_at, grace_ends_at, plan, vendor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [email.toLowerCase().trim(), hash, restaurantName.trim(), ownerName || null, phone || null,
       initialStatus, startedAt, endsAt, graceEndsAt, chosenPlan, vendorId]
    );
    const t = ins.rows[0];

    // Seed: agregar 12 mesas y 1 mozo por defecto para empezar
    for (let i = 1; i <= 12; i++) {
      await q('INSERT INTO tables (tenant_id, num, seats) VALUES ($1,$2,$3)', [t.id, i, 4]);
    }
    await q('INSERT INTO waiters (tenant_id, name, color) VALUES ($1,$2,$3)',
      [t.id, ownerName || 'Mozo 1', '#f97316']);
    await seedDefaultProducts(t.id);

    const token = signToken(t);
    return res.json({ token, user: publicTenant(t) });
  } catch (e) {
    console.error('[register]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const normalizedEmail = email.toLowerCase().trim();
    const r = await q('SELECT * FROM tenants WHERE email=$1', [normalizedEmail]);
    const t = r.rows[0];
    if (!t) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, t.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    await refreshSubscriptionStatus(t.id);
    const fresh = await q('SELECT * FROM tenants WHERE id=$1', [t.id]);
    const token = signToken(fresh.rows[0]);
    return res.json({ token, user: publicTenant(fresh.rows[0]) });
  } catch (e) {
    console.error('[login]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/auth/me', requireAuth, async (req, res) => {
  res.json({ user: publicTenant(req.tenant) });
});

// Login / Signup con Google Identity Services.
// El frontend envía el `credential` (JWT firmado por Google) que devuelve el botón
// de Google. Lo verificamos llamando al endpoint público de tokeninfo de Google.
// - Si el email ya existe (con o sin password) → linkeamos google_id y log in.
// - Si no existe → creamos tenant nuevo con restaurant_name placeholder.
// Verifica un ID token de Google Identity Services. Devuelve {email, googleId, name, picture}
// o lanza un Error con .code para responder el status correcto.
async function verifyGoogleCredential(credential) {
  if (!GOOGLE_CLIENT_ID) { const e = new Error('google_not_configured'); e.code = 503; throw e; }
  if (!credential) { const e = new Error('missing_credential'); e.code = 400; throw e; }
  const verifyRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
  if (!verifyRes.ok) { const e = new Error('invalid_credential'); e.code = 401; throw e; }
  const info = await verifyRes.json();
  const aud = Array.isArray(info.aud) ? info.aud : [info.aud];
  if (!aud.includes(GOOGLE_CLIENT_ID)) { const e = new Error('invalid_audience'); e.code = 401; throw e; }
  if (info.email_verified !== 'true' && info.email_verified !== true) { const e = new Error('email_not_verified'); e.code = 401; throw e; }
  const email = (info.email || '').toLowerCase().trim();
  const googleId = info.sub;
  if (!email || !googleId) { const e = new Error('invalid_payload'); e.code = 400; throw e; }
  return { email, googleId, name: info.name || '', picture: info.picture || null };
}

app.post('/auth/google', authLimiter, async (req, res) => {
  try {
    const { credential, ref } = req.body || {};
    const { email, googleId, name, picture } = await verifyGoogleCredential(credential);

    // Buscar tenant existente por google_id o email
    const r = await q('SELECT * FROM tenants WHERE google_id=$1 OR email=$2 LIMIT 1', [googleId, email]);
    let t = r.rows[0];
    let isNew = false;

    if (t) {
      // Linkear google_id y picture si no estaban
      const updates = [];
      const params = [];
      let idx = 1;
      if (!t.google_id) { updates.push(`google_id=$${idx++}`); params.push(googleId); }
      if (!t.google_picture) { updates.push(`google_picture=$${idx++}`); params.push(picture); }
      if (updates.length > 0) {
        params.push(t.id);
        const upd = await q(`UPDATE tenants SET ${updates.join(', ')} WHERE id=$${idx} RETURNING *`, params);
        t = upd.rows[0];
      }
      await refreshSubscriptionStatus(t.id);
      const fresh = await q('SELECT * FROM tenants WHERE id=$1', [t.id]);
      t = fresh.rows[0];
    } else {
      // Crear tenant nuevo (mismo modelo de alta que /auth/register)
      isNew = true;
      let initialStatus, endsAt, graceEndsAt, startedAt = new Date();
      if (SKIP_BILLING) {
        initialStatus = 'active';
        endsAt = new Date(startedAt.getTime() + 365 * 86400000);
        graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * 86400000);
      } else {
        initialStatus = 'trial';
        endsAt = new Date(startedAt.getTime() + TRIAL_DAYS * 86400000);
        graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * 86400000);
      }
      // Asociar vendedor si vino con código (ref) válido y activo
      let vendorId = null;
      if (ref && typeof ref === 'string') {
        const vv = await q('SELECT id FROM vendors WHERE ref_code=$1 AND status=$2', [ref.toUpperCase().trim(), 'active']);
        if (vv.rows[0]) vendorId = vv.rows[0].id;
      }
      const ins = await q(
        `INSERT INTO tenants (email, google_id, google_picture, restaurant_name, owner_name,
                              subscription_status, subscription_started_at, subscription_ends_at, grace_ends_at, vendor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [email, googleId, picture, 'Mi restaurante', name, initialStatus, startedAt, endsAt, graceEndsAt, vendorId]
      );
      t = ins.rows[0];
      // Seed inicial: 12 mesas, 1 mozo, productos por defecto
      for (let i = 1; i <= 12; i++) {
        await q('INSERT INTO tables (tenant_id, num, seats) VALUES ($1,$2,$3)', [t.id, i, 4]);
      }
      await q('INSERT INTO waiters (tenant_id, name, color) VALUES ($1,$2,$3)',
        [t.id, name || 'Mozo 1', '#f97316']);
      await seedDefaultProducts(t.id);
    }

    const token = signToken(t);
    return res.json({ token, user: publicTenant(t), isNew });
  } catch (e) {
    console.error('[auth-google]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// ============================================================
//                       BILLING (MercadoPago)
// ============================================================

// Asegura que exista un preapproval_plan en MP para el tier dado (lo crea/cachea).
// La cuenta MP solo permite "Suscripciones con plan", por eso usamos preapproval_plan.
async function ensureMpPlan(tierId) {
  const plan = planFor(tierId);
  // ¿Ya tenemos un plan con el monto actual?
  const existing = await q('SELECT * FROM mp_plans WHERE tier=$1', [tierId]);
  if (existing.rows[0] && parseFloat(existing.rows[0].amount) === plan.price) {
    return existing.rows[0];
  }
  // Crear el plan en MercadoPago
  const r = await fetch('https://api.mercadopago.com/preapproval_plan', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + MP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      reason: `Gestiva ${plan.name}`,
      auto_recurring: {
        frequency: 1, frequency_type: 'months',
        transaction_amount: plan.price, currency_id: 'ARS'
      },
      back_url: `${APP_URL}/billing-return.html`
    })
  });
  const data = await r.json();
  if (!r.ok) {
    throw new Error('mp_plan_error: ' + JSON.stringify(data));
  }
  await q(`INSERT INTO mp_plans (tier, mp_plan_id, init_point, amount)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (tier) DO UPDATE SET mp_plan_id=$2, init_point=$3, amount=$4, created_at=now()`,
    [tierId, data.id, data.init_point, plan.price]);
  return { tier: tierId, mp_plan_id: data.id, init_point: data.init_point, amount: plan.price };
}

// Crea/recupera el link de suscripción (plan) y lo devuelve con external_reference del tenant
app.post('/billing/subscribe', requireAuth, async (req, res) => {
  try {
    if (!MP_TOKEN) return res.status(500).json({ error: 'mp_not_configured' });
    const t = req.tenant;
    const mpPlan = await ensureMpPlan(t.plan);
    // Adjuntamos external_reference (tenant id) para identificarlo en el webhook
    const sep = mpPlan.init_point.includes('?') ? '&' : '?';
    const initPoint = `${mpPlan.init_point}${sep}external_reference=${encodeURIComponent(t.id)}`;

    await q('UPDATE tenants SET mp_preapproval_id=$1, mp_init_point=$2 WHERE id=$3',
      [mpPlan.mp_plan_id, initPoint, t.id]);

    return res.json({ initPoint, planId: mpPlan.mp_plan_id });
  } catch (e) {
    console.error('[subscribe] error:', e?.message || e);
    return res.status(500).json({ error: 'mp_error', detail: e?.message });
  }
});

// Webhook de MP — notifica eventos de preapproval/payment
app.post('/billing/webhook', async (req, res) => {
  try {
    const { type, action, data } = req.body || {};
    console.log('[webhook] received', { type, action, data });

    // MP envía notifications de tipo 'subscription_preapproval' y 'payment'
    if (!mpClient) { res.sendStatus(200); return; }

    if (type === 'subscription_preapproval' && data?.id) {
      const pre = new PreApproval(mpClient);
      const info = await pre.get({ id: data.id });
      // Identificar tenant: 1) external_reference, 2) fallback por email del pagador
      let tenantId = info.external_reference;
      if (!tenantId && info.payer_email) {
        const found = await q('SELECT id FROM tenants WHERE lower(email)=lower($1)', [info.payer_email]);
        if (found.rows[0]) tenantId = found.rows[0].id;
      }
      if (!tenantId) { console.warn('[webhook] no tenant for preapproval', data.id); res.sendStatus(200); return; }

      // status: pending, authorized, paused, cancelled
      if (info.status === 'authorized') {
        const now = new Date();
        const ends = new Date(now.getTime() + 30 * 86400000);
        const grace = new Date(ends.getTime() + GRACE_DAYS * 86400000);
        const amount = info.auto_recurring?.transaction_amount || SUB_PRICE;
        await q(`UPDATE tenants SET subscription_status='active',
                 subscription_started_at=COALESCE(subscription_started_at, $1),
                 subscription_ends_at=$2, grace_ends_at=$3,
                 last_payment_at=$1, last_payment_amount=$4
                 WHERE id=$5`,
          [now, ends, grace, amount, tenantId]);
        await q(`INSERT INTO subscription_payments (tenant_id, mp_preapproval_id, amount, status, raw)
                 VALUES ($1,$2,$3,$4,$5)`, [tenantId, data.id, amount, 'authorized', info]);
        await creditVendorCommission(tenantId, amount);
      } else if (info.status === 'cancelled' || info.status === 'paused') {
        await q(`UPDATE tenants SET subscription_status='cancelled' WHERE id=$1`, [tenantId]);
      }
    }

    if (type === 'payment' && data?.id) {
      const pay = new Payment(mpClient);
      const info = await pay.get({ id: data.id });
      // ext ref puede venir como external_reference o en metadata
      const tenantId = info.external_reference || info.metadata?.tenant_id;
      if (tenantId && info.status === 'approved') {
        const now = new Date();
        const ends = new Date(now.getTime() + 30 * 86400000);
        const grace = new Date(ends.getTime() + GRACE_DAYS * 86400000);
        await q(`UPDATE tenants SET subscription_status='active',
                 subscription_started_at=COALESCE(subscription_started_at,$1),
                 subscription_ends_at=$2, grace_ends_at=$3,
                 last_payment_at=$1, last_payment_amount=$4
                 WHERE id=$5`,
          [now, ends, grace, info.transaction_amount || SUB_PRICE, tenantId]);
        await q(`INSERT INTO subscription_payments (tenant_id, mp_payment_id, amount, status, raw)
                 VALUES ($1,$2,$3,$4,$5)`,
          [tenantId, data.id, info.transaction_amount || SUB_PRICE, 'approved', info]);
        await creditVendorCommission(tenantId, info.transaction_amount || SUB_PRICE);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook]', e);
    res.sendStatus(200); // MP reintenta si devolvemos error — preferimos 200 y loguear
  }
});

app.get('/billing/status', requireAuth, async (req, res) => {
  const planId = req.tenant.plan || 'pro';
  const plan = planFor(planId);
  res.json({
    status: req.tenant.subscription_status,
    endsAt: req.tenant.subscription_ends_at,
    graceEndsAt: req.tenant.grace_ends_at,
    daysLeft: computeDaysLeft(req.tenant),
    initPoint: req.tenant.mp_init_point,
    lastPaymentAt: req.tenant.last_payment_at,
    lastPaymentAmount: req.tenant.last_payment_amount,
    plan: planId,
    planName: plan.name,
    planPrice: plan.price,
    planFeatures: plan.features
  });
});

// Diagnóstico liviano de MercadoPago (NO expone el token ni crea objetos)
app.get('/billing/mp-check', requireAuth, async (req, res) => {
  const tok = MP_TOKEN || '';
  const out = {
    tokenConfigured: !!tok,
    isProdToken: tok.startsWith('APP_USR-'),
    isTestToken: tok.startsWith('TEST-'),
    skipBilling: SKIP_BILLING,
    appUrl: APP_URL
  };
  try {
    const plans = await q('SELECT tier, mp_plan_id, amount FROM mp_plans ORDER BY amount');
    out.cachedPlans = plans.rows;
  } catch (e) { out.cachedPlans = { error: e.message }; }
  res.json(out);
});

// Endpoint PÚBLICO: lista los planes disponibles (para mostrar en landing/checkout)
app.get('/billing/plans', (req, res) => {
  res.json({
    plans: Object.values(PLANS).map(p => ({
      id: p.id,
      name: p.name,
      price: p.price,
      description: p.description,
      recommended: !!p.recommended,
      features: p.features
    }))
  });
});

// Cambiar de plan (upgrade/downgrade). En SKIP_BILLING aplica de inmediato.
app.post('/billing/plan', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!plan || !PLANS[plan]) return res.status(400).json({ error: 'invalid_plan' });
  // Al cambiar de plan, el link de pago viejo tenía el precio anterior:
  // lo limpiamos para que /billing/subscribe genere uno nuevo con el precio correcto.
  await q('UPDATE tenants SET plan=$1, mp_init_point=NULL, mp_preapproval_id=NULL WHERE id=$2',
    [plan, req.tenant.id]);
  const fresh = await q('SELECT * FROM tenants WHERE id=$1', [req.tenant.id]);
  res.json({ ok: true, user: publicTenant(fresh.rows[0]) });
});

// ============================================================
//                       WAITER APP
// ============================================================

app.post('/waiter/login', authLimiter, async (req, res) => {
  try {
    const { email, pin } = req.body || {};
    if (!email || !pin) return res.status(400).json({ error: 'missing_fields' });
    const normalizedEmail = email.toLowerCase().trim();
    const tenant = (await q('SELECT * FROM tenants WHERE email=$1', [normalizedEmail])).rows[0];
    if (!tenant) return res.status(401).json({ error: 'invalid_credentials' });

    const waiters = (await q('SELECT * FROM waiters WHERE tenant_id=$1 AND access_pin_hash IS NOT NULL ORDER BY created_at', [tenant.id])).rows;
    for (const waiter of waiters) {
      if (await bcrypt.compare(String(pin), waiter.access_pin_hash)) {
        const freshTenant = await refreshSubscriptionStatus(tenant.id);
        const token = signWaiterToken(freshTenant, waiter);
        return res.json({ token, restaurant: publicTenant(freshTenant), waiter: publicWaiter(waiter) });
      }
    }

    return res.status(401).json({ error: 'invalid_credentials' });
  } catch (e) {
    console.error('[waiter-login]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/waiter/me', requireWaiterAuth, async (req, res) => {
  res.json({ restaurant: publicTenant(req.tenant), waiter: publicWaiter(req.waiter) });
});

app.get('/waiter/bootstrap', requireWaiterAuth, async (req, res) => {
  await seedDefaultProducts(req.tenant.id);
  const [tables, openTables, products, activeShift, recentShifts] = await Promise.all([
    q('SELECT * FROM tables WHERE tenant_id=$1 ORDER BY num', [req.tenant.id]),
    q('SELECT * FROM open_tables WHERE tenant_id=$1', [req.tenant.id]),
    q('SELECT * FROM products WHERE tenant_id=$1 AND available=true ORDER BY cat, name', [req.tenant.id]),
    q(`SELECT * FROM staff_shifts
       WHERE tenant_id=$1 AND waiter_id=$2 AND ended_at IS NULL
       ORDER BY started_at DESC LIMIT 1`, [req.tenant.id, req.waiter.id]),
    q(`SELECT * FROM staff_shifts
       WHERE tenant_id=$1 AND waiter_id=$2
       ORDER BY started_at DESC LIMIT 20`, [req.tenant.id, req.waiter.id])
  ]);
  res.json({
    restaurant: publicTenant(req.tenant),
    waiter: publicWaiter(req.waiter),
    tables: tables.rows,
    openTables: openTables.rows,
    products: products.rows,
    activeShift: activeShift.rows[0] || null,
    recentShifts: recentShifts.rows
  });
});

app.get('/waiter/shifts', requireWaiterAuth, async (req, res) => {
  const r = await q(`SELECT * FROM staff_shifts
                     WHERE tenant_id=$1 AND waiter_id=$2
                     ORDER BY started_at DESC LIMIT 60`, [req.tenant.id, req.waiter.id]);
  res.json(r.rows);
});

app.post('/waiter/clock', requireWaiterAuth, async (req, res) => {
  const { action, note } = req.body || {};
  if (!['in', 'out'].includes(action)) return res.status(400).json({ error: 'invalid_action' });

  const active = (await q(`SELECT * FROM staff_shifts
                           WHERE tenant_id=$1 AND waiter_id=$2 AND ended_at IS NULL
                           ORDER BY started_at DESC LIMIT 1`, [req.tenant.id, req.waiter.id])).rows[0];

  if (action === 'in') {
    if (active) return res.json({ shift: active, alreadyOpen: true });
    const r = await q(`INSERT INTO staff_shifts (tenant_id, waiter_id, note)
                       VALUES ($1,$2,$3) RETURNING *`, [req.tenant.id, req.waiter.id, note || null]);
    return res.json({ shift: r.rows[0] });
  }

  if (!active) return res.status(409).json({ error: 'shift_not_open' });
  const r = await q(`UPDATE staff_shifts SET ended_at=now(), note=COALESCE($1,note)
                     WHERE id=$2 AND tenant_id=$3 RETURNING *`, [note || null, active.id, req.tenant.id]);
  return res.json({ shift: r.rows[0] });
});

app.post('/waiter/open-tables', requireWaiterAuth, async (req, res) => {
  const { tableId } = req.body || {};
  if (!tableId) return res.status(400).json({ error: 'missing_table' });
  const table = (await q('SELECT * FROM tables WHERE id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0];
  if (!table) return res.status(404).json({ error: 'table_not_found' });

  const current = (await q('SELECT * FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0];
  if (current && current.waiter_id !== req.waiter.id) return res.status(409).json({ error: 'table_taken' });
  if (current) return res.json(current);

  const r = await q(`INSERT INTO open_tables (table_id, tenant_id, waiter_id, items, opened_at)
                     VALUES ($1,$2,$3,'[]'::jsonb, now()) RETURNING *`,
    [tableId, req.tenant.id, req.waiter.id]);
  await q(`UPDATE tables SET status='free', reservation_name=NULL, reservation_time=NULL
           WHERE id=$1 AND tenant_id=$2`, [tableId, req.tenant.id]);
  res.json(r.rows[0]);
});

// El mozo envía items pendientes a cocina
app.post('/waiter/kitchen', requireWaiterAuth, async (req, res) => {
  const { tableId, items, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'no_items' });
  const table = tableId ? (await q('SELECT num FROM tables WHERE id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0] : null;
  const r = await q(`INSERT INTO kitchen_tickets (tenant_id, table_id, table_num, waiter_id, waiter_name, items, notes, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [req.tenant.id, tableId || null, table?.num || null, req.waiter.id, req.waiter.name,
     JSON.stringify(items), notes || null]);
  res.json(r.rows[0]);
});

app.put('/waiter/open-tables/:tid', requireWaiterAuth, async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return res.status(400).json({ error: 'invalid_items' });
  const ot = (await q('SELECT * FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [req.params.tid, req.tenant.id])).rows[0];
  if (!ot) return res.status(404).json({ error: 'table_not_open' });
  if (ot.waiter_id !== req.waiter.id) return res.status(403).json({ error: 'table_assigned_to_other_waiter' });
  const r = await q(`UPDATE open_tables SET items=$1 WHERE table_id=$2 AND tenant_id=$3 RETURNING *`,
    [JSON.stringify(items), req.params.tid, req.tenant.id]);
  res.json(r.rows[0]);
});

// ============================================================
//                       API (multi-tenant, requires sub)
// ============================================================

app.use('/api', apiLimiter, requireAuth, requireSubscription);

// ----- PRODUCTS -----
app.get('/api/products', async (req, res) => {
  await seedDefaultProducts(req.tenant.id);
  const r = await q('SELECT * FROM products WHERE tenant_id=$1 ORDER BY cat, name', [req.tenant.id]);
  res.json(r.rows);
});
app.post('/api/products', async (req, res) => {
  const { name, cat, price, available, stock, lowStockAlert, modifiers, photoUrl } = req.body || {};
  if (!name || price == null) return res.status(400).json({ error: 'missing_fields' });
  const r = await q(`INSERT INTO products (tenant_id, name, cat, price, available, stock, low_stock_alert, modifiers, photo_url)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [req.tenant.id, name, cat || 'Sin categoría', price,
     available !== false, stock ?? null, lowStockAlert || 5, JSON.stringify(modifiers || []), photoUrl || null]);
  res.json(r.rows[0]);
});
app.put('/api/products/:id', async (req, res) => {
  const { name, cat, price, available, stock, lowStockAlert, modifiers, photoUrl } = req.body || {};
  const r = await q(`UPDATE products SET name=$1, cat=$2, price=$3, available=$4,
                     stock=$5, low_stock_alert=COALESCE($6, low_stock_alert),
                     modifiers=COALESCE($7::jsonb, modifiers),
                     photo_url=COALESCE($8, photo_url)
                     WHERE id=$9 AND tenant_id=$10 RETURNING *`,
    [name, cat, price, available, stock ?? null, lowStockAlert || null,
     modifiers ? JSON.stringify(modifiers) : null, photoUrl ?? null, req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});
app.delete('/api/products/:id', async (req, res) => {
  await q('DELETE FROM products WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  res.json({ ok: true });
});

// ----- TABLES -----
app.get('/api/tables', async (req, res) => {
  const r = await q('SELECT * FROM tables WHERE tenant_id=$1 ORDER BY num', [req.tenant.id]);
  res.json(r.rows);
});
app.post('/api/tables', async (req, res) => {
  const { num, seats } = req.body || {};
  const numToUse = num || (await q('SELECT COALESCE(MAX(num),0)+1 AS n FROM tables WHERE tenant_id=$1', [req.tenant.id])).rows[0].n;
  try {
    const r = await q(`INSERT INTO tables (tenant_id, num, seats, status) VALUES ($1,$2,$3,'free') RETURNING *`,
      [req.tenant.id, numToUse, seats || 4]);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate_num' });
    throw e;
  }
});
app.put('/api/tables/:id', async (req, res) => {
  const { num, seats, status, reservationName, reservationTime } = req.body || {};
  if (status && !['free', 'reserved'].includes(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  if (status === 'reserved') {
    const open = await q('SELECT 1 FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
    if (open.rows[0]) return res.status(409).json({ error: 'table_is_open' });
  }
  try {
    const r = await q(`UPDATE tables SET
                         num=COALESCE($1,num),
                         seats=COALESCE($2,seats),
                         status=COALESCE($3,status),
                         reservation_name=CASE WHEN $3='free' THEN NULL ELSE COALESCE($4,reservation_name) END,
                         reservation_time=CASE WHEN $3='free' THEN NULL ELSE COALESCE($5,reservation_time) END
                       WHERE id=$6 AND tenant_id=$7 RETURNING *`,
      [num, seats, status || null, reservationName || null, reservationTime || null, req.params.id, req.tenant.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'duplicate_num' });
    throw e;
  }
});
app.delete('/api/tables/:id', async (req, res) => {
  const open = await q('SELECT 1 FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  if (open.rows[0]) return res.status(409).json({ error: 'table_is_open' });
  await q('DELETE FROM tables WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  res.json({ ok: true });
});

// ----- WAITERS -----
app.get('/api/waiters', async (req, res) => {
  const r = await q('SELECT * FROM waiters WHERE tenant_id=$1 ORDER BY name', [req.tenant.id]);
  res.json(r.rows.map(publicWaiter));
});
app.post('/api/waiters', async (req, res) => {
  const { name, role, color, pin, commissionPercent } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const hash = pin ? await bcrypt.hash(String(pin), 10) : null;
  const r = await q(`INSERT INTO waiters (tenant_id, name, role, color, access_pin_hash, commission_percent)
                     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenant.id, name, role || 'Mozo', color || '#f97316', hash, parseFloat(commissionPercent)||0]);
  res.json(publicWaiter(r.rows[0]));
});
app.put('/api/waiters/:id', async (req, res) => {
  const { name, role, color, pin, commissionPercent } = req.body || {};
  const hash = pin ? await bcrypt.hash(String(pin), 10) : null;
  const r = await q(`UPDATE waiters SET
                       name=COALESCE($1,name),
                       role=COALESCE($2,role),
                       color=COALESCE($3,color),
                       access_pin_hash=COALESCE($4,access_pin_hash),
                       commission_percent=COALESCE($5, commission_percent)
                     WHERE id=$6 AND tenant_id=$7 RETURNING *`,
    [name, role, color, hash, commissionPercent != null ? parseFloat(commissionPercent) : null,
     req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(publicWaiter(r.rows[0]));
});
app.delete('/api/waiters/:id', async (req, res) => {
  // Si está asignado a una mesa abierta, error
  const open = await q('SELECT 1 FROM open_tables WHERE waiter_id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  if (open.rows[0]) return res.status(409).json({ error: 'waiter_has_open_tables' });
  await q('DELETE FROM waiters WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  res.json({ ok: true });
});

app.get('/api/staff-shifts', async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const r = await q(`SELECT ss.*, w.name AS waiter_name, w.role AS waiter_role, w.color AS waiter_color
                     FROM staff_shifts ss
                     JOIN waiters w ON w.id=ss.waiter_id
                     WHERE ss.tenant_id=$1 AND ss.started_at::date >= $2
                     ORDER BY ss.started_at DESC LIMIT 500`, [req.tenant.id, from]);
  res.json(r.rows);
});

// ----- OPEN TABLES -----
app.get('/api/open-tables', async (req, res) => {
  const r = await q('SELECT * FROM open_tables WHERE tenant_id=$1', [req.tenant.id]);
  res.json(r.rows);
});
app.post('/api/open-tables', async (req, res) => {
  const { tableId, waiterId } = req.body || {};
  if (!tableId || !waiterId) return res.status(400).json({ error: 'missing_fields' });
  const exists = await q('SELECT 1 FROM tables WHERE id=$1 AND tenant_id=$2', [tableId, req.tenant.id]);
  if (!exists.rows[0]) return res.status(404).json({ error: 'table_not_found' });
  const r = await q(`INSERT INTO open_tables (table_id, tenant_id, waiter_id, items, opened_at)
                     VALUES ($1,$2,$3,'[]'::jsonb, now())
                     ON CONFLICT (table_id) DO UPDATE SET waiter_id=EXCLUDED.waiter_id
                     RETURNING *`,
    [tableId, req.tenant.id, waiterId]);
  await q(`UPDATE tables SET status='free', reservation_name=NULL, reservation_time=NULL
           WHERE id=$1 AND tenant_id=$2`, [tableId, req.tenant.id]);
  res.json(r.rows[0]);
});
app.put('/api/open-tables/:tid', async (req, res) => {
  const { items, waiterId } = req.body || {};
  const r = await q(`UPDATE open_tables SET items=COALESCE($1, items), waiter_id=COALESCE($2, waiter_id)
                     WHERE table_id=$3 AND tenant_id=$4 RETURNING *`,
    [items ? JSON.stringify(items) : null, waiterId || null, req.params.tid, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});
app.delete('/api/open-tables/:tid', async (req, res) => {
  await q('DELETE FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [req.params.tid, req.tenant.id]);
  res.json({ ok: true });
});

// ----- ORDERS -----
// Cierra una mesa abierta y la convierte en orden histórica.
// Soporta: descuentos (% o monto), división de cuenta (splits), cliente con cuenta corriente,
// modificadores por ítem y descuento automático de stock.
app.post('/api/orders', async (req, res) => {
  const { tableId, paymentMethod, note, discount, discountType, splits, customerId } = req.body || {};
  if (!tableId) return res.status(400).json({ error: 'missing_fields' });

  const ot = (await q('SELECT * FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0];
  if (!ot) return res.status(404).json({ error: 'table_not_open' });

  const products = (await q('SELECT id, name, price, emoji, stock FROM products WHERE tenant_id=$1', [req.tenant.id])).rows;
  const prodMap = new Map(products.map(p => [p.id, p]));

  // Calculo subtotal usando modificadores por ítem
  let subtotal = 0;
  const items = (ot.items || []).map(it => {
    const p = prodMap.get(it.productId);
    if (!p) return it;
    const modSum = (it.modifiers || []).reduce((s, m) => s + (parseFloat(m.price) || 0), 0);
    const unitPrice = parseFloat(p.price) + modSum;
    const itemSubtotal = unitPrice * it.qty - (it.discount || 0);
    subtotal += itemSubtotal;
    return { ...it, name: p.name, price: p.price, emoji: p.emoji, subtotal: itemSubtotal };
  });

  // Aplicar descuento global
  let discountAmount = 0;
  if (discount && discount > 0) {
    discountAmount = discountType === 'percent'
      ? subtotal * (parseFloat(discount) / 100)
      : parseFloat(discount);
  }
  const total = Math.max(0, subtotal - discountAmount);

  // Validar splits: si hay splits, la suma debe coincidir con el total
  const useSplits = Array.isArray(splits) && splits.length > 0;
  if (useSplits) {
    const sumSplits = splits.reduce((s, sp) => s + parseFloat(sp.amount || 0), 0);
    if (Math.abs(sumSplits - total) > 0.5) return res.status(400).json({ error: 'splits_mismatch', expected: total, got: sumSplits });
  }

  const payMethod = useSplits
    ? splits.map(s => s.method).join('+')
    : (paymentMethod || 'efectivo');

  const table = (await q('SELECT num FROM tables WHERE id=$1', [tableId])).rows[0];
  const waiter = ot.waiter_id ? (await q('SELECT name FROM waiters WHERE id=$1', [ot.waiter_id])).rows[0] : null;

  // Caja: solo se requiere si algún pago va a un método que afecta caja (no cuenta_corriente)
  const needsCash = useSplits
    ? splits.some(s => s.method !== 'cuenta_corriente')
    : (payMethod !== 'cuenta_corriente');
  const cash = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  if (needsCash && !cash) return res.status(400).json({ error: 'cash_not_open' });
  const allOnAccount = !needsCash && customerId;

  // Insertar orden
  const order = (await q(`INSERT INTO orders (tenant_id, table_id, table_num, waiter_id, waiter_name,
                          items, subtotal, discount, discount_type, total, payment_method, note,
                          customer_id, splits, opened_at, closed_at)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now()) RETURNING *`,
    [req.tenant.id, tableId, table?.num || null, ot.waiter_id, waiter?.name || null,
     JSON.stringify(items), subtotal, discountAmount, discountType || null,
     total, payMethod, note || null, customerId || null,
     JSON.stringify(useSplits ? splits : []), ot.opened_at])).rows[0];

  // Descuento de stock por ítem (solo productos con stock controlado)
  for (const it of items) {
    const p = prodMap.get(it.productId);
    if (p && p.stock !== null && p.stock !== undefined) {
      await q('UPDATE products SET stock=GREATEST(0, stock-$1) WHERE id=$2 AND tenant_id=$3',
        [it.qty, it.productId, req.tenant.id]);
    }
  }

  // Registrar movimiento en caja (si no fue todo a cuenta corriente)
  if (cash && !allOnAccount) {
    const txs = cash.transactions || [];
    if (useSplits) {
      for (const sp of splits) {
        if (sp.method === 'cuenta_corriente') continue; // no entra a caja
        txs.push({
          id: uuid(), type: 'in', amount: parseFloat(sp.amount), method: sp.method,
          desc: 'Mesa ' + (table?.num || '?') + ' (split)', at: new Date().toISOString()
        });
      }
    } else {
      txs.push({
        id: uuid(), type: 'in', amount: total, method: payMethod,
        desc: 'Mesa ' + (table?.num || '?'), at: new Date().toISOString()
      });
    }
    await q('UPDATE current_cash SET transactions=$1 WHERE tenant_id=$2',
      [JSON.stringify(txs), req.tenant.id]);
  }

  // Si hay cliente y se cobra a cuenta corriente (total o split), cargar el balance.
  // Si hay múltiples splits a cuenta_corriente, los sumamos.
  if (customerId) {
    const amountToAccount = useSplits
      ? splits.filter(s => s.method === 'cuenta_corriente').reduce((sum, s) => sum + parseFloat(s.amount||0), 0)
      : (payMethod === 'cuenta_corriente' ? total : 0);
    if (amountToAccount > 0) {
      await q('UPDATE customers SET balance=balance+$1 WHERE id=$2 AND tenant_id=$3',
        [amountToAccount, customerId, req.tenant.id]);
      await q(`INSERT INTO customer_transactions (tenant_id, customer_id, type, amount, order_id, method, note)
               VALUES ($1,$2,'charge',$3,$4,'cuenta_corriente',$5)`,
        [req.tenant.id, customerId, amountToAccount, order.id, 'Mesa ' + (table?.num || '?')]);
    }
  }

  // Marcar tickets de cocina pendientes como entregados
  await q(`UPDATE kitchen_tickets SET status='delivered', delivered_at=now()
           WHERE tenant_id=$1 AND table_id=$2 AND status IN ('pending','preparing','ready')`,
    [req.tenant.id, tableId]);

  // Cerrar mesa abierta
  await q('DELETE FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id]);

  res.json(order);
});

// ----- CUSTOMERS (clientes / cuenta corriente) -----
app.get('/api/customers', async (req, res) => {
  const r = await q(`SELECT * FROM customers WHERE tenant_id=$1 ORDER BY name`, [req.tenant.id]);
  res.json(r.rows);
});
app.get('/api/customers/:id', async (req, res) => {
  const c = (await q('SELECT * FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  const txs = (await q('SELECT * FROM customer_transactions WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100', [c.id])).rows;
  res.json({ customer: c, transactions: txs });
});
app.post('/api/customers', async (req, res) => {
  const { name, phone, email, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const r = await q(`INSERT INTO customers (tenant_id, name, phone, email, notes)
                     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.tenant.id, name, phone || null, email || null, notes || null]);
  res.json(r.rows[0]);
});
app.put('/api/customers/:id', async (req, res) => {
  const { name, phone, email, notes } = req.body || {};
  const r = await q(`UPDATE customers SET name=COALESCE($1,name), phone=COALESCE($2,phone),
                     email=COALESCE($3,email), notes=COALESCE($4,notes)
                     WHERE id=$5 AND tenant_id=$6 RETURNING *`,
    [name, phone, email, notes, req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});
app.delete('/api/customers/:id', async (req, res) => {
  const c = (await q('SELECT balance FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  if (parseFloat(c.balance) !== 0) return res.status(409).json({ error: 'has_balance', balance: c.balance });
  await q('DELETE FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id]);
  res.json({ ok: true });
});
// Registrar pago del cliente (reduce su deuda)
app.post('/api/customers/:id/payment', async (req, res) => {
  const { amount, method, note } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid_amount' });
  const c = (await q('SELECT * FROM customers WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id])).rows[0];
  if (!c) return res.status(404).json({ error: 'not_found' });
  await q('UPDATE customers SET balance=balance-$1 WHERE id=$2', [amt, c.id]);
  await q(`INSERT INTO customer_transactions (tenant_id, customer_id, type, amount, method, note)
           VALUES ($1,$2,'payment',$3,$4,$5)`,
    [req.tenant.id, c.id, amt, method || 'efectivo', note || null]);

  // También suma a caja si está abierta y el método no es cuenta corriente
  const cash = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  if (cash && method !== 'cuenta_corriente') {
    const txs = cash.transactions || [];
    txs.push({ id: uuid(), type: 'in', amount: amt, method: method || 'efectivo',
      desc: 'Pago cuenta: ' + c.name, at: new Date().toISOString() });
    await q('UPDATE current_cash SET transactions=$1 WHERE tenant_id=$2',
      [JSON.stringify(txs), req.tenant.id]);
  }
  res.json({ ok: true });
});

// ----- KITCHEN (KDS - Kitchen Display System) -----
// Lista de tickets activos para la pantalla de cocina
app.get('/api/kitchen', async (req, res) => {
  const includeDelivered = req.query.includeDelivered === '1';
  const sql = includeDelivered
    ? `SELECT * FROM kitchen_tickets WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100`
    : `SELECT * FROM kitchen_tickets WHERE tenant_id=$1 AND status IN ('pending','preparing','ready')
       ORDER BY created_at ASC`;
  const r = await q(sql, [req.tenant.id]);
  res.json(r.rows);
});
// Crear ticket de cocina (mozo manda items a la cocina)
app.post('/api/kitchen', async (req, res) => {
  const { tableId, items, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'no_items' });
  const table = tableId ? (await q('SELECT num FROM tables WHERE id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0] : null;
  const ot = tableId ? (await q('SELECT waiter_id FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0] : null;
  const waiter = ot?.waiter_id ? (await q('SELECT name FROM waiters WHERE id=$1', [ot.waiter_id])).rows[0] : null;

  const r = await q(`INSERT INTO kitchen_tickets (tenant_id, table_id, table_num, waiter_id, waiter_name, items, notes, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING *`,
    [req.tenant.id, tableId || null, table?.num || null, ot?.waiter_id || null,
     waiter?.name || null, JSON.stringify(items), notes || null]);
  res.json(r.rows[0]);
});
// Cambiar estado del ticket
app.put('/api/kitchen/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!['pending','preparing','ready','delivered'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const setStarted = status === 'preparing' ? ', started_at=COALESCE(started_at, now())' : '';
  const setReady = status === 'ready' ? ', ready_at=COALESCE(ready_at, now())' : '';
  const setDelivered = status === 'delivered' ? ', delivered_at=COALESCE(delivered_at, now())' : '';
  const r = await q(`UPDATE kitchen_tickets SET status=$1 ${setStarted}${setReady}${setDelivered}
                     WHERE id=$2 AND tenant_id=$3 RETURNING *`,
    [status, req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.get('/api/orders', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100'), 500);
  const from = req.query.from || null;
  const params = [req.tenant.id];
  let sql = 'SELECT * FROM orders WHERE tenant_id=$1';
  if (from) { params.push(from); sql += ` AND closed_at >= $${params.length}`; }
  sql += ` ORDER BY closed_at DESC LIMIT ${limit}`;
  const r = await q(sql, params);
  res.json(r.rows);
});

// ----- CASH -----
app.get('/api/cash', async (req, res) => {
  const cur = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  const hist = (await q('SELECT * FROM cash_history WHERE tenant_id=$1 ORDER BY closed_at DESC LIMIT 20', [req.tenant.id])).rows;
  res.json({ current: cur || null, history: hist });
});
app.post('/api/cash/open', async (req, res) => {
  const { openingAmount } = req.body || {};
  const amt = parseFloat(openingAmount) || 0;
  const exists = await q('SELECT 1 FROM current_cash WHERE tenant_id=$1', [req.tenant.id]);
  if (exists.rows[0]) return res.status(409).json({ error: 'cash_already_open' });
  const r = await q(`INSERT INTO current_cash (tenant_id, opening_amount, transactions, opened_at)
                     VALUES ($1,$2,'[]'::jsonb, now()) RETURNING *`, [req.tenant.id, amt]);
  res.json(r.rows[0]);
});
app.post('/api/cash/movement', async (req, res) => {
  const { type, amount, desc, method } = req.body || {};
  if (!type || !amount || amount <= 0) return res.status(400).json({ error: 'invalid' });
  const cur = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  if (!cur) return res.status(400).json({ error: 'cash_not_open' });
  const txs = cur.transactions || [];
  txs.push({ id: uuid(), type, amount, desc: desc || 'Movimiento', method: method || 'efectivo', at: new Date().toISOString() });
  await q('UPDATE current_cash SET transactions=$1 WHERE tenant_id=$2', [JSON.stringify(txs), req.tenant.id]);
  res.json({ ok: true });
});
app.post('/api/cash/close', async (req, res) => {
  const { closingAmount } = req.body || {};
  const cur = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  if (!cur) return res.status(400).json({ error: 'cash_not_open' });
  const closing = parseFloat(closingAmount) || 0;
  const txs = cur.transactions || [];
  const totalIn = txs.filter(t => t.type === 'in').reduce((s,t) => s + t.amount, 0);
  const totalOut = txs.filter(t => t.type === 'out').reduce((s,t) => s + t.amount, 0);
  const expected = parseFloat(cur.opening_amount) + totalIn - totalOut;
  const diff = closing - expected;

  await q(`INSERT INTO cash_history (tenant_id, opening_amount, closing_amount, total_in, total_out, diff, transactions, opened_at, closed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())`,
    [req.tenant.id, cur.opening_amount, closing, totalIn, totalOut, diff, JSON.stringify(txs), cur.opened_at]);
  await q('DELETE FROM current_cash WHERE tenant_id=$1', [req.tenant.id]);
  res.json({ ok: true, diff, expected });
});

// ----- PENDING ORDERS (delivery + takeaway) -----
app.get('/api/pending-orders', async (req, res) => {
  const includeDone = req.query.includeDone === '1';
  const sql = includeDone
    ? 'SELECT * FROM pending_orders WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 200'
    : `SELECT * FROM pending_orders WHERE tenant_id=$1 AND status NOT IN ('delivered','cancelled')
       ORDER BY created_at DESC`;
  const r = await q(sql, [req.tenant.id]);
  res.json(r.rows);
});

app.post('/api/pending-orders', async (req, res) => {
  const { kind, customerId, customerName, customerPhone, deliveryAddress, deliveryEta,
          waiterId, items, notes } = req.body || {};
  if (!['takeaway','delivery'].includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
  const r = await q(`INSERT INTO pending_orders (tenant_id, kind, customer_id, customer_name, customer_phone,
                     delivery_address, delivery_eta, waiter_id, items, notes)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [req.tenant.id, kind, customerId || null, customerName || null, customerPhone || null,
     deliveryAddress || null, deliveryEta || null, waiterId || null,
     JSON.stringify(items || []), notes || null]);
  // Crear ticket de cocina automáticamente si hay items
  if (items && items.length > 0) {
    const itemsForKitchen = items.map(it => ({
      name: it.name, emoji: it.emoji, qty: it.qty, modifiers: it.modifiers||[], notes: it.notes||''
    }));
    await q(`INSERT INTO kitchen_tickets (tenant_id, items, notes, status, waiter_name)
             VALUES ($1,$2,$3,'pending',$4)`,
      [req.tenant.id, JSON.stringify(itemsForKitchen),
       kind === 'delivery' ? '🛵 Delivery' : '📦 Take away', customerName || null]);
  }
  res.json(r.rows[0]);
});

app.put('/api/pending-orders/:id', async (req, res) => {
  const { status, items, notes, deliveryEta } = req.body || {};
  const r = await q(`UPDATE pending_orders SET
                     status=COALESCE($1,status),
                     items=COALESCE($2::jsonb, items),
                     notes=COALESCE($3,notes),
                     delivery_eta=COALESCE($4,delivery_eta)
                     WHERE id=$5 AND tenant_id=$6 RETURNING *`,
    [status, items ? JSON.stringify(items) : null, notes, deliveryEta, req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

// Cobrar un pedido pending y convertirlo en orden
app.post('/api/pending-orders/:id/charge', async (req, res) => {
  const { paymentMethod, splits, discount, discountType, customerId } = req.body || {};
  const po = (await q('SELECT * FROM pending_orders WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenant.id])).rows[0];
  if (!po) return res.status(404).json({ error: 'not_found' });

  const products = (await q('SELECT id, name, price, emoji, stock FROM products WHERE tenant_id=$1', [req.tenant.id])).rows;
  const prodMap = new Map(products.map(p => [p.id, p]));

  let subtotal = 0;
  const items = (po.items || []).map(it => {
    const p = prodMap.get(it.productId);
    if (!p) return it;
    const modSum = (it.modifiers || []).reduce((s,m) => s + (parseFloat(m.price)||0), 0);
    const unit = parseFloat(p.price) + modSum;
    const itemSubtotal = unit * it.qty - (it.discount||0);
    subtotal += itemSubtotal;
    return { ...it, name: p.name, price: p.price, emoji: p.emoji, subtotal: itemSubtotal };
  });

  let discountAmount = 0;
  if (discount > 0) {
    discountAmount = discountType === 'percent' ? subtotal*(discount/100) : parseFloat(discount);
  }
  const total = Math.max(0, subtotal - discountAmount);

  const useSplits = Array.isArray(splits) && splits.length > 0;
  if (useSplits) {
    const sumSplits = splits.reduce((s, sp) => s + parseFloat(sp.amount||0), 0);
    if (Math.abs(sumSplits - total) > 0.5) return res.status(400).json({ error: 'splits_mismatch', expected: total });
  }
  const payMethod = useSplits ? splits.map(s => s.method).join('+') : (paymentMethod || 'efectivo');

  const cash = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  const needsCash = useSplits
    ? splits.some(s => s.method !== 'cuenta_corriente')
    : (payMethod !== 'cuenta_corriente');
  if (needsCash && !cash) return res.status(400).json({ error: 'cash_not_open' });
  const allOnAccount = !needsCash && (customerId || po.customer_id);

  const order = (await q(`INSERT INTO orders (tenant_id, waiter_id, waiter_name, items, subtotal,
                          discount, discount_type, total, payment_method, note, customer_id, splits, closed_at)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) RETURNING *`,
    [req.tenant.id, po.waiter_id, null, JSON.stringify(items), subtotal,
     discountAmount, discountType || null, total, payMethod,
     po.kind === 'delivery' ? '🛵 Delivery: ' + (po.delivery_address||'') : '📦 Take away',
     customerId || po.customer_id || null,
     JSON.stringify(useSplits ? splits : [])])).rows[0];

  // Descuento stock
  for (const it of items) {
    const p = prodMap.get(it.productId);
    if (p && p.stock !== null && p.stock !== undefined) {
      await q('UPDATE products SET stock=GREATEST(0, stock-$1) WHERE id=$2 AND tenant_id=$3',
        [it.qty, it.productId, req.tenant.id]);
    }
  }

  // Caja
  if (cash && !allOnAccount) {
    const txs = cash.transactions || [];
    const desc = (po.kind === 'delivery' ? 'Delivery ' : 'Take away ') + (po.customer_name||'');
    if (useSplits) {
      for (const sp of splits) {
        if (sp.method === 'cuenta_corriente') continue;
        txs.push({ id: uuid(), type:'in', amount: parseFloat(sp.amount), method: sp.method, desc, at: new Date().toISOString() });
      }
    } else {
      txs.push({ id: uuid(), type:'in', amount: total, method: payMethod, desc, at: new Date().toISOString() });
    }
    await q('UPDATE current_cash SET transactions=$1 WHERE tenant_id=$2', [JSON.stringify(txs), req.tenant.id]);
  }

  // Cuenta corriente
  const cid = customerId || po.customer_id;
  if (cid) {
    const amountToAccount = useSplits
      ? splits.filter(s => s.method === 'cuenta_corriente').reduce((sum, s) => sum + parseFloat(s.amount||0), 0)
      : (payMethod === 'cuenta_corriente' ? total : 0);
    if (amountToAccount > 0) {
      await q('UPDATE customers SET balance=balance+$1 WHERE id=$2 AND tenant_id=$3', [amountToAccount, cid, req.tenant.id]);
      await q(`INSERT INTO customer_transactions (tenant_id, customer_id, type, amount, order_id, method, note)
               VALUES ($1,$2,'charge',$3,$4,'cuenta_corriente',$5)`,
        [req.tenant.id, cid, amountToAccount, order.id, po.kind]);
    }
  }

  // Marcar pending_order como entregado y delivered
  await q(`UPDATE pending_orders SET status='delivered' WHERE id=$1`, [po.id]);
  res.json(order);
});

// ----- DASHBOARD -----
app.get('/api/dashboard', async (req, res) => {
  const tid = req.tenant.id;
  const today = new Date().toISOString().slice(0,10);
  const last7 = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);

  const [ordersToday, ordersWeek, openCount, tablesCount, prodCount, cash] = await Promise.all([
    q(`SELECT * FROM orders WHERE tenant_id=$1 AND closed_at::date=$2 ORDER BY closed_at DESC`, [tid, today]),
    q(`SELECT * FROM orders WHERE tenant_id=$1 AND closed_at::date >= $2`, [tid, last7]),
    q(`SELECT count(*)::int AS n FROM open_tables WHERE tenant_id=$1`, [tid]),
    q(`SELECT count(*)::int AS n FROM tables WHERE tenant_id=$1`, [tid]),
    q(`SELECT count(*)::int AS n, sum(CASE WHEN available THEN 1 ELSE 0 END)::int AS avail FROM products WHERE tenant_id=$1`, [tid]),
    q(`SELECT * FROM current_cash WHERE tenant_id=$1`, [tid])
  ]);

  res.json({
    ordersToday: ordersToday.rows,
    ordersWeek: ordersWeek.rows,
    openCount: openCount.rows[0].n,
    tablesCount: tablesCount.rows[0].n,
    productsTotal: prodCount.rows[0].n,
    productsAvailable: prodCount.rows[0].avail,
    cash: cash.rows[0] || null
  });
});

// ----- SETTINGS -----
app.put('/api/settings', async (req, res) => {
  const { restaurantName, currency, ownerName, phone } = req.body || {};
  const r = await q(`UPDATE tenants SET
      restaurant_name = COALESCE($1, restaurant_name),
      currency        = COALESCE($2, currency),
      owner_name      = COALESCE($3, owner_name),
      phone           = COALESCE($4, phone)
      WHERE id=$5 RETURNING *`,
    [restaurantName || null, currency || null, ownerName || null, phone || null, req.tenant.id]);
  res.json(publicTenant(r.rows[0]));
});

// ============================================================
//             PROGRAMA DE VENDEDORES (Partners)
// ============================================================

// Genera un ref_code único reintentando ante colisión.
async function uniqueRefCode(name) {
  let refCode = makeRefCode(name);
  for (let i = 0; i < 6; i++) {
    const dup = await q('SELECT id FROM vendors WHERE ref_code=$1', [refCode]);
    if (!dup.rows[0]) return refCode;
    refCode = makeRefCode(name);
  }
  return refCode;
}

// Registro de vendedor con email+password. Queda PENDING hasta que el dueño apruebe.
app.post('/vendor/register', authLimiter, async (req, res) => {
  try {
    const { email, password, name, phone, application } = req.body || {};
    if (!email || !password || !name) return res.status(400).json({ error: 'missing_fields' });
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

    const normEmail = email.toLowerCase().trim();
    const exists = await q('SELECT id FROM vendors WHERE email=$1', [normEmail]);
    if (exists.rows[0]) return res.status(409).json({ error: 'email_taken' });

    const hash = await bcrypt.hash(password, 10);
    const refCode = await uniqueRefCode(name);
    const app = application && typeof application === 'object' ? application : null;

    const ins = await q(
      `INSERT INTO vendors (email, password_hash, name, phone, ref_code, commission_percent, status, application, applied_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`,
      [normEmail, hash, name.trim(), phone || null, refCode, 40.00, app, app ? new Date() : null]
    );
    const v = ins.rows[0];
    if (app) mailer.notifyNewVendorApplication(v).catch(e => console.error('[mail] notify', e.message));
    return res.json({ token: signVendorToken(v), vendor: publicVendor(v) });
  } catch (e) {
    console.error('[vendor-register]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Registro / login de vendedor con Google
app.post('/vendor/google', authLimiter, async (req, res) => {
  try {
    const { credential, application } = req.body || {};
    const { email, googleId, name, picture } = await verifyGoogleCredential(credential);

    let v = (await q('SELECT * FROM vendors WHERE google_id=$1 OR email=$2 LIMIT 1', [googleId, email])).rows[0];
    let isNew = false;
    if (v) {
      if (!v.google_id || !v.google_picture) {
        v = (await q('UPDATE vendors SET google_id=COALESCE(google_id,$1), google_picture=COALESCE(google_picture,$2) WHERE id=$3 RETURNING *',
          [googleId, picture, v.id])).rows[0];
      }
    } else {
      isNew = true;
      const refCode = await uniqueRefCode(name);
      const app = application && typeof application === 'object' ? application : null;
      v = (await q(
        `INSERT INTO vendors (email, name, google_id, google_picture, ref_code, commission_percent, status, application, applied_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`,
        [email, name || 'Vendedor', googleId, picture, refCode, 40.00, app, app ? new Date() : null]
      )).rows[0];
      if (app) mailer.notifyNewVendorApplication(v).catch(e => console.error('[mail] notify', e.message));
    }
    return res.json({ token: signVendorToken(v), vendor: publicVendor(v), isNew });
  } catch (e) {
    if (e.code) return res.status(e.code).json({ error: e.message });
    console.error('[vendor-google]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/vendor/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    const r = await q('SELECT * FROM vendors WHERE email=$1', [email.toLowerCase().trim()]);
    const v = r.rows[0];
    if (!v || !v.password_hash) return res.status(401).json({ error: 'invalid_credentials' });
    const ok = await bcrypt.compare(password, v.password_hash);
    if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
    return res.json({ token: signVendorToken(v), vendor: publicVendor(v) });
  } catch (e) {
    console.error('[vendor-login]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.get('/vendor/me', requireVendorAuth, async (req, res) => {
  res.json({ vendor: publicVendor(req.vendor) });
});

// Enviar / actualizar la solicitud (cuando el vendedor entró por Google sin completarla aún)
app.post('/vendor/application', requireVendorAuth, async (req, res) => {
  const { application } = req.body || {};
  if (!application || typeof application !== 'object') return res.status(400).json({ error: 'missing_application' });
  // Solo permite (re)enviar solicitud si sigue pendiente
  if (req.vendor.status !== 'pending') return res.status(400).json({ error: 'already_reviewed' });
  const wasFirst = !req.vendor.application;
  const upd = await q('UPDATE vendors SET application=$1, applied_at=COALESCE(applied_at, now()), phone=COALESCE($2, phone) WHERE id=$3 RETURNING *',
    [application, application.telefono || null, req.vendor.id]);
  const v = upd.rows[0];
  if (wasFirst) mailer.notifyNewVendorApplication(v).catch(e => console.error('[mail] notify', e.message));
  res.json({ ok: true, vendor: publicVendor(v) });
});

// Listar clientes captados por el vendedor
app.get('/vendor/clients', requireVendorAuth, async (req, res) => {
  const r = await q(
    `SELECT id, restaurant_name, email, phone, subscription_status, subscription_ends_at,
            plan, created_at, last_payment_at, last_payment_amount
     FROM tenants
     WHERE vendor_id=$1
     ORDER BY created_at DESC`,
    [req.vendor.id]
  );
  res.json({ clients: r.rows });
});

// Comisiones acumuladas / historial
app.get('/vendor/commissions', requireVendorAuth, async (req, res) => {
  const r = await q(
    `SELECT vc.*, t.restaurant_name
     FROM vendor_commissions vc
     LEFT JOIN tenants t ON t.id = vc.tenant_id
     WHERE vc.vendor_id=$1
     ORDER BY vc.created_at DESC
     LIMIT 200`,
    [req.vendor.id]
  );
  res.json({ commissions: r.rows });
});

// Estadísticas resumidas
app.get('/vendor/stats', requireVendorAuth, async (req, res) => {
  const clients = await q(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE subscription_status='trial')::int AS in_trial,
       count(*) FILTER (WHERE subscription_status='active')::int AS active,
       count(*) FILTER (WHERE subscription_status IN ('expired','cancelled'))::int AS lost
     FROM tenants WHERE vendor_id=$1`,
    [req.vendor.id]
  );
  const comm = await q(
    `SELECT
       COALESCE(SUM(commission_amt),0)::numeric AS earned_total,
       COALESCE(SUM(commission_amt) FILTER (WHERE status='pending'),0)::numeric AS pending,
       COALESCE(SUM(commission_amt) FILTER (WHERE status='paid'),0)::numeric AS paid,
       count(*)::int AS commissions_count
     FROM vendor_commissions WHERE vendor_id=$1`,
    [req.vendor.id]
  );
  res.json({
    clients: clients.rows[0],
    commissions: comm.rows[0]
  });
});

// ============================================================
//          PANEL DEL DUEÑO (Admin / Organizador)
// ============================================================

// ¿Está configurado el panel de dueño?
app.get('/admin/configured', (req, res) => {
  res.json({ configured: !!(ADMIN_EMAIL && ADMIN_PASSWORD) });
});

app.post('/admin/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return res.status(503).json({ error: 'admin_not_configured' });
    if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
    if (email.toLowerCase().trim() !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    return res.json({ token: signAdminToken(), admin: { email: ADMIN_EMAIL } });
  } catch (e) {
    console.error('[admin-login]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Login de admin con Google (solo si el email coincide con ADMIN_EMAIL)
app.post('/admin/google', authLimiter, async (req, res) => {
  try {
    if (!ADMIN_EMAIL) return res.status(503).json({ error: 'admin_not_configured' });
    const { credential } = req.body || {};
    const { email } = await verifyGoogleCredential(credential);
    if (email !== ADMIN_EMAIL) return res.status(403).json({ error: 'not_admin' });
    return res.json({ token: signAdminToken(), admin: { email: ADMIN_EMAIL } });
  } catch (e) {
    if (e.code) return res.status(e.code).json({ error: e.message });
    console.error('[admin-google]', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// Resumen global del negocio
app.get('/admin/stats', requireAdminAuth, async (req, res) => {
  const tenants = await q(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE subscription_status='trial')::int AS trial,
      count(*) FILTER (WHERE subscription_status='active')::int AS active,
      count(*) FILTER (WHERE subscription_status IN ('expired','cancelled','grace'))::int AS inactive
    FROM tenants`);
  const vendors = await q(`SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status='pending')::int AS pending,
      count(*) FILTER (WHERE status='active')::int AS active,
      count(*) FILTER (WHERE status='rejected')::int AS rejected
    FROM vendors`);
  const revenue = await q(`SELECT
      COALESCE(SUM(amount),0)::numeric AS total_collected,
      count(*)::int AS payments
    FROM subscription_payments WHERE status IN ('approved','authorized')`);
  const mrr = await q(`SELECT COALESCE(SUM(last_payment_amount),0)::numeric AS mrr
    FROM tenants WHERE subscription_status='active'`);
  const commissions = await q(`SELECT
      COALESCE(SUM(commission_amt),0)::numeric AS total,
      COALESCE(SUM(commission_amt) FILTER (WHERE status='pending'),0)::numeric AS pending,
      COALESCE(SUM(commission_amt) FILTER (WHERE status='paid'),0)::numeric AS paid
    FROM vendor_commissions`);
  res.json({
    tenants: tenants.rows[0], vendors: vendors.rows[0],
    revenue: revenue.rows[0], mrr: parseFloat(mrr.rows[0].mrr),
    commissions: commissions.rows[0]
  });
});

// Listar vendedores (con filtro opcional ?status=pending)
app.get('/admin/vendors', requireAdminAuth, async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = '';
  if (status) { where = 'WHERE v.status=$1'; params.push(status); }
  const r = await q(
    `SELECT v.*,
            (SELECT count(*)::int FROM tenants t WHERE t.vendor_id=v.id) AS clients_count,
            (SELECT count(*)::int FROM tenants t WHERE t.vendor_id=v.id AND t.subscription_status='active') AS active_clients,
            (SELECT COALESCE(SUM(commission_amt),0)::numeric FROM vendor_commissions vc WHERE vc.vendor_id=v.id) AS commissions_total
     FROM vendors v ${where}
     ORDER BY v.created_at DESC`,
    params
  );
  res.json({ vendors: r.rows.map(v => ({ ...publicVendor(v), application: v.application, clientsCount: v.clients_count, activeClients: v.active_clients, commissionsTotal: parseFloat(v.commissions_total) })) });
});

// Detalle de un vendedor + sus clientes
app.get('/admin/vendors/:id', requireAdminAuth, async (req, res) => {
  const v = (await q('SELECT * FROM vendors WHERE id=$1', [req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  const clients = (await q(`SELECT id, restaurant_name, email, phone, subscription_status, plan, created_at, last_payment_amount
                            FROM tenants WHERE vendor_id=$1 ORDER BY created_at DESC`, [v.id])).rows;
  res.json({ vendor: { ...publicVendor(v), application: v.application }, clients });
});

// Aprobar vendedor
app.post('/admin/vendors/:id/approve', requireAdminAuth, async (req, res) => {
  const v = (await q(`UPDATE vendors SET status='active', reviewed_at=now() WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  mailer.notifyVendorApproved(v).catch(e => console.error('[mail] approve', e.message));
  res.json({ ok: true, vendor: publicVendor(v) });
});

// Rechazar vendedor
app.post('/admin/vendors/:id/reject', requireAdminAuth, async (req, res) => {
  const v = (await q(`UPDATE vendors SET status='rejected', reviewed_at=now() WHERE id=$1 RETURNING *`, [req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  mailer.notifyVendorRejected(v).catch(e => console.error('[mail] reject', e.message));
  res.json({ ok: true, vendor: publicVendor(v) });
});

// Cambiar % de comisión de un vendedor
app.post('/admin/vendors/:id/commission', requireAdminAuth, async (req, res) => {
  const pct = parseFloat(req.body?.commissionPercent);
  if (isNaN(pct) || pct < 0 || pct > 100) return res.status(400).json({ error: 'invalid_percent' });
  const v = (await q('UPDATE vendors SET commission_percent=$1 WHERE id=$2 RETURNING *', [pct, req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, vendor: publicVendor(v) });
});

// Pausar / reactivar vendedor
app.post('/admin/vendors/:id/status', requireAdminAuth, async (req, res) => {
  const status = req.body?.status;
  if (!['active', 'paused'].includes(status)) return res.status(400).json({ error: 'invalid_status' });
  const v = (await q('UPDATE vendors SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id])).rows[0];
  if (!v) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, vendor: publicVendor(v) });
});

// Listar comisiones (global o ?status=pending)
app.get('/admin/commissions', requireAdminAuth, async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = '';
  if (status) { where = 'WHERE vc.status=$1'; params.push(status); }
  const r = await q(
    `SELECT vc.*, v.name AS vendor_name, t.restaurant_name
     FROM vendor_commissions vc
     LEFT JOIN vendors v ON v.id=vc.vendor_id
     LEFT JOIN tenants t ON t.id=vc.tenant_id
     ${where}
     ORDER BY vc.created_at DESC LIMIT 300`,
    params
  );
  res.json({ commissions: r.rows });
});

// Marcar comisión como pagada al vendedor
app.post('/admin/commissions/:id/pay', requireAdminAuth, async (req, res) => {
  const r = await q(`UPDATE vendor_commissions SET status='paid', paid_at=now() WHERE id=$1 RETURNING *`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

// Listar todos los restaurantes (clientes del negocio)
app.get('/admin/tenants', requireAdminAuth, async (req, res) => {
  const r = await q(
    `SELECT t.id, t.restaurant_name, t.email, t.phone, t.subscription_status, t.plan,
            t.created_at, t.last_payment_at, t.last_payment_amount, v.name AS vendor_name
     FROM tenants t LEFT JOIN vendors v ON v.id=t.vendor_id
     ORDER BY t.created_at DESC LIMIT 500`
  );
  res.json({ tenants: r.rows });
});

// ============================================================
//                       Health
// ============================================================

// ----- MENÚ PÚBLICO (QR carta digital, sin auth) -----
app.get('/public/menu/:tenantId', async (req, res) => {
  try {
    const t = (await q('SELECT id, restaurant_name, currency, phone FROM tenants WHERE id=$1', [req.params.tenantId])).rows[0];
    if (!t) return res.status(404).json({ error: 'not_found' });
    const products = (await q(`SELECT id, name, cat, price, photo_url, available FROM products
                               WHERE tenant_id=$1 AND available=true ORDER BY cat, name`, [t.id])).rows;
    // Agrupar por categoría
    const grouped = {};
    for (const p of products) {
      const cat = p.cat || 'Otros';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(p);
    }
    res.json({
      restaurant: { id: t.id, name: t.restaurant_name, currency: t.currency, phone: t.phone },
      categories: Object.entries(grouped).map(([name, items]) => ({ name, items }))
    });
  } catch (e) {
    console.error('[public-menu]', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// PUT mesa con posición visual ya soportado por endpoint existente — solo agregamos pos_x/pos_y al PUT
// (el endpoint existente ya hace COALESCE en cada campo)
app.put('/api/tables/:id/position', requireAuth, requireSubscription, async (req, res) => {
  const { x, y } = req.body || {};
  const r = await q(`UPDATE tables SET pos_x=$1, pos_y=$2 WHERE id=$3 AND tenant_id=$4 RETURNING *`,
    [parseInt(x)||0, parseInt(y)||0, req.params.id, req.tenant.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(r.rows[0]);
});

app.get('/', (req, res) => res.json({ ok: true, service: 'gestiva-backend', time: new Date().toISOString() }));
app.get('/health', async (req, res) => {
  try {
    await q('SELECT 1');
    res.json({ ok: true, db: 'up' });
  } catch (e) {
    res.status(500).json({ ok: false, db: e.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ error: 'not_found' }));

// Error handler
app.use((err, req, res, next) => {
  console.error('[err]', err);
  res.status(500).json({ error: 'server_error', detail: err.message });
});

app.listen(PORT, () => console.log(`[gp] listening on ${PORT}`));
