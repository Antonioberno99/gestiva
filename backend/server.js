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

// ---------- Config ----------
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-prod-gp';
const MP_TOKEN = process.env.MP_ACCESS_TOKEN || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${PORT}`;
const SUB_PRICE = parseFloat(process.env.SUB_PRICE_ARS || '40000');
const GRACE_DAYS = parseInt(process.env.GRACE_DAYS || '7', 10);
// SKIP_BILLING=1 desactiva todo cobro: registros quedan 'active' por 1 año.
// Útil mientras no esté integrado el banco. Para activar cobro real, poner SKIP_BILLING=0.
const SKIP_BILLING = process.env.SKIP_BILLING === '1' || !MP_TOKEN;

if (SKIP_BILLING) console.warn('[billing] SKIP_BILLING active — todos los registros se activan automáticamente');
else if (!MP_TOKEN) console.warn('[mp] MP_ACCESS_TOKEN missing — billing endpoints will fail');

// ---------- Database ----------
const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl && (dbUrl.includes('render.com') || dbUrl.includes('amazonaws')) ? { rejectUnauthorized: false } : false
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

function publicTenant(t) {
  return {
    id: t.id, email: t.email,
    restaurantName: t.restaurant_name,
    ownerName: t.owner_name,
    phone: t.phone,
    currency: t.currency,
    subscriptionStatus: t.subscription_status,
    subscriptionEndsAt: t.subscription_ends_at,
    graceEndsAt: t.grace_ends_at,
    mpInitPoint: t.mp_init_point,
    daysLeft: computeDaysLeft(t)
  };
}

function publicWaiter(w) {
  return {
    id: w.id,
    tenant_id: w.tenant_id,
    name: w.name,
    color: w.color,
    hasPin: !!w.access_pin_hash,
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
  { cat: 'Comida', name: 'Plato 1', price: 5000, emoji: '🍽️' },
  { cat: 'Comida', name: 'Plato 2', price: 7000, emoji: '🍽️' },
  { cat: 'Comida', name: 'Plato 3', price: 9000, emoji: '🍽️' },
  { cat: 'Tragos', name: 'Trago 1', price: 3500, emoji: '🍹' },
  { cat: 'Tragos', name: 'Trago 2', price: 4500, emoji: '🍸' },
  { cat: 'Bebidas', name: 'Bebida 1', price: 1800, emoji: '🥤' },
  { cat: 'Bebidas', name: 'Bebida 2', price: 2500, emoji: '🧃' },
  { cat: 'Postres', name: 'Postre 1', price: 3000, emoji: '🍰' }
];

async function seedDefaultProducts(tenantId, { onlyIfEmpty = true } = {}) {
  if (onlyIfEmpty) {
    const existing = await q('SELECT count(*)::int AS n FROM products WHERE tenant_id=$1', [tenantId]);
    if (existing.rows[0].n > 0) return 0;
  }

  for (const p of DEFAULT_PRODUCTS) {
    await q(`INSERT INTO products (tenant_id, name, cat, price, emoji, available)
             VALUES ($1,$2,$3,$4,$5,true)`,
      [tenantId, p.name, p.cat, p.price, p.emoji]);
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
  if (s === 'active' || s === 'grace') return next();
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
    if (!SKIP_BILLING && !['active', 'grace'].includes(t.subscription_status)) {
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

// ============================================================
//                       AUTH
// ============================================================

app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    const { email, password, restaurantName, ownerName, phone } = req.body || {};
    if (!email || !password || !restaurantName)
      return res.status(400).json({ error: 'missing_fields' });
    if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

    const exists = await q('SELECT id FROM tenants WHERE email=$1', [email.toLowerCase().trim()]);
    if (exists.rows[0]) return res.status(409).json({ error: 'email_taken' });

    const hash = await bcrypt.hash(password, 10);

    // Si SKIP_BILLING está activo, dejamos al tenant 'active' por 1 año desde el registro.
    let initialStatus = 'pending';
    let endsAt = null, graceEndsAt = null, startedAt = null;
    if (SKIP_BILLING) {
      initialStatus = 'active';
      startedAt = new Date();
      endsAt = new Date(startedAt.getTime() + 365 * 86400000);
      graceEndsAt = new Date(endsAt.getTime() + GRACE_DAYS * 86400000);
    }

    const ins = await q(
      `INSERT INTO tenants (email, password_hash, restaurant_name, owner_name, phone,
                            subscription_status, subscription_started_at, subscription_ends_at, grace_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [email.toLowerCase().trim(), hash, restaurantName.trim(), ownerName || null, phone || null,
       initialStatus, startedAt, endsAt, graceEndsAt]
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
    const r = await q('SELECT * FROM tenants WHERE email=$1', [email.toLowerCase().trim()]);
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

// ============================================================
//                       BILLING (MercadoPago)
// ============================================================

// Crea una suscripción mensual recurrente en MP y devuelve el init_point
app.post('/billing/subscribe', requireAuth, async (req, res) => {
  try {
    if (!mpClient) return res.status(500).json({ error: 'mp_not_configured' });
    const t = req.tenant;

    // Si ya tiene una init_point activa, reutilizar
    if (t.mp_init_point && t.subscription_status === 'pending') {
      return res.json({ initPoint: t.mp_init_point, reused: true });
    }

    const preApproval = new PreApproval(mpClient);
    const result = await preApproval.create({
      body: {
        reason: `Gestiva · ${t.restaurant_name}`,
        external_reference: t.id,
        payer_email: t.email,
        back_url: `${APP_URL}/billing-return.html`,
        status: 'pending',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: SUB_PRICE,
          currency_id: 'ARS'
        },
        notification_url: `${BACKEND_URL}/billing/webhook`
      }
    });

    await q('UPDATE tenants SET mp_preapproval_id=$1, mp_init_point=$2 WHERE id=$3',
      [result.id, result.init_point, t.id]);

    return res.json({ initPoint: result.init_point, preapprovalId: result.id });
  } catch (e) {
    console.error('[subscribe]', e?.cause || e?.message || e);
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
      const tenantId = info.external_reference;
      if (!tenantId) { res.sendStatus(200); return; }

      // status: pending, authorized, paused, cancelled
      if (info.status === 'authorized') {
        const now = new Date();
        const ends = new Date(now.getTime() + 30 * 86400000);
        const grace = new Date(ends.getTime() + GRACE_DAYS * 86400000);
        await q(`UPDATE tenants SET subscription_status='active',
                 subscription_started_at=COALESCE(subscription_started_at, $1),
                 subscription_ends_at=$2, grace_ends_at=$3,
                 last_payment_at=$1, last_payment_amount=$4
                 WHERE id=$5`,
          [now, ends, grace, SUB_PRICE, tenantId]);
        await q(`INSERT INTO subscription_payments (tenant_id, mp_preapproval_id, amount, status, raw)
                 VALUES ($1,$2,$3,$4,$5)`, [tenantId, data.id, SUB_PRICE, 'authorized', info]);
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
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error('[webhook]', e);
    res.sendStatus(200); // MP reintenta si devolvemos error — preferimos 200 y loguear
  }
});

app.get('/billing/status', requireAuth, async (req, res) => {
  res.json({
    status: req.tenant.subscription_status,
    endsAt: req.tenant.subscription_ends_at,
    graceEndsAt: req.tenant.grace_ends_at,
    daysLeft: computeDaysLeft(req.tenant),
    initPoint: req.tenant.mp_init_point,
    lastPaymentAt: req.tenant.last_payment_at,
    lastPaymentAmount: req.tenant.last_payment_amount
  });
});

// DEV ONLY: simular pago exitoso (solo si MP_TEST_MODE=1)
app.post('/billing/dev-activate', requireAuth, async (req, res) => {
  if (process.env.MP_TEST_MODE !== '1') return res.status(403).json({ error: 'not_in_test_mode' });
  const now = new Date();
  const ends = new Date(now.getTime() + 30 * 86400000);
  const grace = new Date(ends.getTime() + GRACE_DAYS * 86400000);
  await q(`UPDATE tenants SET subscription_status='active',
           subscription_started_at=COALESCE(subscription_started_at,$1),
           subscription_ends_at=$2, grace_ends_at=$3,
           last_payment_at=$1, last_payment_amount=$4 WHERE id=$5`,
    [now, ends, grace, SUB_PRICE, req.tenant.id]);
  res.json({ ok: true });
});

// ============================================================
//                       WAITER APP
// ============================================================

app.post('/waiter/login', authLimiter, async (req, res) => {
  try {
    const { email, pin } = req.body || {};
    if (!email || !pin) return res.status(400).json({ error: 'missing_fields' });
    const tenant = (await q('SELECT * FROM tenants WHERE email=$1', [email.toLowerCase().trim()])).rows[0];
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
  const [tables, openTables, products] = await Promise.all([
    q('SELECT * FROM tables WHERE tenant_id=$1 ORDER BY num', [req.tenant.id]),
    q('SELECT * FROM open_tables WHERE tenant_id=$1', [req.tenant.id]),
    q('SELECT * FROM products WHERE tenant_id=$1 AND available=true ORDER BY cat, name', [req.tenant.id])
  ]);
  res.json({
    restaurant: publicTenant(req.tenant),
    waiter: publicWaiter(req.waiter),
    tables: tables.rows,
    openTables: openTables.rows,
    products: products.rows
  });
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
  const { name, cat, price, emoji, available } = req.body || {};
  if (!name || price == null) return res.status(400).json({ error: 'missing_fields' });
  const r = await q(`INSERT INTO products (tenant_id, name, cat, price, emoji, available)
                     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [req.tenant.id, name, cat || 'Sin categoría', price, emoji || '🍽️', available !== false]);
  res.json(r.rows[0]);
});
app.put('/api/products/:id', async (req, res) => {
  const { name, cat, price, emoji, available } = req.body || {};
  const r = await q(`UPDATE products SET name=$1, cat=$2, price=$3, emoji=$4, available=$5
                     WHERE id=$6 AND tenant_id=$7 RETURNING *`,
    [name, cat, price, emoji, available, req.params.id, req.tenant.id]);
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
  const { name, color, pin } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const hash = pin ? await bcrypt.hash(String(pin), 10) : null;
  const r = await q(`INSERT INTO waiters (tenant_id, name, color, access_pin_hash) VALUES ($1,$2,$3,$4) RETURNING *`,
    [req.tenant.id, name, color || '#f97316', hash]);
  res.json(publicWaiter(r.rows[0]));
});
app.put('/api/waiters/:id', async (req, res) => {
  const { name, color, pin } = req.body || {};
  const hash = pin ? await bcrypt.hash(String(pin), 10) : null;
  const r = await q(`UPDATE waiters SET
                       name=COALESCE($1,name),
                       color=COALESCE($2,color),
                       access_pin_hash=COALESCE($3,access_pin_hash)
                     WHERE id=$4 AND tenant_id=$5 RETURNING *`,
    [name, color, hash, req.params.id, req.tenant.id]);
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
// Cierra una mesa abierta y la convierte en orden histórica
app.post('/api/orders', async (req, res) => {
  const { tableId, paymentMethod, note } = req.body || {};
  if (!tableId || !paymentMethod) return res.status(400).json({ error: 'missing_fields' });

  const ot = (await q('SELECT * FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id])).rows[0];
  if (!ot) return res.status(404).json({ error: 'table_not_open' });

  const products = (await q('SELECT id, name, price, emoji FROM products WHERE tenant_id=$1', [req.tenant.id])).rows;
  const prodMap = new Map(products.map(p => [p.id, p]));

  let total = 0;
  const items = (ot.items || []).map(it => {
    const p = prodMap.get(it.productId);
    if (!p) return it;
    const subtotal = parseFloat(p.price) * it.qty;
    total += subtotal;
    return { ...it, name: p.name, price: p.price, emoji: p.emoji, subtotal };
  });

  const table = (await q('SELECT num FROM tables WHERE id=$1', [tableId])).rows[0];
  const waiter = ot.waiter_id ? (await q('SELECT name FROM waiters WHERE id=$1', [ot.waiter_id])).rows[0] : null;

  // Open cash check
  const cash = (await q('SELECT * FROM current_cash WHERE tenant_id=$1', [req.tenant.id])).rows[0];
  if (!cash) return res.status(400).json({ error: 'cash_not_open' });

  const order = (await q(`INSERT INTO orders (tenant_id, table_id, table_num, waiter_id, waiter_name, items, total, payment_method, note, opened_at, closed_at)
                          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()) RETURNING *`,
    [req.tenant.id, tableId, table?.num || null, ot.waiter_id, waiter?.name || null,
     JSON.stringify(items), total, paymentMethod, note || null, ot.opened_at])).rows[0];

  // Register cash transaction
  const txs = cash.transactions || [];
  txs.push({
    id: uuid(), type: 'in', amount: total, method: paymentMethod,
    desc: 'Mesa ' + (table?.num || '?'), at: new Date().toISOString()
  });
  await q('UPDATE current_cash SET transactions=$1 WHERE tenant_id=$2',
    [JSON.stringify(txs), req.tenant.id]);

  // Close the open table
  await q('DELETE FROM open_tables WHERE table_id=$1 AND tenant_id=$2', [tableId, req.tenant.id]);

  res.json(order);
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
//                       Health
// ============================================================

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
