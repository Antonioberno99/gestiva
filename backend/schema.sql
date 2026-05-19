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
  color      TEXT DEFAULT '#f97316',
  access_pin_hash TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE IF EXISTS waiters ADD COLUMN IF NOT EXISTS access_pin_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_waiters_tenant ON waiters(tenant_id);

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
