'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRefund, computeCreditNote, deriveStatus, RefundError } = require('../src/lib/refunds');

// A paid Rs 1,180.00 invoice: Rs 1,000.00 taxable + 18% GST split CGST/SGST.
const paidInvoice = (over = {}) => ({
  status: 'paid',
  total: 118000,
  tax_total: 18000,
  tax_summary: [
    { name: 'CGST', rate: 9, taxable_amount: 100000, amount: 9000 },
    { name: 'SGST', rate: 9, taxable_amount: 100000, amount: 9000 },
  ],
  amount_paid: 118000,
  amount_credited: 0,
  amount_refunded: 0,
  tax_reversed: 0,
  ...over,
});

/** Apply a refund the way the service does. */
function applyRefund(inv, r) {
  const next = { ...inv, amount_refunded: inv.amount_refunded + r.amount, tax_reversed: inv.tax_reversed + r.tax_amount };
  return { ...next, status: deriveStatus(next) };
}

test('full refund when no amount is given', () => {
  const r = computeRefund(paidInvoice());
  assert.equal(r.amount, 118000);
  assert.equal(r.tax_amount, 18000);
  assert.equal(r.taxable_amount, 100000);
  assert.deepEqual(r.tax_components, [
    { name: 'CGST', rate: 9, amount: 9000 },
    { name: 'SGST', rate: 9, amount: 9000 },
  ]);
  assert.equal(applyRefund(paidInvoice(), r).status, 'refunded');
});

test('partial refund reverses tax proportionally', () => {
  const r = computeRefund(paidInvoice(), 59000);
  assert.equal(r.tax_amount, 9000);
  assert.equal(r.taxable_amount, 50000);
  assert.deepEqual(r.tax_components.map((c) => c.amount), [4500, 4500]);
  assert.equal(applyRefund(paidInvoice(), r).status, 'partially_refunded');
});

test('a series of partial refunds reverses exactly the invoice tax', () => {
  let inv = paidInvoice();
  const amounts = [...Array(11).fill(10000), 8000]; // 12 refunds adding up to the total
  let tax = 0;
  for (const amount of amounts) {
    const r = computeRefund(inv, amount);
    assert.equal(r.tax_components.reduce((s, c) => s + c.amount, 0), r.tax_amount);
    tax += r.tax_amount;
    inv = applyRefund(inv, r);
  }
  assert.equal(tax, 18000);
  assert.equal(inv.amount_refunded, 118000);
  assert.equal(inv.tax_reversed, 18000);
  assert.equal(inv.status, 'refunded');
});

test('second refund is limited to what is left', () => {
  const inv = applyRefund(paidInvoice(), computeRefund(paidInvoice(), 100000));
  assert.throws(() => computeRefund(inv, 18001), (e) => e instanceof RefundError && e.code === 'amount_too_large');
  assert.equal(computeRefund(inv).amount, 18000); // "refund the rest"
});

test('cannot refund more than was paid', () => {
  assert.throws(() => computeRefund(paidInvoice(), 118001), (e) => e.code === 'amount_too_large');
  const partlyPaid = paidInvoice({ amount_paid: 50000, status: 'partially_paid' });
  assert.throws(() => computeRefund(partlyPaid, 50001), RefundError);
  assert.equal(computeRefund(partlyPaid).amount, 50000);
});

test('unpaid, fully refunded and void invoices cannot be refunded', () => {
  assert.throws(() => computeRefund(paidInvoice({ amount_paid: 0, status: 'open' })), (e) => e.code === 'nothing_to_refund');
  assert.throws(() => computeRefund(paidInvoice({ amount_refunded: 118000 })), (e) => e.code === 'nothing_to_refund');
  assert.throws(() => computeRefund(paidInvoice({ status: 'void' })), (e) => e.code === 'invoice_void');
});

test('invalid amounts are rejected', () => {
  for (const bad of [0, -100, 10.5, NaN, '100']) {
    assert.throws(() => computeRefund(paidInvoice(), bad), (e) => e.code === 'invalid_amount', `amount ${bad}`);
  }
});

test('refund on an invoice without tax', () => {
  const r = computeRefund(paidInvoice({ tax_total: 0, tax_summary: [], total: 100000, amount_paid: 100000 }), 2500);
  assert.equal(r.tax_amount, 0);
  assert.deepEqual(r.tax_components, []);
});

test('credit note reduces the unpaid balance only', () => {
  const open = paidInvoice({ amount_paid: 0, status: 'open' });
  const cn = computeCreditNote(open, 59000);
  assert.equal(cn.tax_amount, 9000);
  assert.throws(() => computeCreditNote(open, 118001), (e) => e.code === 'amount_too_large');
  assert.throws(() => computeCreditNote(paidInvoice()), (e) => e.code === 'nothing_to_credit');
});

test('credit note then refund still reverses the exact tax', () => {
  // Credit Rs 180.00 off an open invoice, customer pays the rest, then it is fully refunded.
  let inv = paidInvoice({ amount_paid: 0, status: 'open' });
  const cn = computeCreditNote(inv, 18000);
  inv = { ...inv, amount_credited: 18000, tax_reversed: cn.tax_amount, amount_paid: 100000 };
  const r = computeRefund(inv);
  assert.equal(r.amount, 100000);
  assert.equal(cn.tax_amount + r.tax_amount, 18000);
});

test('status derivation', () => {
  const base = { total: 1000, amount_paid: 0, amount_credited: 0, amount_refunded: 0 };
  assert.equal(deriveStatus(base), 'open');
  assert.equal(deriveStatus({ ...base, amount_paid: 400 }), 'partially_paid');
  assert.equal(deriveStatus({ ...base, amount_paid: 1000 }), 'paid');
  assert.equal(deriveStatus({ ...base, amount_paid: 600, amount_credited: 400 }), 'paid');
  assert.equal(deriveStatus({ ...base, amount_credited: 1000 }), 'credited');
  assert.equal(deriveStatus({ ...base, amount_paid: 1000, amount_refunded: 300 }), 'partially_refunded');
  assert.equal(deriveStatus({ ...base, amount_paid: 1000, amount_refunded: 1000 }), 'refunded');
  assert.equal(deriveStatus({ ...base, total: 0 }), 'paid');
  assert.equal(deriveStatus({ ...base, voided: true }), 'void');
});
