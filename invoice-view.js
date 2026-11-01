// Draws the invoice as fixed A4 portrait pages.
// One layout feeds the on-screen preview, print, the WhatsApp image and the PDF,
// so the bill looks the same everywhere and on every phone.
//
//   buildModel(inv, settings)      what to show (pure)
//   layoutInvoice(model, measure)  draw commands for each page (pure, needs a text-width function)
//   renderInvoicePages(...)        browser only: turns the commands into canvases
import { fmt, qtyFmt, rupeesInWords, fmtDate } from './billing.js';

// Sizes are CSS pixels at 96 dpi (A4 = 794 x 1123). Canvases are drawn at 2x for sharp text.
export const PAGE = { w: 794, h: 1123, margin: 36, scale: 2 };

const FONT = '"Segoe UI", system-ui, -apple-system, Roboto, "Noto Sans", Arial, sans-serif';
const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
const INK = '#111111';
const SOFT = '#333333';
const MUTED = '#5c5c5c';
const GRID = '#8a8a8a';
const HEAD_BG = '#eceff1';
const RED = '#b42318';

/** Decide what appears on the bill. Each line's amount is its saved `total`, so older bills draw too. */
export function buildModel(inv, settings) {
  const lines = inv.lines || [];

  const columns = [
    { key: 'no', head: '#', w: 28, align: 'left' },
    { key: 'name', head: 'Item', w: 0, align: 'left', wrap: true },
    { key: 'qty', head: 'Qty', w: 96, align: 'right', wrap: true },
    { key: 'rate', head: 'Rate', w: 90, align: 'right' },
    { key: 'disc', head: 'Disc %', w: 60, align: 'right' },
    { key: 'amount', head: 'Amount', w: 104, align: 'right' },
  ];

  const rows = lines.map((l, i) => ({
    no: String(i + 1),
    name: l.name,
    qty: `${qtyFmt(l.qty)} ${l.unit || ''}`.trim(),
    rate: fmt(l.rate),
    disc: String(l.discPct || 0),
    amount: fmt(l.total),
  }));

  const subtotal = lines.reduce((a, l) => a + (+l.total || 0), 0);
  const noRound = Math.abs(inv.roundOff || 0) < 0.005;
  const totals = [];
  if (!noRound) {
    totals.push({ label: 'Sub total', value: fmt(subtotal) });
    totals.push({ label: 'Round off', value: fmt(inv.roundOff) });
  }
  totals.push({ label: 'Total', value: `₹${fmt(inv.total)}`, big: true });
  totals.push({ label: `Paid${inv.payMode ? ` (${inv.payMode})` : ''}`, value: fmt(inv.paid) });
  if (inv.due > 0) totals.push({ label: 'Balance due', value: fmt(inv.due), strong: true });

  return {
    title: 'INVOICE',
    cancelled: inv.status === 'cancelled',
    shop: { name: settings.shopName || '', address: settings.address || '', phone: settings.phone || '' },
    meta: { no: inv.no, date: fmtDate(inv.date) },
    customer: { name: inv.partyName || 'Walk-in Customer', address: inv.partyAddress || '', phone: inv.partyPhone || '' },
    columns,
    rows,
    totals,
    words: rupeesInWords(inv.total),
    terms: settings.terms || '',
  };
}

/**
 * Lay the bill out. Returns one array of draw commands per page; every page is PAGE.w x PAGE.h.
 * measure(text, fontString) must return the text width in px.
 */
export function layoutInvoice(model, measure) {
  const { w: PW, h: PH, margin: M } = PAGE;
  const CW = PW - M * 2;
  const R = PW - M;
  const LIMIT = PH - M - 18; // lowest y for content; the page number sits below it
  const PAD = 5;
  const LH = 16;
  const BODY = 12.5;

  const text = (cmds, x, y, s, fnt, color = INK, align = 'left') => {
    if (s !== '' && s != null) cmds.push({ k: 'text', x, y, s: String(s), font: fnt, color, align });
  };
  const line = (cmds, x1, y1, x2, y2, color = GRID, w = 1) => cmds.push({ k: 'line', x1, y1, x2, y2, color, w });
  const fill = (cmds, x, y, w, h, color) => cmds.push({ k: 'rect', x, y, w, h, fill: color });

  const wrap = (str, fnt, maxW) => {
    const out = [];
    for (const para of String(str ?? '').split('\n')) {
      let cur = '';
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const trial = cur ? `${cur} ${word}` : word;
        if (measure(trial, fnt) <= maxW) { cur = trial; continue; }
        if (cur) { out.push(cur); cur = ''; }
        let chunk = ''; // one word wider than the line: break it by letters
        for (const ch of word) {
          if (chunk && measure(chunk + ch, fnt) > maxW) { out.push(chunk); chunk = ch; } else chunk += ch;
        }
        cur = chunk;
      }
      if (cur) out.push(cur);
    }
    return out;
  };
  const fitSize = (str, size, weight, maxW) => {
    let s = size;
    while (s > 8 && measure(str, font(s, weight)) > maxW) s -= 0.5;
    return s;
  };

  // ----- table geometry -----
  const cols = model.columns;
  const fixed = cols.reduce((a, c) => a + c.w, 0);
  const colW = cols.map((c) => c.w || CW - fixed);
  const colX = [];
  let acc = M;
  for (const w of colW) { colX.push(acc); acc += w; }
  const cellX = (i, align) => (align === 'right' ? colX[i] + colW[i] - PAD : colX[i] + PAD);

  const prepared = model.rows.map((r) => {
    let maxLines = 1;
    const cells = cols.map((c, i) => {
      const str = r[c.key] ?? '';
      const maxW = colW[i] - PAD * 2;
      if (c.wrap) {
        const ls = wrap(str, font(BODY), maxW);
        maxLines = Math.max(maxLines, ls.length);
        return { lines: ls.length ? ls : [''], size: BODY };
      }
      return { lines: [str], size: fitSize(str, BODY, 400, maxW) };
    });
    return { cells, h: maxLines * LH + 10 };
  });

  // ----- blocks (each returns absolute-positioned commands and where it ends) -----
  function fullHeader(y0) {
    const cmds = [];
    let y = y0;
    const leftW = 440;
    const nameFont = font(24, 700);
    for (const ln of wrap(model.shop.name, nameFont, leftW)) { text(cmds, M, y, ln, nameFont); y += 30; }
    for (const ln of wrap(model.shop.address, font(12.5), leftW)) { text(cmds, M, y, ln, font(12.5), SOFT); y += 17; }
    if (model.shop.phone) { text(cmds, M, y, `Phone: ${model.shop.phone}`, font(12.5), SOFT); y += 17; }
    let ry = y0;
    text(cmds, R, ry, model.title, font(22, 700), INK, 'right'); ry += 31;
    text(cmds, R, ry, `Invoice no: ${model.meta.no}`, font(13, 700), INK, 'right'); ry += 20;
    text(cmds, R, ry, `Date: ${model.meta.date}`, font(13), INK, 'right'); ry += 20;
    const bottom = Math.max(y, ry) + 6;
    line(cmds, M, bottom, R, bottom, INK, 1.5);
    return { cmds, bottom };
  }

  function compactHeader() {
    const cmds = [];
    text(cmds, M, M, model.shop.name, font(15, 700));
    text(cmds, R, M + 1, `${model.title}  ${model.meta.no}`, font(13, 700), INK, 'right');
    line(cmds, M, M + 26, R, M + 26, INK, 1.5);
    return { cmds, bottom: M + 36 };
  }

  function billTo(y0) {
    const cmds = [];
    let y = y0 + 8;
    text(cmds, M, y, 'Bill to', font(11), MUTED); y += 16;
    const nameFont = font(17, 700); // the customer's name is the bold line on the bill
    for (const ln of wrap(model.customer.name, nameFont, 440)) { text(cmds, M, y, ln, nameFont); y += 22; }
    for (const ln of wrap(model.customer.address, font(12.5), 440)) { text(cmds, M, y, ln, font(12.5), SOFT); y += 17; }
    if (model.customer.phone) { text(cmds, M, y, `Phone: ${model.customer.phone}`, font(12.5), SOFT); y += 17; }
    return { cmds, bottom: y };
  }

  function tableHeader(y0) {
    const cmds = [];
    const h = 26;
    fill(cmds, M, y0, CW, h, HEAD_BG);
    line(cmds, M, y0, R, y0);
    line(cmds, M, y0 + h, R, y0 + h);
    cols.forEach((c, i) => {
      const size = fitSize(c.head, 11.5, 700, colW[i] - PAD * 2);
      text(cmds, cellX(i, c.align), y0 + (h - size) / 2 - 1, c.head, font(size, 700), INK, c.align);
      line(cmds, colX[i], y0, colX[i], y0 + h);
    });
    line(cmds, R, y0, R, y0 + h);
    return { cmds, bottom: y0 + h };
  }

  function drawRow(page, row) {
    const y = page.y;
    row.cells.forEach((cell, i) => {
      const c = cols[i];
      const yo = (BODY - cell.size) / 2;
      cell.lines.forEach((s, j) => text(page.cmds, cellX(i, c.align), y + 5 + yo + j * LH, s, font(cell.size), INK, c.align));
    });
    const bottom = y + row.h;
    line(page.cmds, M, bottom, R, bottom);
    colX.forEach((x) => line(page.cmds, x, y, x, bottom));
    line(page.cmds, R, y, R, bottom);
    page.y = bottom;
    page.fresh = false;
  }

  function summary(y0) {
    const cmds = [];
    const tw = 250;
    const tx = R - tw;
    let ry = y0;
    for (const t of model.totals) {
      if (t.big) {
        line(cmds, tx, ry + 2, R, ry + 2, INK, 1.5);
        text(cmds, tx, ry + 9, t.label, font(16, 700));
        text(cmds, R, ry + 8, t.value, font(18, 700), INK, 'right');
        ry += 36;
      } else {
        const weight = t.strong ? 700 : 400;
        text(cmds, tx, ry, t.label, font(13, weight));
        text(cmds, R, ry, t.value, font(13, weight), INK, 'right');
        ry += 22;
      }
    }
    return { cmds, h: ry - y0 };
  }

  function words(y0) {
    const cmds = [];
    text(cmds, M, y0, 'Amount in words', font(11), MUTED);
    let y = y0 + 16;
    for (const ln of wrap(model.words, font(13, 700), CW)) { text(cmds, M, y, ln, font(13, 700)); y += 18; }
    return { cmds, h: y - y0 };
  }

  function bottomBlock(y0) {
    const cmds = [];
    let y = y0;
    const termLines = wrap(model.terms, font(11), 450).slice(0, 10);
    if (termLines.length) {
      text(cmds, M, y, 'Terms', font(11), MUTED); y += 15;
      for (const ln of termLines) { text(cmds, M, y, ln, font(11), SOFT); y += 15; }
    }
    const forText = `For ${model.shop.name}`;
    const size = fitSize(forText, 12.5, 700, 230);
    text(cmds, R, y0, forText, font(size, 700), INK, 'right');
    line(cmds, R - 190, y0 + 64, R, y0 + 64, INK, 1);
    text(cmds, R, y0 + 68, 'Authorised signatory', font(11), MUTED, 'right');
    return { cmds, h: Math.max(y - y0, 86) };
  }

  // ----- pagination -----
  const pages = [];
  const startPage = (kind) => {
    const cmds = [];
    let y;
    if (kind === 'first') {
      const h = fullHeader(M);
      cmds.push(...h.cmds);
      const b = billTo(h.bottom);
      cmds.push(...b.cmds);
      y = b.bottom + 10;
    } else {
      const h = compactHeader();
      cmds.push(...h.cmds);
      y = h.bottom;
    }
    if (kind !== 'footer') {
      const t = tableHeader(y);
      cmds.push(...t.cmds);
      y = t.bottom;
    }
    return { cmds, y, fresh: true };
  };

  let page = startPage('first');
  for (const row of prepared) {
    if (page.y + row.h > LIMIT && !page.fresh) { pages.push(page); page = startPage('rows'); }
    drawRow(page, row);
  }

  const S = summary(0).h;
  const W = words(0).h;
  const B = bottomBlock(0).h;
  const bottomY = LIMIT - B;
  if (page.y + 14 + S + 10 + W + 10 > bottomY) { pages.push(page); page = startPage('footer'); }
  let y = page.y + 14;
  page.cmds.push(...summary(y).cmds);
  y += S + 10;
  page.cmds.push(...words(y).cmds);
  page.cmds.push(...bottomBlock(bottomY).cmds);
  pages.push(page);

  return pages.map((p, i) => {
    const cmds = p.cmds;
    if (pages.length > 1) text(cmds, PW / 2, PH - M - 10, `Page ${i + 1} of ${pages.length}`, font(10), MUTED, 'center');
    if (model.cancelled) cmds.push({ k: 'stamp', text: 'CANCELLED', x: PW / 2, y: PH / 2, size: 96, color: RED });
    return cmds;
  });
}

/** Execute draw commands on a 2d context that is already scaled to PAGE units. */
export function drawCommands(ctx, cmds) {
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAGE.w, PAGE.h);
  ctx.textBaseline = 'top';
  for (const c of cmds) {
    if (c.k === 'text') {
      ctx.font = c.font;
      ctx.fillStyle = c.color;
      ctx.textAlign = c.align;
      ctx.fillText(c.s, c.x, c.y);
    } else if (c.k === 'line') {
      ctx.strokeStyle = c.color;
      ctx.lineWidth = c.w;
      ctx.beginPath();
      ctx.moveTo(c.x1, c.y1);
      ctx.lineTo(c.x2, c.y2);
      ctx.stroke();
    } else if (c.k === 'rect') {
      ctx.fillStyle = c.fill;
      ctx.fillRect(c.x, c.y, c.w, c.h);
    } else if (c.k === 'stamp') {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(-0.5);
      ctx.globalAlpha = 0.18;
      ctx.font = font(c.size, 800);
      ctx.fillStyle = c.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.text, 0, 0);
      ctx.restore();
    }
  }
  ctx.restore();
}

/** Browser only. Returns one canvas per A4 page (portrait, PAGE.w*scale by PAGE.h*scale). */
export function renderInvoicePages(inv, settings, makeCanvas = () => document.createElement('canvas')) {
  const probe = makeCanvas().getContext('2d');
  if (!probe) throw new Error('This browser cannot draw the bill');
  const measure = (s, fnt) => { probe.font = fnt; return probe.measureText(s).width; };
  const pages = layoutInvoice(buildModel(inv, settings), measure);
  return pages.map((cmds) => {
    const canvas = makeCanvas();
    canvas.width = PAGE.w * PAGE.scale;
    canvas.height = PAGE.h * PAGE.scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(PAGE.scale, PAGE.scale);
    drawCommands(ctx, cmds);
    return canvas;
  });
}
