'use strict';

/**
 * Fiscal period label for a date. Calendar-year merchants get "2026";
 * merchants whose year starts in another month (India: April) get "2627".
 */
function fiscalPeriod(date, startMonth = 1) {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  if (startMonth === 1) return String(year);
  const start = d.getUTCMonth() + 1 >= startMonth ? year : year - 1;
  return String(start).slice(-2) + String(start + 1).slice(-2);
}

/** INV-2627-000042. With a prefix of up to 4 chars this stays within GST's 16-character limit. */
function formatNumber(prefix, period, seq) {
  return `${prefix}-${period}-${String(seq).padStart(6, '0')}`;
}

/**
 * Take the next number inside the caller's transaction. The upsert locks the
 * counter row, so concurrent invoices queue up, and a rollback returns the
 * number - the sequence has no gaps.
 */
async function nextNumber(client, merchant, docType, date = new Date()) {
  const period = fiscalPeriod(date, merchant.fiscal_year_start_month);
  const { rows } = await client.query(
    `INSERT INTO number_sequences (merchant_id, doc_type, period, last_value)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (merchant_id, doc_type, period)
     DO UPDATE SET last_value = number_sequences.last_value + 1
     RETURNING last_value`,
    [merchant.id, docType, period]
  );
  const prefix = docType === 'invoice' ? merchant.invoice_prefix : merchant.credit_note_prefix;
  return formatNumber(prefix, period, rows[0].last_value);
}

module.exports = { fiscalPeriod, formatNumber, nextNumber };
