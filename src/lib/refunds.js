'use strict';

const { mulDivRound, allocate } = require('./money');

class RefundError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefundError';
    this.code = code;
  }
}

/**
 * Reverse `amount` (tax-inclusive, minor units) of an invoice and work out how
 * much of it is tax, split across the invoice's tax components.
 *
 * Tax is reversed in proportion to the amount. The reversal that brings the
 * invoice to zero takes whatever tax is left, so a series of partial refunds
 * always reverses exactly the invoice's tax_total - never a paisa more or less.
 */
function reverse(invoice, amount, limit, what) {
  if (invoice.status === 'void') throw new RefundError('invoice_void', 'Invoice is void');
  if (limit <= 0) throw new RefundError(`nothing_to_${what}`, `Invoice has no amount left to ${what}`);
  const amt = amount === undefined || amount === null ? limit : amount;
  if (!Number.isSafeInteger(amt) || amt <= 0) throw new RefundError('invalid_amount', 'amount must be a positive integer in minor units');
  if (amt > limit) throw new RefundError('amount_too_large', `amount ${amt} exceeds the ${what}able amount ${limit}`);

  const reversedBefore = invoice.amount_refunded + invoice.amount_credited;
  const taxLeft = invoice.tax_total - invoice.tax_reversed;
  const isFinal = reversedBefore + amt === invoice.total;
  const tax = isFinal ? taxLeft : Math.min(taxLeft, mulDivRound(amt, invoice.tax_total, invoice.total));

  const summary = invoice.tax_summary || [];
  const shares = allocate(tax, summary.map((s) => s.amount));
  const taxComponents = summary
    .map((s, i) => ({ name: s.name, rate: s.rate, amount: shares[i] }))
    .filter((c) => c.amount > 0);

  return { amount: amt, tax_amount: tax, taxable_amount: amt - tax, tax_components: taxComponents };
}

/** Refund money already paid. Omit `amount` for a full refund of what is left. */
function computeRefund(invoice, amount) {
  return reverse(invoice, amount, invoice.amount_paid - invoice.amount_refunded, 'refund');
}

/** Adjustment credit note: reduces what the customer still owes. */
function computeCreditNote(invoice, amount) {
  return reverse(invoice, amount, invoice.total - invoice.amount_paid - invoice.amount_credited, 'credit');
}

function deriveStatus({ total, amount_paid, amount_credited, amount_refunded, voided = false }) {
  if (voided) return 'void';
  if (amount_refunded > 0) return amount_refunded >= amount_paid ? 'refunded' : 'partially_refunded';
  const due = total - amount_paid - amount_credited;
  if (due <= 0) return amount_paid > 0 || total === 0 ? 'paid' : 'credited';
  return amount_paid > 0 ? 'partially_paid' : 'open';
}

module.exports = { computeRefund, computeCreditNote, deriveStatus, RefundError };
