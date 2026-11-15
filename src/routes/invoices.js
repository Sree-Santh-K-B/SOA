'use strict';

const express = require('express');
const { pool } = require('../db');
const { h, uuidParam } = require('../middleware/errors');
const { schemas, parse } = require('../lib/validation');
const invoices = require('../services/invoices');
const { streamInvoicePdf } = require('../services/pdf');

const router = express.Router();
router.param('id', uuidParam);

router.post('/invoices', h(async (req, res) => {
  const input = parse(schemas.invoiceCreate, req.body);
  const { invoice, created } = await invoices.createInvoice(req.merchant, input);
  res.status(created ? 201 : 200).json(invoice); // 200 = idempotent replay of an existing external_id
}));

router.get('/invoices', h(async (req, res) => {
  res.json(await invoices.listInvoices(req.merchant.id, parse(schemas.listQuery, req.query)));
}));

router.get('/invoices/:id', h(async (req, res) => {
  res.json(await invoices.getInvoice(pool, req.merchant.id, req.params.id));
}));

router.get('/invoices/:id/pdf', h(async (req, res) => {
  const invoice = await invoices.getInvoice(pool, req.merchant.id, req.params.id);
  res.type('application/pdf');
  res.set('Content-Disposition', `inline; filename="${invoice.number}.pdf"`);
  streamInvoicePdf(req.merchant, invoice, res);
}));

router.post('/invoices/:id/pay', h(async (req, res) => {
  res.json(await invoices.payInvoice(req.merchant, req.params.id, parse(schemas.invoicePay, req.body)));
}));

router.post('/invoices/:id/void', h(async (req, res) => {
  res.json(await invoices.voidInvoice(req.merchant, req.params.id));
}));

router.post('/invoices/:id/refunds', h(async (req, res) => {
  const { refund, created } = await invoices.refundInvoice(req.merchant, req.params.id, parse(schemas.refundCreate, req.body));
  res.status(created ? 201 : 200).json(refund);
}));

router.get('/invoices/:id/refunds', h(async (req, res) => {
  res.json({ data: await invoices.listRefunds(req.merchant.id, req.params.id) });
}));

router.post('/invoices/:id/credit-notes', h(async (req, res) => {
  res.status(201).json(await invoices.creditInvoice(req.merchant, req.params.id, parse(schemas.creditNoteCreate, req.body)));
}));

router.get('/credit-notes', h(async (req, res) => {
  res.json(await invoices.listCreditNotes(req.merchant.id, parse(schemas.listQuery, req.query)));
}));

router.get('/credit-notes/:id', h(async (req, res) => {
  res.json(await invoices.getCreditNote(req.merchant.id, req.params.id));
}));

module.exports = router;
