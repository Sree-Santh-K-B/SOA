'use strict';

const crypto = require('crypto');
const config = require('../config');
const { pool } = require('../db');
const { HttpError, h } = require('./errors');

const hashKey = (key) => crypto.createHash('sha256').update(key).digest('hex');

/** Keys are random 256-bit values, so a plain SHA-256 is enough; only the hash is stored. */
function generateApiKey() {
  const key = 'bk_' + crypto.randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, 10) };
}

function extractKey(req) {
  const auth = req.get('authorization');
  if (auth && /^bearer /i.test(auth)) return auth.slice(7).trim();
  return req.get('x-api-key') || null;
}

/** Resolve the API key to its merchant. Everything downstream is scoped to req.merchant.id. */
const authenticate = h(async (req, res, next) => {
  const key = extractKey(req);
  if (!key) throw new HttpError(401, 'unauthorized', 'Missing API key. Send "Authorization: Bearer <key>".');
  const { rows } = await pool.query(
    `SELECT m.*, k.id AS api_key_id
       FROM api_keys k JOIN merchants m ON m.id = k.merchant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
    [hashKey(key)]
  );
  if (!rows.length) throw new HttpError(401, 'unauthorized', 'Invalid or revoked API key');
  const { api_key_id: apiKeyId, ...merchant } = rows[0];
  req.merchant = merchant;
  req.apiKeyId = apiKeyId;
  pool.query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [apiKeyId]).catch(() => {});
  next();
});

/** Platform-level routes (merchant onboarding) use a separate admin token. */
function requireAdmin(req, res, next) {
  if (!config.adminToken) return next(new HttpError(503, 'admin_disabled', 'ADMIN_TOKEN is not configured'));
  const given = Buffer.from(req.get('x-admin-token') || '');
  const expected = Buffer.from(config.adminToken);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return next(new HttpError(401, 'unauthorized', 'Invalid admin token'));
  }
  next();
}

module.exports = { authenticate, requireAdmin, generateApiKey };
