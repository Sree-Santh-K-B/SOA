'use strict';

// All amounts in the API are integers in the currency's minor unit.
// Arithmetic goes through BigInt so intermediate products never lose precision.

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function exponent(currency) {
  const code = String(currency).toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** round(a * b / d), half away from zero. a, b, d are safe integers, d > 0. */
function mulDivRound(a, b, d) {
  const n = BigInt(a) * BigInt(b);
  const den = BigInt(d);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const q = (2n * abs + den) / (2n * den);
  return Number(neg ? -q : q);
}

/**
 * Split `total` across `weights` so the parts sum exactly to `total`
 * (largest-remainder method). Used for coupon and tax allocation.
 */
function allocate(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum === 0 || total === 0) return weights.map(() => 0);
  const T = BigInt(total);
  const S = BigInt(sum);
  const parts = weights.map((w, i) => {
    const prod = T * BigInt(w);
    return { i, share: Number(prod / S), rem: prod % S };
  });
  let left = total - parts.reduce((s, p) => s + p.share, 0);
  const order = [...parts].sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
  for (const p of order) {
    if (left <= 0) break;
    p.share += 1;
    left -= 1;
  }
  return parts.map((p) => p.share);
}

/** 123456, "INR" -> "1,234.56" */
function formatMinor(amount, currency) {
  const exp = exponent(currency);
  const neg = amount < 0;
  const digits = String(Math.abs(amount)).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = exp ? '.' + digits.slice(-exp) : '';
  return (neg ? '-' : '') + whole + frac;
}

/** Convert a minor-unit amount into another currency's minor units. */
function convert(amount, fromCurrency, toCurrency, rate) {
  return Math.round(amount * rate * 10 ** (exponent(toCurrency) - exponent(fromCurrency)));
}

module.exports = { exponent, mulDivRound, allocate, formatMinor, convert };
