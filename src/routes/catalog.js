'use strict';

// Tax rates, coupons and exchange rates: the merchant's pricing configuration.

const express = require('express');
const { pool, withTransaction } = require('../db');
const { h, uuidParam, HttpError } = require('../middleware/errors');
const { schemas, parse } = require('../lib/validation');

const router = express.Router();
router.param('id', uuidParam);
const strip = ({ merchant_id, ...rest }) => rest;

// ----- tax rates -----

router.get('/tax-rates', h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM tax_rates WHERE merchant_id = $1 AND active ORDER BY created_at', [req.merchant.id]);
  res.json({ data: rows.map(strip) });
}));

router.post('/tax-rates', h(async (req, res) => {
  const input = parse(schemas.taxRateCreate, req.body);
  const row = await withTransaction(async (client) => {
    if (input.is_default) await client.query('UPDATE tax_rates SET is_default = FALSE WHERE merchant_id = $1 AND is_default', [req.merchant.id]);
    const { rows } = await client.query(
      'INSERT INTO tax_rates (merchant_id, name, rate, hsn_code, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [req.merchant.id, input.name, input.rate, input.hsn_code ?? null, input.is_default ?? false]
    );
    return rows[0];
  });
  res.status(201).json(strip(row));
}));

router.delete('/tax-rates/:id', h(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE tax_rates SET active = FALSE WHERE id = $1 AND merchant_id = $2 AND active', [req.params.id, req.merchant.id]);
  if (!rowCount) throw new HttpError(404, 'not_found', 'Tax rate not found');
  res.status(204).end();
}));

// ----- coupons -----

router.get('/coupons', h(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM coupons WHERE merchant_id = $1 AND active ORDER BY created_at', [req.merchant.id]);
  res.json({ data: rows.map(strip) });
}));

router.post('/coupons', h(async (req, res) => {
  const input = parse(schemas.couponCreate, req.body);
  const { rows } = await pool.query(
    `INSERT INTO coupons (merchant_id, code, type, value, currency, max_redemptions, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [req.merchant.id, input.code, input.type, input.value, input.currency ?? null, input.max_redemptions ?? null, input.expires_at ?? null]
  );
  res.status(201).json(strip(rows[0]));
}));

router.delete('/coupons/:id', h(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE coupons SET active = FALSE WHERE id = $1 AND merchant_id = $2 AND active', [req.params.id, req.merchant.id]);
  if (!rowCount) throw new HttpError(404, 'not_found', 'Coupon not found');
  res.status(204).end();
}));

// ----- exchange rates -----

router.get('/exchange-rates', h(async (req, res) => {
  const { rows } = await pool.query('SELECT currency, rate, updated_at FROM exchange_rates WHERE merchant_id = $1 ORDER BY currency', [req.merchant.id]);
  res.json({ base_currency: req.merchant.base_currency, data: rows });
}));

router.put('/exchange-rates', h(async (req, res) => {
  const input = parse(schemas.exchangeRatePut, req.body);
  if (input.currency === req.merchant.base_currency) throw new HttpError(422, 'invalid_currency', 'Cannot set a rate for the base currency');
  const { rows } = await pool.query(
    `INSERT INTO exchange_rates (merchant_id, currency, rate) VALUES ($1, $2, $3)
     ON CONFLICT (merchant_id, currency) DO UPDATE SET rate = EXCLUDED.rate, updated_at = now()
     RETURNING currency, rate, updated_at`,
    [req.merchant.id, input.currency, input.rate]
  );
  res.json(rows[0]);
}));

module.exports = router;
