'use strict';

const { mulDivRound, allocate } = require('./money');

const HSN_RE = /^(\d{2}|\d{4}|\d{6}|\d{8})$/;
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;

class TaxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}

const norm = (s) => String(s || '').trim().toUpperCase();

/**
 * GST place-of-supply rule: same country and same state as the seller means
 * CGST + SGST; anything else is IGST.
 */
function resolveSupply({ merchantCountry, merchantState, customerCountry, customerState, placeOfSupply }) {
  const pos = norm(placeOfSupply) || norm(customerState) || norm(merchantState);
  const country = norm(customerCountry) || norm(merchantCountry);
  const intraState = country === norm(merchantCountry) && pos === norm(merchantState);
  return { placeOfSupply: pos || null, intraState };
}

function components(taxMode, intraState, rate, tax, name) {
  if (taxMode === 'none' || tax === 0) return [];
  if (taxMode === 'gst') {
    if (intraState) {
      const half = tax / 2; // always even, see below
      return [
        { name: 'CGST', rate: rate / 2, amount: half },
        { name: 'SGST', rate: rate / 2, amount: half },
      ];
    }
    return [{ name: 'IGST', rate, amount: tax }];
  }
  return [{ name: name || 'Tax', rate, amount: tax }];
}

/**
 * Pure invoice calculator.
 *
 * lines:   [{ quantity, unit_amount, discount_amount?, tax_rate?, tax_name?, ... }]
 *          amounts in minor units, tax_rate in percent, quantity up to 3 decimals
 * coupon:  { type: 'percent' | 'fixed', value } applied to the invoice, spread across
 *          lines in proportion to their net value, and always applied before tax
 * taxMode: 'none' | 'standard' | 'gst'
 *
 * Rounding is half-up per line. Under intra-state GST each half is rounded
 * separately so CGST always equals SGST.
 */
function calculateInvoice({ lines, taxMode = 'standard', intraState = true, taxInclusive = false, coupon = null }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new TaxError('no_lines', 'An invoice needs at least one line item');

  const prepared = lines.map((line, idx) => {
    const qtyMilli = Math.round(Number(line.quantity ?? 1) * 1000);
    const unit = line.unit_amount;
    const discount = line.discount_amount ?? 0;
    const rate = taxMode === 'none' ? 0 : Number(line.tax_rate ?? 0);
    if (!(qtyMilli > 0)) throw new TaxError('invalid_quantity', `Line ${idx + 1}: quantity must be positive`);
    if (!Number.isSafeInteger(unit) || unit < 0) throw new TaxError('invalid_amount', `Line ${idx + 1}: unit_amount must be a non-negative integer`);
    if (!Number.isSafeInteger(discount) || discount < 0) throw new TaxError('invalid_discount', `Line ${idx + 1}: discount_amount must be a non-negative integer`);
    if (!(rate >= 0 && rate <= 100)) throw new TaxError('invalid_tax_rate', `Line ${idx + 1}: tax_rate must be between 0 and 100`);
    const gross = mulDivRound(unit, qtyMilli, 1000);
    if (discount > gross) throw new TaxError('invalid_discount', `Line ${idx + 1}: discount exceeds the line amount`);
    return { line, gross, discount, net: gross - discount, rate, rateMilli: Math.round(rate * 1000) };
  });

  const netTotal = prepared.reduce((s, p) => s + p.net, 0);
  let couponDiscount = 0;
  if (coupon) {
    if (coupon.type === 'percent') couponDiscount = mulDivRound(netTotal, Math.round(Number(coupon.value) * 1000), 100000);
    else if (coupon.type === 'fixed') couponDiscount = Math.min(Math.round(Number(coupon.value)), netTotal);
    else throw new TaxError('invalid_coupon', 'Unknown coupon type');
    couponDiscount = Math.min(couponDiscount, netTotal);
  }
  const couponShares = allocate(couponDiscount, prepared.map((p) => p.net));

  const splitGst = taxMode === 'gst' && intraState;
  const summary = new Map();

  const outLines = prepared.map((p, i) => {
    const afterDiscount = p.net - couponShares[i];
    let tax;
    let taxable;
    if (taxInclusive) {
      tax = splitGst
        ? 2 * mulDivRound(afterDiscount, p.rateMilli, 2 * (100000 + p.rateMilli))
        : mulDivRound(afterDiscount, p.rateMilli, 100000 + p.rateMilli);
      taxable = afterDiscount - tax;
    } else {
      taxable = afterDiscount;
      tax = splitGst ? 2 * mulDivRound(taxable, p.rateMilli, 200000) : mulDivRound(taxable, p.rateMilli, 100000);
    }
    const comps = components(taxMode, intraState, p.rate, tax, p.line.tax_name);
    for (const c of comps) {
      const key = `${c.name}|${c.rate}`;
      const s = summary.get(key) || { name: c.name, rate: c.rate, taxable_amount: 0, amount: 0 };
      s.taxable_amount += taxable;
      s.amount += c.amount;
      summary.set(key, s);
    }
    return {
      ...p.line,
      quantity: Number(p.line.quantity ?? 1),
      gross_amount: p.gross,
      discount_amount: p.discount + couponShares[i],
      taxable_amount: taxable,
      tax_rate: p.rate,
      tax_amount: tax,
      tax_components: comps,
      total: taxable + tax,
    };
  });

  const sum = (key) => outLines.reduce((s, l) => s + l[key], 0);
  return {
    lines: outLines,
    subtotal: sum('gross_amount'), // before discounts; includes tax when taxInclusive
    discount_total: sum('discount_amount'),
    coupon_discount: couponDiscount,
    taxable_total: sum('taxable_amount'),
    tax_total: sum('tax_amount'),
    total: sum('total'),
    tax_summary: [...summary.values()],
  };
}

module.exports = { calculateInvoice, resolveSupply, TaxError, HSN_RE, GSTIN_RE };
