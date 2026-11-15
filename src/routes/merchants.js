'use strict';

const express = require('express');
const { pool, withTransaction } = require('../db');
const { h, uuidParam, HttpError } = require('../middleware/errors');
const { requireAdmin, generateApiKey } = require('../middleware/auth');
const { schemas, parse } = require('../lib/validation');

const FIELDS = [
  'name', 'legal_name', 'email', 'address', 'country', 'state_code', 'gstin', 'tax_id', 'base_currency', 'tax_mode',
  'prices_include_tax', 'require_hsn', 'invoice_prefix', 'credit_note_prefix', 'fiscal_year_start_month',
];
const dbValue = (field, value) => (field === 'address' ? JSON.stringify(value) : value);

async function insertApiKey(db, merchantId, label) {
  const { key, hash, prefix } = generateApiKey();
  const { rows } = await db.query(
    'INSERT INTO api_keys (merchant_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4) RETURNING id, key_prefix, label, created_at',
    [merchantId, hash, prefix, label ?? null]
  );
  return { ...rows[0], key }; // the only time the full key is ever returned
}

// ----- platform admin: onboard a merchant -----
const admin = express.Router();

admin.post('/merchants', requireAdmin, h(async (req, res) => {
  const input = parse(schemas.merchantCreate, req.body);
  const fields = FIELDS.filter((f) => input[f] !== undefined); // unset fields take the column defaults
  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO merchants (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      fields.map((f) => dbValue(f, input[f]))
    );
    const apiKey = await insertApiKey(client, rows[0].id, 'default');
    return { merchant: rows[0], api_key: apiKey.key };
  });
  res.status(201).json(result);
}));

// ----- merchant self-service (API key auth) -----
const router = express.Router();
router.param('id', uuidParam);

router.get('/merchant', (req, res) => res.json(req.merchant));

router.patch('/merchant', h(async (req, res) => {
  const input = parse(schemas.merchantUpdate, req.body);
  const fields = FIELDS.filter((f) => input[f] !== undefined);
  if (!fields.length) return res.json(req.merchant);
  const { rows } = await pool.query(
    `UPDATE merchants SET ${fields.map((f, i) => `${f} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
    [req.merchant.id, ...fields.map((f) => dbValue(f, input[f]))]
  );
  res.json(rows[0]);
}));

router.get('/api-keys', h(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, key_prefix, label, last_used_at, revoked_at, created_at FROM api_keys WHERE merchant_id = $1 ORDER BY created_at',
    [req.merchant.id]
  );
  res.json({ data: rows });
}));

router.post('/api-keys', h(async (req, res) => {
  const { label } = parse(schemas.apiKeyCreate, req.body);
  res.status(201).json(await insertApiKey(pool, req.merchant.id, label));
}));

router.delete('/api-keys/:id', h(async (req, res) => {
  if (req.params.id === req.apiKeyId) throw new HttpError(422, 'key_in_use', 'Cannot revoke the key used for this request');
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND merchant_id = $2 AND revoked_at IS NULL',
    [req.params.id, req.merchant.id]
  );
  if (!rowCount) throw new HttpError(404, 'not_found', 'API key not found');
  res.status(204).end();
}));

module.exports = { admin, router };
