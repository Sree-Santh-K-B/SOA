'use strict';

const PDFDocument = require('pdfkit');
const { formatMinor } = require('../lib/money');

const LEFT = 40;
const WIDTH = 515; // A4 (595pt) minus margins
const BOTTOM = 780;

// The built-in PDF fonts have no glyphs for symbols like the rupee sign, so
// amounts are shown with the ISO currency code instead.
const COLUMNS = [
  { key: 'pos', label: '#', width: 18, align: 'left' },
  { key: 'description', label: 'Item', width: 135, align: 'left' },
  { key: 'hsn', label: 'HSN/SAC', width: 45, align: 'left' },
  { key: 'qty', label: 'Qty', width: 30, align: 'right' },
  { key: 'rate', label: 'Rate', width: 55, align: 'right' },
  { key: 'discount', label: 'Discount', width: 50, align: 'right' },
  { key: 'taxable', label: 'Taxable', width: 58, align: 'right' },
  { key: 'taxRate', label: 'Tax %', width: 32, align: 'right' },
  { key: 'tax', label: 'Tax', width: 42, align: 'right' },
  { key: 'total', label: 'Total', width: 50, align: 'right' },
];

function addressLines(a = {}) {
  return [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(', '), a.country].filter(Boolean);
}

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Render the invoice as a PDF and stream it into `out` (an HTTP response or file stream). */
function streamInvoicePdf(merchant, invoice, out) {
  const doc = new PDFDocument({ size: 'A4', margin: LEFT, info: { Title: `Invoice ${invoice.number}`, Author: merchant.name } });
  doc.pipe(out);
  const money = (n) => formatMinor(n, invoice.currency);
  const isGst = merchant.tax_mode === 'gst';

  // ----- header -----
  doc.font('Helvetica-Bold').fontSize(16).text(merchant.legal_name || merchant.name, LEFT, 40, { width: 300 });
  doc.font('Helvetica').fontSize(9);
  const sellerLines = [...addressLines(merchant.address)];
  if (merchant.gstin) sellerLines.push(`GSTIN: ${merchant.gstin}`);
  if (merchant.tax_id) sellerLines.push(`Tax ID: ${merchant.tax_id}`);
  if (merchant.email) sellerLines.push(merchant.email);
  doc.text(sellerLines.join('\n'), LEFT, doc.y + 2, { width: 300 });
  const sellerBottom = doc.y;

  doc.font('Helvetica-Bold').fontSize(16).text(isGst ? 'TAX INVOICE' : 'INVOICE', 355, 40, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(9);
  const meta = [
    ['Invoice no.', invoice.number],
    ['Date', day(invoice.issued_at)],
    invoice.due_date && ['Due date', invoice.due_date],
    ['Status', invoice.status.replace(/_/g, ' ').toUpperCase()],
    isGst && invoice.place_of_supply && ['Place of supply', invoice.place_of_supply],
    ['Currency', invoice.currency],
  ].filter(Boolean);
  let y = 64;
  for (const [label, value] of meta) {
    doc.fillColor('#666').text(label, 355, y, { width: 90, align: 'right' });
    doc.fillColor('#000').text(String(value), 450, y, { width: 105, align: 'right' });
    y += 13;
  }

  // ----- bill to -----
  y = Math.max(y, sellerBottom) + 18;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('BILL TO', LEFT, y);
  doc.fillColor('#000').fontSize(10).text(invoice.customer.name, LEFT, y + 12, { width: 300 });
  doc.font('Helvetica').fontSize(9);
  const buyerLines = [...addressLines(invoice.customer.address)];
  if (invoice.customer.gstin) buyerLines.push(`GSTIN: ${invoice.customer.gstin}`);
  if (invoice.customer.email) buyerLines.push(invoice.customer.email);
  if (invoice.customer.phone) buyerLines.push(invoice.customer.phone);
  if (buyerLines.length) doc.text(buyerLines.join('\n'), LEFT, doc.y + 1, { width: 300 });
  y = doc.y + 18;

  // ----- line items -----
  const drawRow = (cells, rowY, bold) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    let x = LEFT;
    for (const col of COLUMNS) {
      doc.text(cells[col.key] ?? '', x + 2, rowY, { width: col.width - 4, align: col.align });
      x += col.width;
    }
  };
  const drawHeader = () => {
    doc.rect(LEFT, y - 4, WIDTH, 16).fill('#f0f0f0').fillColor('#000');
    drawRow(Object.fromEntries(COLUMNS.map((c) => [c.key, c.label])), y, true);
    y += 16;
  };
  drawHeader();

  for (const item of invoice.line_items) {
    const description = item.sku ? `${item.description}\nSKU: ${item.sku}` : item.description;
    doc.font('Helvetica').fontSize(8);
    const rowHeight = Math.max(12, doc.heightOfString(description, { width: COLUMNS[1].width - 4 })) + 5;
    if (y + rowHeight > BOTTOM) {
      doc.addPage();
      y = 50;
      drawHeader();
    }
    drawRow(
      {
        pos: String(item.position),
        description,
        hsn: item.hsn_code || '',
        qty: String(item.quantity),
        rate: money(item.unit_amount),
        discount: item.discount_amount ? money(item.discount_amount) : '-',
        taxable: money(item.taxable_amount),
        taxRate: `${item.tax_rate}%`,
        tax: money(item.tax_amount),
        total: money(item.total),
      },
      y
    );
    y += rowHeight;
    doc.moveTo(LEFT, y - 3).lineTo(LEFT + WIDTH, y - 3).strokeColor('#dddddd').lineWidth(0.5).stroke();
  }

  // ----- totals -----
  const totals = [
    [invoice.tax_inclusive ? 'Subtotal (incl. tax)' : 'Subtotal', money(invoice.subtotal)],
    invoice.discount_total > 0 && [invoice.coupon_code ? `Discount (incl. coupon ${invoice.coupon_code})` : 'Discount', `-${money(invoice.discount_total)}`],
    ...invoice.tax_summary.map((t) => [`${t.name} @ ${t.rate}%${invoice.tax_inclusive ? ' (included)' : ''}`, money(t.amount)]),
    ['TOTAL', `${invoice.currency} ${money(invoice.total)}`, true],
    invoice.amount_paid > 0 && ['Paid', money(invoice.amount_paid)],
    invoice.amount_credited > 0 && ['Credited', money(invoice.amount_credited)],
    invoice.amount_refunded > 0 && ['Refunded', money(invoice.amount_refunded)],
    ['Amount due', `${invoice.currency} ${money(invoice.amount_due)}`, true],
  ].filter(Boolean);

  if (y + totals.length * 14 + 20 > BOTTOM) {
    doc.addPage();
    y = 50;
  }
  y += 8;
  for (const [label, value, bold] of totals) {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    doc.text(label, 300, y, { width: 150, align: 'right' });
    doc.text(value, 455, y, { width: 100, align: 'right' });
    y += 14;
  }

  if (invoice.notes) {
    if (y + 40 > BOTTOM) {
      doc.addPage();
      y = 50;
    }
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#666').text('NOTES', LEFT, y + 10);
    doc.font('Helvetica').fillColor('#000').text(invoice.notes, LEFT, doc.y + 2, { width: WIDTH });
  }

  doc.end();
  return doc;
}

module.exports = { streamInvoicePdf };
