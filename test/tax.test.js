'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateInvoice, resolveSupply, TaxError, HSN_RE, GSTIN_RE } = require('../src/lib/tax');
const { allocate, mulDivRound, formatMinor, convert } = require('../src/lib/money');
const { fiscalPeriod, formatNumber } = require('../src/lib/numbering');

const line = (over = {}) => ({ description: 'Widget', quantity: 1, unit_amount: 10000, tax_rate: 18, ...over });

test('standard tax, exclusive pricing', () => {
  const r = calculateInvoice({ lines: [line({ quantity: 2, unit_amount: 50000, tax_name: 'VAT' })], taxMode: 'standard' });
  assert.equal(r.subtotal, 100000);
  assert.equal(r.tax_total, 18000);
  assert.equal(r.total, 118000);
  assert.deepEqual(r.tax_summary, [{ name: 'VAT', rate: 18, taxable_amount: 100000, amount: 18000 }]);
});

test('GST intra-state splits into equal CGST and SGST', () => {
  const r = calculateInvoice({ lines: [line({ quantity: 2, unit_amount: 50000 })], taxMode: 'gst', intraState: true });
  assert.deepEqual(r.lines[0].tax_components, [
    { name: 'CGST', rate: 9, amount: 9000 },
    { name: 'SGST', rate: 9, amount: 9000 },
  ]);
  assert.equal(r.total, 118000);
});

test('GST inter-state charges IGST', () => {
  const r = calculateInvoice({ lines: [line()], taxMode: 'gst', intraState: false });
  assert.deepEqual(r.lines[0].tax_components, [{ name: 'IGST', rate: 18, amount: 1800 }]);
});

test('CGST and SGST stay equal when the tax is an odd number of paise', () => {
  // 5% of 105 = 5.25. Each half (2.625) rounds to 3, so tax is 6, not 5.
  const intra = calculateInvoice({ lines: [line({ unit_amount: 105, tax_rate: 5 })], taxMode: 'gst', intraState: true });
  const [cgst, sgst] = intra.lines[0].tax_components;
  assert.equal(cgst.amount, sgst.amount);
  assert.equal(intra.tax_total, 6);
  const inter = calculateInvoice({ lines: [line({ unit_amount: 105, tax_rate: 5 })], taxMode: 'gst', intraState: false });
  assert.equal(inter.tax_total, 5);
});

test('tax-inclusive pricing backs the tax out of the price', () => {
  const r = calculateInvoice({ lines: [line({ unit_amount: 118000 })], taxMode: 'gst', intraState: true, taxInclusive: true });
  assert.equal(r.total, 118000);
  assert.equal(r.tax_total, 18000);
  assert.equal(r.taxable_total, 100000);
});

test('mixed rates produce one summary row per component and rate', () => {
  const r = calculateInvoice({
    lines: [line({ tax_rate: 18 }), line({ tax_rate: 5 }), line({ tax_rate: 18 }), line({ tax_rate: 0 })],
    taxMode: 'gst',
    intraState: false,
  });
  assert.deepEqual(r.tax_summary, [
    { name: 'IGST', rate: 18, taxable_amount: 20000, amount: 3600 },
    { name: 'IGST', rate: 5, taxable_amount: 10000, amount: 500 },
  ]);
  assert.deepEqual(r.lines[3].tax_components, []);
});

test('line discount reduces the taxable value', () => {
  const r = calculateInvoice({ lines: [line({ discount_amount: 1000 })], taxMode: 'standard' });
  assert.equal(r.lines[0].taxable_amount, 9000);
  assert.equal(r.tax_total, 1620);
  assert.equal(r.total, 10620);
});

test('percent coupon is spread across lines before tax', () => {
  const r = calculateInvoice({
    lines: [line({ unit_amount: 10000 }), line({ unit_amount: 20000 })],
    taxMode: 'standard',
    coupon: { type: 'percent', value: 10 },
  });
  assert.equal(r.coupon_discount, 3000);
  assert.deepEqual(r.lines.map((l) => l.discount_amount), [1000, 2000]);
  assert.deepEqual(r.lines.map((l) => l.tax_amount), [1620, 3240]);
  assert.equal(r.total, 31860);
  assert.equal(r.total, r.subtotal - r.discount_total + r.tax_total);
});

test('fixed coupon is capped at the invoice value', () => {
  const r = calculateInvoice({ lines: [line({ unit_amount: 30000 })], taxMode: 'standard', coupon: { type: 'fixed', value: 50000 } });
  assert.equal(r.coupon_discount, 30000);
  assert.equal(r.total, 0);
  assert.equal(r.tax_total, 0);
});

test('coupon allocation never loses a paisa', () => {
  const r = calculateInvoice({
    lines: [line({ unit_amount: 3333 }), line({ unit_amount: 3333 }), line({ unit_amount: 3334 })],
    taxMode: 'none',
    coupon: { type: 'fixed', value: 100 },
  });
  assert.equal(r.lines.reduce((s, l) => s + l.discount_amount, 0), 100);
  assert.equal(r.total, 9900);
});

test('fractional quantities round half up', () => {
  const r = calculateInvoice({ lines: [line({ quantity: 1.5, unit_amount: 999, tax_rate: 0 })], taxMode: 'standard' });
  assert.equal(r.subtotal, 1499); // 1498.5
});

test('tax mode "none" ignores line rates', () => {
  const r = calculateInvoice({ lines: [line()], taxMode: 'none' });
  assert.equal(r.tax_total, 0);
  assert.equal(r.total, 10000);
});

test('invalid input is rejected', () => {
  assert.throws(() => calculateInvoice({ lines: [] }), TaxError);
  assert.throws(() => calculateInvoice({ lines: [line({ quantity: 0 })] }), TaxError);
  assert.throws(() => calculateInvoice({ lines: [line({ unit_amount: 10.5 })] }), TaxError);
  assert.throws(() => calculateInvoice({ lines: [line({ discount_amount: 10001 })] }), TaxError);
  assert.throws(() => calculateInvoice({ lines: [line({ tax_rate: 101 })] }), TaxError);
});

test('place of supply decides intra- vs inter-state', () => {
  const m = { merchantCountry: 'IN', merchantState: 'MH' };
  assert.equal(resolveSupply({ ...m, customerState: 'mh' }).intraState, true);
  assert.equal(resolveSupply({ ...m, customerState: 'KA' }).intraState, false);
  assert.equal(resolveSupply({ ...m, customerState: 'MH', placeOfSupply: 'KA' }).intraState, false);
  assert.equal(resolveSupply({ ...m, customerState: 'MH', customerCountry: 'US' }).intraState, false);
  assert.deepEqual(resolveSupply(m), { placeOfSupply: 'MH', intraState: true }); // no customer state: assume seller's
});

test('HSN and GSTIN formats', () => {
  for (const ok of ['99', '8471', '847130', '84713010']) assert.ok(HSN_RE.test(ok));
  for (const bad of ['847', '8471301', 'ABCD', '']) assert.ok(!HSN_RE.test(bad));
  assert.ok(GSTIN_RE.test('27AAPFU0939F1ZV'));
  assert.ok(!GSTIN_RE.test('27AAPFU0939F1V'));
});

test('money helpers', () => {
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(0, [1, 2]), [0, 0]);
  assert.equal(mulDivRound(5, 1, 2), 3);
  assert.equal(mulDivRound(9007199254740991, 1000, 1000), 9007199254740991); // no float overflow
  assert.equal(formatMinor(123456789, 'INR'), '1,234,567.89');
  assert.equal(formatMinor(5, 'USD'), '0.05');
  assert.equal(formatMinor(1500, 'JPY'), '1,500');
  assert.equal(formatMinor(1500, 'KWD'), '1.500');
  assert.equal(convert(10000, 'USD', 'INR', 83.5), 835000); // $100.00 -> Rs 8,350.00
  assert.equal(convert(1000, 'JPY', 'INR', 0.55), 55000); // 1000 yen -> Rs 550.00
});

test('invoice numbering', () => {
  assert.equal(fiscalPeriod('2026-11-15T00:00:00Z', 1), '2026');
  assert.equal(fiscalPeriod('2026-11-15T00:00:00Z', 4), '2627');
  assert.equal(fiscalPeriod('2027-03-31T23:59:59Z', 4), '2627');
  assert.equal(fiscalPeriod('2027-04-01T00:00:00Z', 4), '2728');
  assert.equal(formatNumber('INV', '2627', 42), 'INV-2627-000042');
});
