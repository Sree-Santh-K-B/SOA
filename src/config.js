'use strict';

module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://billing:billing@localhost:5432/billing',
  adminToken: process.env.ADMIN_TOKEN || '',
  // Allow http:// and private/loopback webhook targets. Development only.
  webhookAllowPrivate: process.env.WEBHOOK_ALLOW_PRIVATE === 'true',
  webhookPollMs: Number(process.env.WEBHOOK_POLL_MS || 5000),
  webhookTimeoutMs: Number(process.env.WEBHOOK_TIMEOUT_MS || 10000),
};
