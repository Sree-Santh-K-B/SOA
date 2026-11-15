# Billing API

Multi-tenant billing API for ecommerce stores. Node.js (Express) + PostgreSQL.

- Invoices with gap-free automatic numbering, line items and PDF output
- Tax: configurable rates, HSN-mapped rates, Indian GST (CGST/SGST vs IGST), tax-inclusive or exclusive pricing
- Line discounts, coupons (percent / fixed), credit notes
- Full and partial refunds with proportional tax reversal
- Multi-currency with a frozen exchange rate per invoice
- Signed, retried webhooks: `invoice.created`, `invoice.paid`, `refund.issued`
- One API key per merchant; every row is scoped to its merchant
- OpenAPI docs at `/docs`, WooCommerce plugin in `woocommerce-plugin/`

## Run it

```bash
docker compose up --build        # API on http://localhost:3000, docs on /docs
```

Without Docker: Node 20+, a PostgreSQL 13+ database, then

```bash
cp .env.example .env             # export these variables in your shell
npm install
npm run migrate && npm start
npm test                         # unit tests, no database needed
```

## Five-minute tour

```bash
API=http://localhost:3000

# 1. Onboard a merchant (platform admin). The API key is shown once.
curl -s $API/v1/merchants -H "X-Admin-Token: change-me-admin-token" -H 'Content-Type: application/json' -d '{
  "name": "Acme Store", "country": "IN", "state_code": "MH", "gstin": "27AAPFU0939F1ZV",
  "base_currency": "INR", "tax_mode": "gst", "fiscal_year_start_month": 4
}'
KEY=bk_...   # api_key from the response

# 2. Optional configuration: an HSN-mapped rate, a coupon, a webhook, an exchange rate
curl -s $API/v1/tax-rates -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"name": "GST 18%", "rate": 18, "hsn_code": "847160"}'
curl -s $API/v1/coupons -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"code": "WELCOME10", "type": "percent", "value": 10}'
curl -s $API/v1/webhook-endpoints -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"url": "https://shop.example.com/hooks/billing", "events": ["*"]}'
curl -s -X PUT $API/v1/exchange-rates -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"currency": "USD", "rate": 83.5}'

# 3. Create an invoice. Amounts are in minor units (450000 = Rs 4,500.00).
curl -s $API/v1/invoices -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{
  "external_id": "order-1001",
  "customer": {"name": "Priya Sharma", "email": "priya@example.com", "state": "KA", "country": "IN"},
  "line_items": [{"description": "Mechanical keyboard", "hsn_code": "847160", "quantity": 1, "unit_amount": 450000}],
  "coupon_code": "WELCOME10"
}'
ID=...       # id from the response

curl -s -X POST $API/v1/invoices/$ID/pay -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"method": "upi"}'
curl -s -o invoice.pdf $API/v1/invoices/$ID/pdf -H "Authorization: Bearer $KEY"
curl -s -X POST $API/v1/invoices/$ID/refunds -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"amount": 100000, "reason": "Damaged keycap"}'
```

## How it works

**Tenancy.** `api_keys.key_hash` (SHA-256 of the key) resolves to a merchant in `middleware/auth.js`;
every query filters on `merchant_id`. Merchants are created with the platform `ADMIN_TOKEN`.

**Money.** Integer minor units everywhere (BIGINT in Postgres), BigInt arithmetic for
multiply-then-divide, half-up rounding per line. Zero- and three-decimal currencies are handled.

**Tax** (`src/lib/tax.js`, pure). Rate per line: `tax_rate` > `tax_rate_id` > merchant rate mapped to
the line's HSN code > merchant default > 0. Discounts and coupons always reduce the taxable value.
In `gst` mode the place of supply (explicit, else customer state) is compared with the merchant's
state: same state gives CGST + SGST (each half rounded separately so they are always equal),
otherwise IGST. Use the same state-code scheme on both sides (e.g. `MH`, `KA`).

**Numbering.** One counter row per merchant, document type and fiscal period, incremented inside the
invoice transaction: concurrent requests queue on the row lock and a rollback returns the number, so
there are no gaps. Format `INV-2627-000001` (16 characters at most, as GST requires).

**Refunds** (`src/lib/refunds.js`, pure). A refund is a tax-inclusive amount up to what was paid and not
yet refunded. Tax is reversed proportionally; the refund that brings the invoice to zero takes the
remaining tax, so partial refunds always add up to exactly the invoice's tax. Each refund issues a
credit note. Adjustment credit notes (`POST /invoices/:id/credit-notes`) reduce the unpaid balance instead.

**Idempotency.** `external_id` on invoices and refunds is unique per merchant; a repeat returns the
original with `200`.

**Webhooks.** Events are written to `webhook_deliveries` in the same transaction as the change
(outbox), then delivered by a poller using `FOR UPDATE SKIP LOCKED`, so several API instances can run.
Up to 6 attempts (1m, 5m, 30m, 2h, 6h backoff). Verify a delivery like this:

```js
const [t, v1] = req.get('X-Billing-Signature').split(',').map((p) => p.split('=')[1]);
const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) && Math.abs(Date.now() / 1000 - t) < 300;
```

## WooCommerce plugin

Copy `woocommerce-plugin/billing-api-invoices` into `wp-content/plugins`, activate it, then set the
API URL and key under **WooCommerce > Settings > Advanced > Billing API**.

- Order reaches Processing/Completed: invoice created (`external_id = woo-<order id>`), marked paid if the order is paid.
- Customer emails (processing, completed, invoice): the PDF is downloaded and attached. An API failure never blocks the email.
- Refund created in WooCommerce: recorded via `POST /invoices/:id/refunds`, credit note number added as an order note.
- Products get an **HSN/SAC code** field (General tab); line discounts carry WooCommerce coupon amounts.
- `billing_api_invoice_payload` filter lets you adjust the payload (e.g. add `exchange_rate`).

The API recalculates tax from the rates WooCommerce applied. If the invoice total differs from the
order total (per-line vs per-order rounding, negative fees), the plugin says so in an order note.

## Not in this MVP

- No payment processing: payments and refunds are records; the gateway moves the money.
- No rate limiting, no customer or product catalogue, no draft/edit flow (invoices are final when created).
- No PDF for credit notes; PDFs use built-in fonts, so amounts show currency codes and non-Latin text will not render.
- GST: no export/SEZ zero-rating, cess, reverse charge, or e-invoicing (IRN).
- Webhook SSRF protection resolves the host before sending but does not pin the IP; put egress rules in front for production.
- Tenant isolation is enforced in the query layer; Postgres row-level security would be a sensible second layer.
