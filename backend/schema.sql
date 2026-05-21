-- ============================================================
-- Gestiva SaaS — Multi-tenant schema
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

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
