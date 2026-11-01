// Pure billing helpers. No DOM and no storage, so they can be unit-tested.

export const UNITS = [
  'pcs', 'kg', 'm', 'ft', 'box', 'bag', 'ltr', 'set', 'bundle',
  'coil', 'roll', 'dozen', 'sheet', 'pair', 'rod',
];

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n) => Math.round((n + Number.EPSILON) * 1000) / 1000;

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt = (n) => inr.format(n || 0);
export const qtyFmt = (n) => String(round3(n || 0));

export const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Calculate one invoice line: quantity x rate, less the discount.
 * line: { qty, rate, discPct }  (rate is per the line's own unit)
 */
export function calcLine(line) {
  const qty = +line.qty || 0;
  const rate = +line.rate || 0;
  const discPct = +line.discPct || 0;
  const gross = qty * rate;
  const total = round2(gross - (gross * discPct) / 100);
  return { ...line, total };
}

/** Calculate a whole invoice. The grand total is rounded to the nearest rupee, with the difference shown as round off. */
export function calcInvoice(lines) {
  const calculated = lines.map(calcLine);
  const subtotal = round2(calculated.reduce((a, l) => a + l.total, 0));
  const total = Math.round(subtotal);
  return { lines: calculated, subtotal, roundOff: round2(total - subtotal), total };
}

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven',
  'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
const two = (n) => (n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : ''));
const three = (n) => {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return (h ? `${ONES[h]} Hundred${r ? ' ' : ''}` : '') + (r ? two(r) : '');
};

/** 1234567.5 -> "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven Rupees and Fifty Paise Only" */
export function rupeesInWords(amount) {
  const abs = Math.abs(amount || 0);
  let rupees = Math.floor(abs);
  let paise = Math.round((abs - rupees) * 100);
  if (paise === 100) { rupees += 1; paise = 0; }
  if (!rupees && !paise) return 'Zero Rupees Only';

  let n = rupees;
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1e3); n %= 1e3;

  const parts = [];
  if (crore) parts.push(`${three(crore)} Crore`);
  if (lakh) parts.push(`${two(lakh)} Lakh`);
  if (thousand) parts.push(`${two(thousand)} Thousand`);
  if (n) parts.push(three(n));

  let words = rupees ? `${parts.join(' ')} Rupees` : '';
  if (paise) words += `${words ? ' and ' : ''}${two(paise)} Paise`;
  return `${words} Only`;
}
