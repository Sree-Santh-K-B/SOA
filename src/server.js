'use strict';

const config = require('./config');
const app = require('./app');
const { pool } = require('./db');
const { startWorker } = require('./services/webhooks');

const server = app.listen(config.port, () => {
  console.log(`billing-api listening on :${config.port} (docs at /docs)`);
});
const stopWorker = startWorker();

function shutdown() {
  stopWorker();
  server.close(() => pool.end().then(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
