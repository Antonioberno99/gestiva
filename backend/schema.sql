-- ============================================================
-- Gestiva SaaS — Multi-tenant schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ANALYTICS EVENTS (visitas web y eventos de marketing)
CREATE TABLE IF NOT EXISTS analytics_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page       TEXT NOT NULL,          -- 'landing', 'signup', 'checkout', etc.
  event      TEXT NOT NULL,          -- 'pageview', 'click_precios', 'click_probar', 'signup', etc.
  referrer   TEXT,
  ua         TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analytics_page ON analytics_events(page, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_event ON analytics_events(event, created_at DESC);

-- TENANTS (one per restaurant / business)
CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT NOT NULL,
  restaurant_name TEXT NOT NULL,
  owner_name      TEXT,
  phone           TEXT,
  currency        TEXT DEFAULT '$',
  created_at      TIMESTAMPTZ DEFAULT now(),

  -- Subscription
  subscription_status   TEXT DEFAULT 'pending', -- pending, active, grace, expired, cancelled
  subscription_started_at TIMESTAMPTZ,
  subscription_ends_at  TIMESTAMPTZ,
  grace_ends_at         TIMESTAMPTZ,
  mp_preapproval_id     TEXT,
  mp_init_point         TEXT,
  last_payment_at       TIMESTAMPTZ,
  last_payment_amount   NUMERIC(12,2)
);

CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);

-- Soporte para login con Google (Google Identity Services)
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS google_picture TEXT;
ALTER TABLE IF EXISTS tenants ALTER COLUMN password_hash DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenants_google ON tenants(google_id);

-- Plan de suscripción: 'start' (18.900), 'pro' (39.000), 'full' (63.000) ARS/mes
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'pro';

-- PRODUCTS
CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cat         TEXT,
  price       NUMERIC(12,2) NOT NULL,
  emoji       TEXT DEFAULT '🍽️',
  available   BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_products_tenant ON products(tenant_id);

-- TABLES (mesas)
CREATE TABLE IF NOT EXISTS tables (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  num        INT NOT NULL,
  seats      INT DEFAULT 4,
  status     TEXT DEFAULT 'free',
  reservation_name TEXT,
  reservation_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (tenant_id, num)
);
ALTER TABLE IF EXISTS tables ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'free';
ALTER TABLE IF EXISTS tables ADD COLUMN IF NOT EXISTS reservation_name TEXT;
ALTER TABLE IF EXISTS tables ADD COLUMN IF NOT EXISTS reservation_time TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tables_tenant ON tables(tenant_id);

-- WAITERS
CREATE TABLE IF NOT EXISTS waiters (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT DEFAULT 'Mozo',
  color      TEXT DEFAULT '#f97316',
  access_pin_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE IF EXISTS waiters ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'Mozo';
ALTER TABLE IF EXISTS waiters ADD COLUMN IF NOT EXISTS access_pin_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_waiters_tenant ON waiters(tenant_id);

-- STAFF SHIFTS (ingreso/salida del equipo)
CREATE TABLE IF NOT EXISTS staff_shifts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waiter_id   UUID NOT NULL REFERENCES waiters(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ DEFAULT now(),
  ended_at    TIMESTAMPTZ,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_tenant ON staff_shifts(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_waiter ON staff_shifts(waiter_id, started_at DESC);

-- OPEN TABLES (mesas actualmente ocupadas)
CREATE TABLE IF NOT EXISTS open_tables (
  table_id   UUID PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  waiter_id  UUID REFERENCES waiters(id) ON DELETE SET NULL,
  items      JSONB DEFAULT '[]'::jsonb,
  opened_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_open_tables_tenant ON open_tables(tenant_id);

-- ORDERS (closed/historic)
CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_id        UUID,
  table_num       INT,
  waiter_id       UUID,
  waiter_name     TEXT,
  items           JSONB NOT NULL,
  total           NUMERIC(12,2) NOT NULL,
  payment_method  TEXT NOT NULL,
  note            TEXT,
  opened_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_tenant ON orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_closed_at ON orders(tenant_id, closed_at DESC);

-- CASH (current session, one row per tenant when open)
CREATE TABLE IF NOT EXISTS current_cash (
  tenant_id       UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  opening_amount  NUMERIC(12,2) NOT NULL,
  transactions    JSONB DEFAULT '[]'::jsonb,
  opened_at       TIMESTAMPTZ DEFAULT now()
);

-- CASH HISTORY (closed sessions)
CREATE TABLE IF NOT EXISTS cash_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  opening_amount  NUMERIC(12,2),
  closing_amount  NUMERIC(12,2),
  total_in        NUMERIC(12,2),
  total_out       NUMERIC(12,2),
  diff            NUMERIC(12,2),
  transactions    JSONB,
  opened_at       TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cash_history_tenant ON cash_history(tenant_id, closed_at DESC);

-- ============================================================
-- FASE 1 — Stock, modificadores, descuentos, clientes, cocina
-- ============================================================

-- Stock, modificadores y foto del producto
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS stock INT;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS low_stock_alert INT DEFAULT 5;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS modifiers JSONB DEFAULT '[]'::jsonb;
ALTER TABLE IF EXISTS products ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Descuentos y splits en mesas y órdenes
ALTER TABLE IF EXISTS open_tables ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE IF EXISTS open_tables ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS subtotal NUMERIC(12,2);
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount NUMERIC(12,2) DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_type TEXT;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_id UUID;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS splits JSONB DEFAULT '[]'::jsonb;

-- CLIENTES (cuenta corriente / fiados)
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  notes       TEXT,
  balance     NUMERIC(12,2) DEFAULT 0,  -- positivo = nos debe, negativo = saldo a favor
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customers_tenant ON customers(tenant_id);

CREATE TABLE IF NOT EXISTS customer_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,   -- 'charge' (consumo a cuenta) | 'payment' (pago de deuda)
  amount      NUMERIC(12,2) NOT NULL,
  order_id    UUID,
  method      TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cust_tx_customer ON customer_transactions(customer_id, created_at DESC);

-- TICKETS DE COCINA (KDS - Kitchen Display System)
CREATE TABLE IF NOT EXISTS kitchen_tickets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  table_id    UUID,
  table_num   INT,
  waiter_id   UUID,
  waiter_name TEXT,
  items       JSONB NOT NULL,
  status      TEXT DEFAULT 'pending',  -- pending | preparing | ready | delivered
  notes       TEXT,
  started_at  TIMESTAMPTZ,
  ready_at    TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kitchen_tenant_status ON kitchen_tickets(tenant_id, status, created_at);

-- ============================================================
-- FASE 2 — Delivery/takeaway, plano visual, comisiones, QR menu
-- ============================================================

-- Posición visual de las mesas en el salón (drag & drop)
ALTER TABLE IF EXISTS tables ADD COLUMN IF NOT EXISTS pos_x INT;
ALTER TABLE IF EXISTS tables ADD COLUMN IF NOT EXISTS pos_y INT;

-- Comisión por mozo
ALTER TABLE IF EXISTS waiters ADD COLUMN IF NOT EXISTS commission_percent NUMERIC(5,2) DEFAULT 0;

-- Pedidos para llevar y delivery (sin mesa física)
CREATE TABLE IF NOT EXISTS pending_orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,  -- 'takeaway' | 'delivery'
  customer_id     UUID,
  customer_name   TEXT,
  customer_phone  TEXT,
  delivery_address TEXT,
  delivery_eta    TEXT,           -- "30 min", "20:30"
  waiter_id       UUID,
  items           JSONB DEFAULT '[]'::jsonb,
  status          TEXT DEFAULT 'pending',  -- pending | preparing | ready | dispatched | delivered | cancelled
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_orders_tenant ON pending_orders(tenant_id, status, created_at DESC);

-- SUBSCRIPTION PAYMENTS
CREATE TABLE IF NOT EXISTS subscription_payments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mp_payment_id   TEXT,
  mp_preapproval_id TEXT,
  amount          NUMERIC(12,2),
  status          TEXT,
  raw             JSONB,
  paid_at         TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subpay_tenant ON subscription_payments(tenant_id, paid_at DESC);

-- PLANES DE MERCADOPAGO (preapproval_plan) — cacheados por tier
-- La cuenta solo permite "Suscripciones con plan", así que creamos un plan
-- por cada tier (start/pro/full) y guardamos su id + init_point.
CREATE TABLE IF NOT EXISTS mp_plans (
  tier        TEXT PRIMARY KEY,             -- 'start' | 'pro' | 'full'
  mp_plan_id  TEXT NOT NULL,
  init_point  TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  has_free_trial BOOLEAN DEFAULT false,     -- plan creado con el mes gratis (free_trial)
  created_at  TIMESTAMPTZ DEFAULT now()
);
-- Al agregar la columna (1ra vez), los planes viejos quedan en false y se regeneran
-- una sola vez con el free_trial en el próximo /billing/subscribe.
ALTER TABLE IF EXISTS mp_plans ADD COLUMN IF NOT EXISTS has_free_trial BOOLEAN DEFAULT false;
-- Modelo nuevo: el dueño deja la tarjeta y arranca el mes gratis; MP cobra al terminar.
-- Marcamos cancelaciones "al fin de período" para mantener acceso hasta que venza.
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;

-- LANZAMIENTO: eliminar la cuenta demo de pruebas (ya no se usa).
DELETE FROM tenants WHERE email = 'demo@gestiva.app';

-- LIMPIEZA ÚNICA de datos de prueba (QA pre-lanzamiento).
-- Corre UNA sola vez (marcada por la tabla _qa_cleaned) y NUNCA rompe el arranque
-- (cualquier error queda capturado por el EXCEPTION). Borra restaurantes y vendedores
-- de prueba creados en los tests; el CASCADE limpia mesas, pagos, comandas y comisiones.
DO $$
BEGIN
  IF to_regclass('public._qa_cleaned') IS NULL THEN
    BEGIN
      UPDATE tenants SET vendor_id = NULL
        WHERE vendor_id IN (
          SELECT id FROM vendors
          WHERE email ~* '^(qaven|vqa|qa)[a-z0-9]*@gmail\.com$' OR name ILIKE '%QA%'
        );
      DELETE FROM tenants
        WHERE email ~* '^(probe|qa|launch|trial|rqa|rdir|rbad|vqa)[a-z0-9]*@gmail\.com$'
           OR restaurant_name ILIKE '%QA%'
           OR restaurant_name = 'Probe';
      DELETE FROM vendors
        WHERE email ~* '^(qaven|vqa|qa)[a-z0-9]*@gmail\.com$' OR name ILIKE '%QA%';
      CREATE TABLE _qa_cleaned (done boolean DEFAULT true);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Limpieza de datos de prueba omitida: %', SQLERRM;
    END;
  END IF;
END $$;

-- Limpieza de datos de QA automatizado: usan el dominio @gestiva-qa.test y nombres "[QA] ..."
-- que NINGÚN cliente real puede tener. Por eso es seguro borrarlos en CADA deploy.
DO $$
BEGIN
  UPDATE tenants SET vendor_id = NULL
    WHERE vendor_id IN (SELECT id FROM vendors WHERE email LIKE '%@gestiva-qa.test' OR name LIKE '[QA]%');
  DELETE FROM tenants WHERE email LIKE '%@gestiva-qa.test' OR restaurant_name LIKE '[QA]%';
  DELETE FROM vendors WHERE email LIKE '%@gestiva-qa.test' OR name LIKE '[QA]%';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Limpieza QA namespace omitida: %', SQLERRM;
END $$;

-- ============================================================
-- PROGRAMA DE VENDEDORES (Partners / Resellers)
-- ============================================================

-- VENDORS (cuenta de vendedor independiente)
CREATE TABLE IF NOT EXISTS vendors (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email               TEXT UNIQUE NOT NULL,
  password_hash       TEXT,                            -- null si entra solo con Google
  name                TEXT NOT NULL,
  phone               TEXT,
  ref_code            TEXT UNIQUE NOT NULL,            -- código único para el link
  commission_percent  NUMERIC(5,2) DEFAULT 40.00,      -- % sobre cobros de sus clientes
  status              TEXT DEFAULT 'pending',          -- pending | active | rejected | paused
  created_at          TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vendors_ref ON vendors(ref_code);

-- Soporte Google + solicitud (application) + revisión del dueño
ALTER TABLE IF EXISTS vendors ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS google_picture TEXT;
ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS application JSONB;     -- datos de la solicitud
ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS vendors ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status, created_at DESC);
-- Comisión estándar 40%. Actualizar default y vendedores creados con el default viejo (20%).
ALTER TABLE IF EXISTS vendors ALTER COLUMN commission_percent SET DEFAULT 40.00;
UPDATE vendors SET commission_percent = 40.00 WHERE commission_percent = 20.00;

-- Asociación tenant ↔ vendor (cliente captado por vendedor)
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS vendor_id UUID;
CREATE INDEX IF NOT EXISTS idx_tenants_vendor ON tenants(vendor_id);

-- COMISIONES generadas por cobros de suscripción
CREATE TABLE IF NOT EXISTS vendor_commissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payment_amount  NUMERIC(12,2) NOT NULL,              -- monto del cobro de suscripción
  commission_pct  NUMERIC(5,2) NOT NULL,               -- % aplicado en ese momento
  commission_amt  NUMERIC(12,2) NOT NULL,              -- monto efectivo de la comisión
  status          TEXT DEFAULT 'pending',              -- pending | paid
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vc_vendor ON vendor_commissions(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vc_tenant ON vendor_commissions(tenant_id);

-- ============================================================
-- CÓDIGOS DE ACCESO GRATIS (cuentas de cortesía)
-- El dueño crea códigos desde su panel y los reparte (amigos, pruebas).
-- Quien lo usa al registrarse entra con acceso completo, gratis y sin tarjeta.
-- ============================================================
CREATE TABLE IF NOT EXISTS access_codes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT UNIQUE NOT NULL,          -- código que se tipea en el registro (mayúsculas)
  label       TEXT,                          -- nota para el dueño ("Amigos del bar", "Juan")
  active      BOOLEAN DEFAULT true,          -- desactivar frena nuevos registros con este código
  max_uses    INT,                           -- null = ilimitado
  uses        INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_access_codes_code ON access_codes(code);

-- Marca en el tenant qué código de cortesía usó (null = cuenta normal/paga).
ALTER TABLE IF EXISTS tenants ADD COLUMN IF NOT EXISTS access_code TEXT;

-- ============================================================
-- VISITAS A LA WEB (cuántas personas exploran la web)
-- Evento anónimo y liviano: solo un id de visitante generado en el navegador
-- (localStorage), sin datos personales. Sirve para medir tráfico en el panel.
-- ============================================================
CREATE TABLE IF NOT EXISTS site_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL,           -- 'visit' | 'demo'
  visitor_id  TEXT,                    -- id anónimo por navegador (no es PII)
  path        TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_events_created ON site_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_events_type ON site_events(type, created_at DESC);
