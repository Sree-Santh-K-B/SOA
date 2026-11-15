'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const config = require('../config');
const { pool } = require('../db');
const { HttpError } = require('../middleware/errors');

const MAX_ATTEMPTS = 6;
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600]; // after attempt 1..5

const blocked = new net.BlockList();
for (const [addr, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]]) {
  blocked.addSubnet(addr, bits, 'ipv4');
}
for (const [addr, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]]) blocked.addSubnet(addr, bits, 'ipv6');

function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  return blocked.check(ip, net.isIPv4(ip) ? 'ipv4' : 'ipv6');
}

/**
 * Webhook URLs are merchant-supplied, so they must not point the server at
 * its own network (SSRF). Checked on registration and again before each send.
 */
async function assertSafeUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'invalid_url', 'Webhook URL is not valid');
  }
  if (config.webhookAllowPrivate) {
    if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'invalid_url', 'Webhook URL must be http(s)');
    return;
  }
  if (url.protocol !== 'https:') throw new HttpError(400, 'invalid_url', 'Webhook URL must use https');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    throw new HttpError(400, 'invalid_url', 'Webhook host does not resolve');
  }
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new HttpError(400, 'invalid_url', 'Webhook URL resolves to a private address');
  }
}

/**
 * Queue an event for every subscribed endpoint of the merchant. Called with
 * the transaction's client, so the event exists if and only if the change commits.
 */
async function enqueueEvent(client, merchantId, type, data) {
  const event = { id: crypto.randomUUID(), type, created_at: new Date().toISOString(), data };
  await client.query(
    `INSERT INTO webhook_deliveries (merchant_id, endpoint_id, event_id, event_type, payload)
     SELECT merchant_id, id, $2::uuid, $3::text, $4::jsonb
       FROM webhook_endpoints
      WHERE merchant_id = $1 AND active AND ($3::text = ANY(events) OR '*' = ANY(events))`,
    [merchantId, event.id, type, JSON.stringify(event)]
  );
}

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function deliver(job) {
  const body = JSON.stringify(job.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  let status = null;
  let error = null;
  try {
    await assertSafeUrl(job.url);
    const res = await fetch(job.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'billing-api-webhooks/1',
        'x-billing-event': job.event_type,
        'x-billing-delivery': job.id,
        'x-billing-signature': `t=${timestamp},v1=${sign(job.secret, timestamp, body)}`,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.webhookTimeoutMs),
    });
    status = res.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (err) {
    error = String(err.message || err).slice(0, 500);
  }

  if (!error) {
    await pool.query(
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = now(), response_status = $2, last_error = NULL WHERE id = $1`,
      [job.id, status]
    );
  } else if (job.attempts >= MAX_ATTEMPTS) {
    await pool.query(`UPDATE webhook_deliveries SET status = 'failed', response_status = $2, last_error = $3 WHERE id = $1`, [job.id, status, error]);
  } else {
    await pool.query(
      `UPDATE webhook_deliveries SET response_status = $2, last_error = $3, next_attempt_at = now() + make_interval(secs => $4) WHERE id = $1`,
      [job.id, status, error, BACKOFF_SECONDS[job.attempts - 1]]
    );
  }
}

/**
 * Claim due deliveries. SKIP LOCKED lets several API instances run workers
 * side by side; pushing next_attempt_at forward acts as a lease so a crashed
 * worker's jobs are picked up again later.
 */
async function processBatch() {
  const { rows } = await pool.query(
    `UPDATE webhook_deliveries d
        SET attempts = d.attempts + 1, next_attempt_at = now() + interval '5 minutes'
       FROM webhook_endpoints e
      WHERE e.id = d.endpoint_id
        AND d.id IN (SELECT id FROM webhook_deliveries
                      WHERE status = 'pending' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at LIMIT 20
                      FOR UPDATE SKIP LOCKED)
  RETURNING d.id, d.event_type, d.payload, d.attempts, e.url, e.secret`
  );
  await Promise.all(rows.map((job) => deliver(job).catch((err) => console.error('webhook delivery error', err))));
  return rows.length;
}

function startWorker() {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      while ((await processBatch()) === 20);
    } catch (err) {
      console.error('webhook worker error', err.message);
    } finally {
      running = false;
    }
  }, config.webhookPollMs);
  timer.unref();
  return () => clearInterval(timer);
}

module.exports = { enqueueEvent, assertSafeUrl, isPrivateAddress, sign, startWorker, processBatch };
