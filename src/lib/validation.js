'use strict';

const { z } = require('zod');
const { HttpError } = require('../middleware/errors');
const { HSN_RE, GSTIN_RE } = require('./tax');

const upper = (s) => s.toUpperCase();
const currency = z.string().regex(/^[A-Za-z]{3}$/, 'must be a 3-letter ISO 4217 code').transform(upper);
const country = z.string().regex(/^[A-Za-z]{2}$/, 'must be a 2-letter ISO 3166 code').transform(upper);
const gstin = z.string().transform(upper).refine((v) => GSTIN_RE.test(v), 'is not a valid GSTIN');
const hsn = z.string().regex(HSN_RE, 'HSN/SAC code must be 2, 4, 6 or 8 digits');
const minor = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const prefix = z.string().regex(/^[A-Z0-9]{1,4}$/, 'must be 1-4 uppercase letters or digits');

const address = z
  .object({
    line1: z.string().max(200),
    line2: z.string().max(200),
    city: z.string().max(100),
    state: z.string().max(100),
    postal_code: z.string().max(20),
    country: z.string().max(100),
  })
  .partial()
  .strict();

const merchant = z
  .object({
    name: z.string().min(1).max(200),
    legal_name: z.string().max(200).optional(),
    email: z.string().email().optional(),
    address: address.optional(),
    country: country.optional(),
    state_code: z.string().max(10).transform(upper).optional(),
    gstin: gstin.optional(),
    tax_id: z.string().max(50).optional(),
    base_currency: currency.optional(),
    tax_mode: z.enum(['none', 'standard', 'gst']).optional(),
    prices_include_tax: z.boolean().optional(),
    require_hsn: z.boolean().optional(),
    invoice_prefix: prefix.optional(),
    credit_note_prefix: prefix.optional(),
    fiscal_year_start_month: z.number().int().min(1).max(12).optional(),
  })
  .strict();

const schemas = {
  merchantCreate: merchant,
  merchantUpdate: merchant.partial(),

  apiKeyCreate: z.object({ label: z.string().max(100).optional() }).strict(),

  taxRateCreate: z
    .object({
      name: z.string().min(1).max(100),
      rate: z.number().min(0).max(100),
      hsn_code: hsn.optional(),
      is_default: z.boolean().optional(),
    })
    .strict(),

  couponCreate: z
    .object({
      code: z.string().regex(/^[A-Za-z0-9_-]{2,40}$/).transform(upper),
      type: z.enum(['percent', 'fixed']),
      value: z.number().positive(),
      currency: currency.optional(),
      max_redemptions: z.number().int().positive().optional(),
      expires_at: z.string().datetime({ offset: true }).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.type === 'percent' && c.value > 100) ctx.addIssue({ code: 'custom', path: ['value'], message: 'percent coupons cannot exceed 100' });
      if (c.type === 'fixed' && !Number.isInteger(c.value)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'fixed coupons take an integer amount in minor units' });
      if (c.type === 'fixed' && !c.currency) ctx.addIssue({ code: 'custom', path: ['currency'], message: 'required for fixed coupons' });
    }),

  exchangeRatePut: z.object({ currency, rate: z.number().positive() }).strict(),

  invoiceCreate: z
    .object({
      external_id: z.string().min(1).max(100).optional(),
      currency: currency.optional(),
      exchange_rate: z.number().positive().optional(),
      customer: z
        .object({
          name: z.string().min(1).max(200),
          email: z.string().email().optional(),
          phone: z.string().max(40).optional(),
          address: address.optional(),
          gstin: gstin.optional(),
          state: z.string().max(10).optional(),
          country: country.optional(),
        })
        .strict(),
      place_of_supply: z.string().max(10).optional(),
      tax_inclusive: z.boolean().optional(),
      line_items: z
        .array(
          z
            .object({
              description: z.string().min(1).max(500),
              sku: z.string().max(100).optional(),
              hsn_code: hsn.optional(),
              quantity: z.number().positive().max(1e6).optional(),
              unit_amount: minor,
              discount_amount: minor.optional(),
              tax_rate: z.number().min(0).max(100).optional(),
              tax_rate_id: z.string().uuid().optional(),
            })
            .strict()
        )
        .min(1)
        .max(200),
      coupon_code: z.string().max(40).optional(),
      notes: z.string().max(2000).optional(),
      due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
      metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      // Record a full payment at creation (order already paid at checkout).
      payment: z.object({ method: z.string().max(100).optional(), reference: z.string().max(200).optional() }).strict().optional(),
    })
    .strict(),

  invoicePay: z
    .object({
      amount: minor.positive().optional(),
      method: z.string().max(100).optional(),
      reference: z.string().max(200).optional(),
    })
    .strict(),

  refundCreate: z
    .object({
      amount: minor.positive().optional(), // omit for a full refund
      reason: z.string().max(500).optional(),
      external_id: z.string().min(1).max(100).optional(),
    })
    .strict(),

  creditNoteCreate: z.object({ amount: minor.positive().optional(), reason: z.string().max(500).optional() }).strict(),

  webhookEndpointCreate: z
    .object({
      url: z.string().url().max(2000),
      events: z.array(z.enum(['invoice.created', 'invoice.paid', 'refund.issued', '*'])).min(1),
    })
    .strict(),

  listQuery: z.object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.string().max(30).optional(),
    external_id: z.string().max(100).optional(),
  }),
};

function parse(schema, data) {
  const result = schema.safeParse(data ?? {});
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'validation_error', 'Request validation failed', details);
  }
  return result.data;
}

module.exports = { schemas, parse };
