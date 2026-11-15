'use strict';

const { pool, withTransaction } = require('../db');
const { HttpError } = require('../middleware/errors');
const { calculateInvoice, resolveSupply } = require('../lib/tax');
const { computeRefund, computeCreditNote, deriveStatus } = require('../lib/refunds');
const { nextNumber } = require('../lib/numbering');
const { convert } = require('../lib/money');
const { enqueueEvent } = require('./webhooks');

// ---------- serialisation ----------

function serializeInvoice(row, items) {
  const { merchant_id, coupon_id, ...rest } = row;
  const out = { ...rest, amount_due: Math.max(0, row.total - row.amount_paid - row.amount_credited) };
  if (items) out.line_items = items.map(({ merchant_id: _m, invoice_id: _i, ...item }) => item);
  return out;
}

const strip = ({ merchant_id, ...rest }) => rest;

async function getInvoice(db, merchantId, id) {
  const { rows } = await db.query('SELECT * FROM invoices WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
  if (!rows.length) throw new HttpError(404, 'not_found', 'Invoice not found');
  const items = await db.query('SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position', [id]);
  return serializeInvoice(rows[0], items.rows);
}

async function findByExternalId(db, merchantId, externalId) {
  const { rows } = await db.query('SELECT id FROM invoices WHERE merchant_id = $1 AND external_id = $2', [merchantId, externalId]);
  return rows.length ? getInvoice(db, merchantId, rows[0].id) : null;
}

async function listInvoices(merchantId, { limit, offset, status, external_id: externalId }) {
  const where = ['merchant_id = $1'];
  const params = [merchantId];
  if (status) where.push(`status = $${params.push(status)}`);
  if (externalId) where.push(`external_id = $${params.push(externalId)}`);
  params.push(limit + 1, offset);
  const { rows } = await pool.query(
    `SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { data: rows.slice(0, limit).map((r) => serializeInvoice(r)), has_more: rows.length > limit };
}

/** Lock the invoice row so concurrent payments/refunds on it are serialised. */
async function lockInvoice(client, merchantId, id) {
  const { rows } = await client.query('SELECT * FROM invoices WHERE id = $1 AND merchant_id = $2 FOR UPDATE', [id, merchantId]);
  if (!rows.length) throw new HttpError(404, 'not_found', 'Invoice not found');
  return rows[0];
}

// ---------- creation ----------

async function resolveExchangeRate(client, merchant, currency, given) {
  if (currency === merchant.base_currency) return 1;
  if (given) return given;
  const { rows } = await client.query('SELECT rate FROM exchange_rates WHERE merchant_id = $1 AND currency = $2', [merchant.id, currency]);
  if (!rows.length) {
    throw new HttpError(422, 'exchange_rate_missing', `No exchange rate for ${currency}. Pass exchange_rate or set one via PUT /v1/exchange-rates.`);
  }
  return rows[0].rate;
}

/** Tax rate per line: explicit tax_rate > tax_rate_id > rate mapped to the HSN code > merchant default > 0. */
async function resolveLines(client, merchant, lineItems) {
  const { rows: rates } = await client.query('SELECT * FROM tax_rates WHERE merchant_id = $1 AND active', [merchant.id]);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const byHsn = new Map(rates.filter((r) => r.hsn_code).map((r) => [r.hsn_code, r]));
  const fallback = rates.find((r) => r.is_default);

  return lineItems.map((item, idx) => {
    if (merchant.tax_mode === 'gst' && merchant.require_hsn && !item.hsn_code) {
      throw new HttpError(422, 'hsn_required', `Line ${idx + 1}: hsn_code is required for this merchant`);
    }
    const { tax_rate_id: rateId, ...line } = item;
    if (line.tax_rate !== undefined) return line;
    let rate;
    if (rateId) {
      rate = byId.get(rateId);
      if (!rate) throw new HttpError(422, 'tax_rate_not_found', `Line ${idx + 1}: unknown tax_rate_id`);
    } else {
      rate = (line.hsn_code && byHsn.get(line.hsn_code)) || fallback;
    }
    return rate ? { ...line, tax_rate: rate.rate, tax_name: rate.name } : { ...line, tax_rate: 0 };
  });
}

async function redeemCoupon(client, merchantId, code, currency) {
  const { rows } = await client.query(
    'SELECT * FROM coupons WHERE merchant_id = $1 AND upper(code) = upper($2) AND active FOR UPDATE',
    [merchantId, code]
  );
  const coupon = rows[0];
  if (!coupon) throw new HttpError(422, 'coupon_invalid', 'Coupon not found');
  if (coupon.expires_at && new Date(coupon.expires_at) <= new Date()) throw new HttpError(422, 'coupon_expired', 'Coupon has expired');
  if (coupon.max_redemptions !== null && coupon.times_redeemed >= coupon.max_redemptions) {
    throw new HttpError(422, 'coupon_exhausted', 'Coupon has reached its redemption limit');
  }
  if (coupon.type === 'fixed' && coupon.currency !== currency) {
    throw new HttpError(422, 'coupon_currency_mismatch', `Coupon is only valid for ${coupon.currency} invoices`);
  }
  await client.query('UPDATE coupons SET times_redeemed = times_redeemed + 1 WHERE id = $1', [coupon.id]);
  return coupon;
}

/** Apply a payment to a locked invoice row. Returns the updated row. */
async function applyPayment(client, inv, { amount, method, reference }) {
  if (inv.status === 'void') throw new HttpError(422, 'invoice_void', 'Invoice is void');
  const due = inv.total - inv.amount_paid - inv.amount_credited;
  if (due <= 0 && inv.total > 0) throw new HttpError(422, 'already_paid', 'Invoice has nothing left to pay');
  const amt = amount ?? due;
  if (amt > due) throw new HttpError(422, 'amount_too_large', `amount ${amt} exceeds the amount due ${due}`);
  if (amt > 0) {
    await client.query(
      'INSERT INTO payments (merchant_id, invoice_id, amount, method, reference) VALUES ($1, $2, $3, $4, $5)',
      [inv.merchant_id, inv.id, amt, method ?? null, reference ?? null]
    );
  }
  const amountPaid = inv.amount_paid + amt;
  const status = deriveStatus({ ...inv, amount_paid: amountPaid });
  const { rows } = await client.query(
    `UPDATE invoices SET amount_paid = $2, status = $3, paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END
      WHERE id = $1 RETURNING *`,
    [inv.id, amountPaid, status]
  );
  return rows[0];
}

async function createInvoiceTx(client, merchant, input) {
  if (input.external_id) {
    const existing = await findByExternalId(client, merchant.id, input.external_id);
    if (existing) return { invoice: existing, created: false };
  }

  const currency = input.currency || merchant.base_currency;
  const exchangeRate = await resolveExchangeRate(client, merchant, currency, input.exchange_rate);
  const { placeOfSupply, intraState } = resolveSupply({
    merchantCountry: merchant.country,
    merchantState: merchant.state_code,
    customerCountry: input.customer.country,
    customerState: input.customer.state,
    placeOfSupply: input.place_of_supply,
  });
  const taxInclusive = input.tax_inclusive ?? merchant.prices_include_tax;
  const lines = await resolveLines(client, merchant, input.line_items);
  const coupon = input.coupon_code ? await redeemCoupon(client, merchant.id, input.coupon_code, currency) : null;

  const calc = calculateInvoice({ lines, taxMode: merchant.tax_mode, intraState, taxInclusive, coupon });
  const number = await nextNumber(client, merchant, 'invoice');

  const { rows } = await client.query(
    `INSERT INTO invoices (merchant_id, number, external_id, currency, exchange_rate, customer, place_of_supply,
                           intra_state, tax_inclusive, subtotal, discount_total, coupon_id, coupon_code, coupon_discount,
                           tax_total, tax_summary, total, base_total, notes, metadata, due_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [
      merchant.id, number, input.external_id ?? null, currency, exchangeRate, JSON.stringify(input.customer), placeOfSupply,
      intraState, taxInclusive, calc.subtotal, calc.discount_total, coupon?.id ?? null, coupon?.code ?? null, calc.coupon_discount,
      calc.tax_total, JSON.stringify(calc.tax_summary), calc.total, convert(calc.total, currency, merchant.base_currency, exchangeRate),
      input.notes ?? null, JSON.stringify(input.metadata ?? {}), input.due_date ?? null,
    ]
  );
  let row = rows[0];

  for (const [i, l] of calc.lines.entries()) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, merchant_id, position, description, sku, hsn_code, quantity, unit_amount,
                                  discount_amount, taxable_amount, tax_rate, tax_amount, tax_components, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [row.id, merchant.id, i + 1, l.description, l.sku ?? null, l.hsn_code ?? null, l.quantity, l.unit_amount,
        l.discount_amount, l.taxable_amount, l.tax_rate, l.tax_amount, JSON.stringify(l.tax_components), l.total]
    );
  }

  // Paid at checkout, or nothing to pay (100% discount): settle immediately.
  if (input.payment || calc.total === 0) row = await applyPayment(client, row, input.payment || {});

  const invoice = await getInvoice(client, merchant.id, row.id);
  await enqueueEvent(client, merchant.id, 'invoice.created', { invoice });
  if (invoice.status === 'paid') await enqueueEvent(client, merchant.id, 'invoice.paid', { invoice });
  return { invoice, created: true };
}

async function createInvoice(merchant, input) {
  try {
    return await withTransaction((client) => createInvoiceTx(client, merchant, input));
  } catch (err) {
    // Two concurrent requests for the same order: the loser returns the winner's invoice.
    if (err.code === '23505' && err.constraint === 'invoices_merchant_external_id_key') {
      const existing = await findByExternalId(pool, merchant.id, input.external_id);
      if (existing) return { invoice: existing, created: false };
    }
    throw err;
  }
}

// ---------- payments, voiding ----------

function payInvoice(merchant, id, input) {
  return withTransaction(async (client) => {
    const inv = await lockInvoice(client, merchant.id, id);
    const row = await applyPayment(client, inv, input);
    const invoice = await getInvoice(client, merchant.id, id);
    if (row.status === 'paid') await enqueueEvent(client, merchant.id, 'invoice.paid', { invoice });
    return invoice;
  });
}

function voidInvoice(merchant, id) {
  return withTransaction(async (client) => {
    const inv = await lockInvoice(client, merchant.id, id);
    if (inv.status === 'void') return getInvoice(client, merchant.id, id);
    if (inv.amount_paid > 0) throw new HttpError(422, 'invoice_has_payments', 'Paid invoices cannot be voided; issue a refund instead');
    await client.query(`UPDATE invoices SET status = 'void', voided_at = now() WHERE id = $1`, [id]);
    return getInvoice(client, merchant.id, id);
  });
}

// ---------- refunds and credit notes ----------

async function insertCreditNote(client, merchant, inv, type, calc, reason) {
  const number = await nextNumber(client, merchant, 'credit_note');
  const { rows } = await client.query(
    `INSERT INTO credit_notes (merchant_id, invoice_id, number, type, currency, amount, taxable_amount, tax_amount, tax_components, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [merchant.id, inv.id, number, type, inv.currency, calc.amount, calc.taxable_amount, calc.tax_amount, JSON.stringify(calc.tax_components), reason ?? null]
  );
  return rows[0];
}

/**
 * Full or partial refund. Records the refund, issues the matching credit note
 * (so the tax reversal is documented) and emits refund.issued. This is the
 * bookkeeping side only - moving the money is the payment gateway's job.
 */
function refundInvoice(merchant, id, input) {
  return withTransaction(async (client) => {
    const inv = await lockInvoice(client, merchant.id, id);

    if (input.external_id) {
      const dup = await client.query(
        `SELECT r.*, row_to_json(c) AS credit_note FROM refunds r JOIN credit_notes c ON c.id = r.credit_note_id
          WHERE r.merchant_id = $1 AND r.external_id = $2`,
        [merchant.id, input.external_id]
      );
      if (dup.rows.length) {
        const { credit_note: cn, ...refund } = dup.rows[0];
        return { refund: { ...strip(refund), credit_note: strip(cn) }, created: false };
      }
    }

    const calc = computeRefund(inv, input.amount);
    const creditNote = await insertCreditNote(client, merchant, inv, 'refund', calc, input.reason);
    const { rows } = await client.query(
      `INSERT INTO refunds (merchant_id, invoice_id, credit_note_id, external_id, amount, tax_amount, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [merchant.id, id, creditNote.id, input.external_id ?? null, calc.amount, calc.tax_amount, input.reason ?? null]
    );
    const amountRefunded = inv.amount_refunded + calc.amount;
    await client.query('UPDATE invoices SET amount_refunded = $2, tax_reversed = $3, status = $4 WHERE id = $1', [
      id, amountRefunded, inv.tax_reversed + calc.tax_amount, deriveStatus({ ...inv, amount_refunded: amountRefunded }),
    ]);

    const refund = { ...strip(rows[0]), credit_note: strip(creditNote) };
    const invoice = await getInvoice(client, merchant.id, id);
    await enqueueEvent(client, merchant.id, 'refund.issued', { refund, invoice });
    return { refund, created: true };
  });
}

/** Adjustment credit note against the unpaid balance of an invoice. */
function creditInvoice(merchant, id, input) {
  return withTransaction(async (client) => {
    const inv = await lockInvoice(client, merchant.id, id);
    const calc = computeCreditNote(inv, input.amount);
    const creditNote = await insertCreditNote(client, merchant, inv, 'adjustment', calc, input.reason);
    const amountCredited = inv.amount_credited + calc.amount;
    const status = deriveStatus({ ...inv, amount_credited: amountCredited });
    await client.query(
      `UPDATE invoices SET amount_credited = $2, tax_reversed = $3, status = $4,
              paid_at = CASE WHEN $4 = 'paid' THEN now() ELSE paid_at END WHERE id = $1`,
      [id, amountCredited, inv.tax_reversed + calc.tax_amount, status]
    );
    if (status === 'paid') {
      await enqueueEvent(client, merchant.id, 'invoice.paid', { invoice: await getInvoice(client, merchant.id, id) });
    }
    return strip(creditNote);
  });
}

async function listRefunds(merchantId, invoiceId) {
  await getInvoice(pool, merchantId, invoiceId);
  const { rows } = await pool.query('SELECT * FROM refunds WHERE merchant_id = $1 AND invoice_id = $2 ORDER BY created_at', [merchantId, invoiceId]);
  return rows.map(strip);
}

async function listCreditNotes(merchantId, { limit, offset }) {
  const { rows } = await pool.query(
    'SELECT * FROM credit_notes WHERE merchant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3',
    [merchantId, limit + 1, offset]
  );
  return { data: rows.slice(0, limit).map(strip), has_more: rows.length > limit };
}

async function getCreditNote(merchantId, id) {
  const { rows } = await pool.query('SELECT * FROM credit_notes WHERE id = $1 AND merchant_id = $2', [id, merchantId]);
  if (!rows.length) throw new HttpError(404, 'not_found', 'Credit note not found');
  return strip(rows[0]);
}

module.exports = {
  createInvoice, getInvoice, listInvoices, payInvoice, voidInvoice,
  refundInvoice, creditInvoice, listRefunds, listCreditNotes, getCreditNote,
};
