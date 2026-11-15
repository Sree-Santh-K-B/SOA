'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yaml');

const { authenticate } = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');
const merchants = require('./routes/merchants');

const specPath = path.join(__dirname, '..', 'openapi.yaml');
const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/openapi.yaml', (req, res) => res.type('text/yaml').sendFile(specPath));
app.use('/docs', swaggerUi.serve, swaggerUi.setup(spec));

app.use('/v1', merchants.admin); // POST /v1/merchants (admin token)
app.use(
  '/v1',
  authenticate, // everything below is scoped to req.merchant
  merchants.router,
  require('./routes/catalog'),
  require('./routes/invoices'),
  require('./routes/webhooks')
);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
