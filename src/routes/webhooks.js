'use strict';

const crypto = require('crypto');
const express = require('express');
const { pool } = require('../db');
const { h, uuidParam, HttpError } = require('../middleware/errors');
const { schemas, parse } = require('../lib/validation');
const { assertSafeUrl } = require('../services/webhooks');

const router = express.Router();
router.param('id', uuidParam);

router.post('/webhook-endpoints', h(async (req, res) => {
  const input = parse(schemas.webhookEndpointCreate, req.body);
  await assertSafeUrl(input.url);
  const secret = 'whsec_' + crypto.randomBytes(24).toString('base64url');
  const { rows } = await pool.query(
    'INSERT INTO webhook_endpoints (merchant_id, url, secret, events) VALUES ($1, $2, $3, $4) RETURNING id, url, events, active, created_at',
    [req.merchant.id, input.url, secret, [...new Set(input.events)]]
  );
  res.status(201).json({ ...rows[0], secret }); // the signing secret is shown once, here
}));

router.get('/webhook-endpoints', h(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE merchant_id = $1 AND active ORDER BY created_at',
    [req.merchant.id]
  );
  res.json({ data: rows });
}));

router.delete('/webhook-endpoints/:id', h(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE webhook_endpoints SET active = FALSE WHERE id = $1 AND merchant_id = $2 AND active', [req.params.id, req.merchant.id]);
  if (!rowCount) throw new HttpError(404, 'not_found', 'Webhook endpoint not found');
  res.status(204).end();
}));

// Delivery log, for debugging integrations.
router.get('/webhook-deliveries', h(async (req, res) => {
  const { limit, offset, status } = parse(schemas.listQuery, req.query);
  const params = [req.merchant.id, limit + 1, offset];
  const filter = status ? `AND status = $${params.push(status)}` : '';
  const { rows } = await pool.query(
    `SELECT id, endpoint_id, event_id, event_type, status, attempts, next_attempt_at, response_status, last_error, delivered_at, created_at
       FROM webhook_deliveries WHERE merchant_id = $1 ${filter}
      ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`,
    params
  );
  res.json({ data: rows.slice(0, limit), has_more: rows.length > limit });
}));

module.exports = router;
