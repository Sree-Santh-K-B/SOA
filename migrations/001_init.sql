-- Billing API schema.
-- All money columns are BIGINT in the currency's minor unit (paise, cents, yen).
-- Every tenant-owned table carries merchant_id and every query filters on it.

CREATE TABLE merchants (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  legal_name              TEXT,
  email                   TEXT,
  address                 JSONB NOT NULL DEFAULT '{}',
  country                 CHAR(2) NOT NULL DEFAULT 'IN',
  state_code              TEXT,                       -- e.g. "MH"; compared with place of supply for GST
  gstin                   TEXT,
  tax_id                  TEXT,                       -- VAT / EIN etc. for non-GST merchants
  base_currency           CHAR(3) NOT NULL DEFAULT 'INR',
  tax_mode                TEXT NOT NULL DEFAULT 'standard' CHECK (tax_mode IN ('none', 'standard', 'gst')),
  prices_include_tax      BOOLEAN NOT NULL DEFAULT FALSE,
  require_hsn             BOOLEAN NOT NULL DEFAULT FALSE,
  invoice_prefix          TEXT NOT NULL DEFAULT 'INV',
  credit_note_prefix      TEXT NOT NULL DEFAULT 'CN',
  fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id  UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  key_hash     TEXT NOT NULL UNIQUE,                  -- sha256 of the key; the key itself is never stored
  key_prefix   TEXT NOT NULL,
  label        TEXT,
  last_used_at TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_merchant_idx ON api_keys (merchant_id);

-- Gap-free document numbering: one counter per merchant / document type / fiscal period.
CREATE TABLE number_sequences (
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  doc_type    TEXT NOT NULL CHECK (doc_type IN ('invoice', 'credit_note')),
  period      TEXT NOT NULL,
  last_value  BIGINT NOT NULL,
  PRIMARY KEY (merchant_id, doc_type, period)
);

CREATE TABLE tax_rates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  rate        NUMERIC(6,3) NOT NULL CHECK (rate >= 0 AND rate <= 100),   -- percent
  hsn_code    TEXT,                                   -- when set, lines with this HSN use this rate
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tax_rates_merchant_hsn_key ON tax_rates (merchant_id, hsn_code) WHERE hsn_code IS NOT NULL AND active;
CREATE UNIQUE INDEX tax_rates_merchant_default_key ON tax_rates (merchant_id) WHERE is_default AND active;

CREATE TABLE coupons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
  value           NUMERIC(14,3) NOT NULL CHECK (value > 0),  -- percent, or minor units when fixed
  currency        CHAR(3),                                   -- required for fixed coupons
  max_redemptions INTEGER,
  times_redeemed  INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX coupons_merchant_code_key ON coupons (merchant_id, upper(code)) WHERE active;

-- 1 unit of `currency` = `rate` units of the merchant's base currency.
CREATE TABLE exchange_rates (
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  currency    CHAR(3) NOT NULL,
  rate        NUMERIC(20,10) NOT NULL CHECK (rate > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id, currency)
);

CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  number          TEXT NOT NULL,
  external_id     TEXT,                               -- caller's order id; makes creation idempotent
  status          TEXT NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'partially_paid', 'paid', 'credited', 'partially_refunded', 'refunded', 'void')),
  currency        CHAR(3) NOT NULL,
  exchange_rate   NUMERIC(20,10) NOT NULL DEFAULT 1,  -- to merchant base currency, frozen at issue time
  customer        JSONB NOT NULL,
  place_of_supply TEXT,
  intra_state     BOOLEAN NOT NULL DEFAULT TRUE,
  tax_inclusive   BOOLEAN NOT NULL DEFAULT FALSE,
  subtotal        BIGINT NOT NULL,
  discount_total  BIGINT NOT NULL DEFAULT 0,
  coupon_id       UUID REFERENCES coupons(id),
  coupon_code     TEXT,
  coupon_discount BIGINT NOT NULL DEFAULT 0,
  tax_total       BIGINT NOT NULL DEFAULT 0,
  tax_summary     JSONB NOT NULL DEFAULT '[]',
  total           BIGINT NOT NULL,
  base_total      BIGINT NOT NULL,                    -- total converted to base currency
  amount_paid     BIGINT NOT NULL DEFAULT 0,
  amount_credited BIGINT NOT NULL DEFAULT 0,          -- adjustment credit notes (reduce amount due)
  amount_refunded BIGINT NOT NULL DEFAULT 0,
  tax_reversed    BIGINT NOT NULL DEFAULT 0,          -- tax already reversed by refunds + credit notes
  notes           TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}',
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date        DATE,
  paid_at         TIMESTAMPTZ,
  voided_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT invoices_merchant_number_key UNIQUE (merchant_id, number),
  CONSTRAINT invoices_merchant_external_id_key UNIQUE (merchant_id, external_id),
  CHECK (amount_refunded <= amount_paid),
  CHECK (amount_paid + amount_credited <= total)
);
CREATE INDEX invoices_merchant_created_idx ON invoices (merchant_id, created_at DESC);

CREATE TABLE invoice_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  description     TEXT NOT NULL,
  sku             TEXT,
  hsn_code        TEXT,
  quantity        NUMERIC(14,3) NOT NULL,
  unit_amount     BIGINT NOT NULL,
  discount_amount BIGINT NOT NULL DEFAULT 0,          -- line discount + this line's share of the coupon
  taxable_amount  BIGINT NOT NULL,
  tax_rate        NUMERIC(6,3) NOT NULL DEFAULT 0,
  tax_amount      BIGINT NOT NULL DEFAULT 0,
  tax_components  JSONB NOT NULL DEFAULT '[]',        -- [{name:"CGST", rate:9, amount:900}, ...]
  total           BIGINT NOT NULL
);
CREATE INDEX invoice_items_invoice_idx ON invoice_items (invoice_id, position);

CREATE TABLE payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  invoice_id  UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  amount      BIGINT NOT NULL CHECK (amount > 0),
  method      TEXT,
  reference   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_invoice_idx ON payments (invoice_id);

CREATE TABLE credit_notes (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  number         TEXT NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('refund', 'adjustment')),
  currency       CHAR(3) NOT NULL,
  amount         BIGINT NOT NULL CHECK (amount > 0),
  taxable_amount BIGINT NOT NULL,
  tax_amount     BIGINT NOT NULL,
  tax_components JSONB NOT NULL DEFAULT '[]',
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_notes_merchant_number_key UNIQUE (merchant_id, number)
);
CREATE INDEX credit_notes_invoice_idx ON credit_notes (invoice_id);

CREATE TABLE refunds (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  invoice_id     UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES credit_notes(id),
  external_id    TEXT,                                -- caller's refund id; makes refunds idempotent
  amount         BIGINT NOT NULL CHECK (amount > 0),
  tax_amount     BIGINT NOT NULL,
  reason         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT refunds_merchant_external_id_key UNIQUE (merchant_id, external_id)
);
CREATE INDEX refunds_invoice_idx ON refunds (invoice_id);

CREATE TABLE webhook_endpoints (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT[] NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_endpoints_merchant_idx ON webhook_endpoints (merchant_id);

-- Outbox: rows are inserted in the same transaction as the business change,
-- then delivered (with retries) by the background worker.
CREATE TABLE webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  endpoint_id     UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_status INTEGER,
  last_error      TEXT,
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_deliveries_merchant_idx ON webhook_deliveries (merchant_id, created_at DESC);
