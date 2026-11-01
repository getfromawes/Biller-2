// Shawear UI. Plain ES modules, no build step. Hash-routed single page app.
import * as db from './db.js';
import { UNITS, calcInvoice, fmt, qtyFmt, round2, fmtDate } from './billing.js';
import { renderInvoicePages } from './invoice-view.js';
import { buildPdf } from './pdf.js';

// ---------- small helpers ----------
const $ = (sel, scope = document) => scope.querySelector(sel);
const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const view = () => $('#app');
const money = (n) => `₹${fmt(n)}`;
const num = (v) => parseFloat(v) || 0;
const byName = (a, b) => a.name.localeCompare(b.name);

const hay = (it) => `${it.name} ${it.brand || ''} ${it.code || ''}`.toLowerCase();
const matchItem = (it, q) => q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay(it).includes(t));
const priceFor = (it, level) => it.prices?.[level] || it.prices?.retail || 0;
const itemLabel = (it) => it.name + (it.brand ? ` (${it.brand})` : '');
const unitsOf = (it) => [{ unit: it.unit, factor: 1 }, ...(it.altUnits || [])];


function waLink(phone, text) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) d = `91${d}`;
  return `https://wa.me/${d}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const store = {
  get(k, d) { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
};

let settings = {};
let cart = null; // the bill being written; survives moving between screens

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(html) {
  const m = $('#modal');
  m.innerHTML = html;
  if (typeof m.showModal === 'function') { if (!m.open) m.showModal(); } else m.setAttribute('open', '');
  return m;
}
function closeModal() {
  const m = $('#modal');
  if (typeof m.close === 'function') m.close(); else m.removeAttribute('open');
}

// ---------- router ----------
const routes = {
  dashboard, billing, invoices, invoice: invoiceView, items, parties, party: partyView, settings: settingsView,
};
const navKey = { invoice: 'invoices', party: 'parties' };

export async function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = name || 'dashboard';
  $$('#nav a').forEach((a) => {
    const on = a.dataset.route === (navKey[key] || key);
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  try {
    await (routes[key] || dashboard)(arg);
  } catch (err) {
    console.error(err);
    view().innerHTML = `<div class="notice">Something went wrong: ${esc(err.message)}</div>`;
  }
  window.scrollTo?.(0, 0);
}

// ---------- dashboard ----------
async function dashboard() {
  const [invoiceList, parties, itemList] = await Promise.all([db.all('invoices'), db.all('parties'), db.all('items')]);

  // A new shop sees only the two ways to start.
  if (!invoiceList.length) {
    view().innerHTML = `<div class="start-screen"><div class="start-actions">
      <button class="btn primary big" id="start-party">Add party</button>
      <button class="btn primary big" id="start-bill">Add bill</button>
    </div></div>`;
    $('#start-party').addEventListener('click', () => partyForm({ type: 'customer' }, () => route()));
    $('#start-bill').addEventListener('click', () => { location.hash = '#/billing'; });
    return;
  }

  const active = invoiceList.filter((i) => i.status !== 'cancelled');
  const todays = active.filter((i) => i.date === db.todayISO());
  const sales = todays.reduce((a, i) => a + i.total, 0);
  const owing = parties.filter((p) => p.balance > 0).sort((a, b) => b.balance - a.balance);
  const receivable = owing.reduce((a, p) => a + p.balance, 0);
  const low = itemList.filter((i) => i.minStock > 0 && i.stock <= i.minStock).sort(byName);
  const recent = [...active].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);

  view().innerHTML = `
    <div class="page-head"><h1>${esc(settings.shopName)}</h1></div>
    ${settings.configured ? '' : '<div class="notice">Add your shop name and address so bills print correctly. <a href="#/settings">Open settings</a></div>'}
    ${itemList.length ? '' : '<div class="notice">No items yet. <button class="btn small" id="demo">Load sample hardware items</button> or <a href="#/items">add your own</a>.</div>'}
    <div class="stats">
      <div class="stat"><span>Sales today</span><b>${money(sales)}</b><small>${todays.length} bill${todays.length === 1 ? '' : 's'}</small></div>
      <div class="stat"><span>To collect from customers</span><b>${money(receivable)}</b><small>${owing.length} customer${owing.length === 1 ? '' : 's'} owe you</small></div>
      <div class="stat"><span>Low stock items</span><b>${low.length}</b><small>at or below the minimum</small></div>
    </div>
    <div class="two-col">
      <section class="card"><h2>Low stock</h2>
        ${low.slice(0, 8).map((i) => `<div class="list-row"><span>${esc(itemLabel(i))}</span><b class="neg">${qtyFmt(i.stock)} ${esc(i.unit)}</b></div>`).join('') || '<div class="empty">Nothing is running low.</div>'}
      </section>
      <section class="card"><h2>Customers who owe you</h2>
        ${owing.slice(0, 8).map((p) => `<div class="list-row"><a href="#/party/${p.id}">${esc(p.name)}</a><b>${money(p.balance)}</b></div>`).join('') || '<div class="empty">No pending payments.</div>'}
      </section>
    </div>
    <section class="card"><h2>Recent bills</h2>
      ${recent.length ? `<div class="table-wrap" style="margin:0"><table><tbody>${recent.map((i) => `
        <tr class="clickable" data-go="#/invoice/${i.id}"><td>${esc(i.no)}</td><td>${fmtDate(i.date)}</td><td>${esc(i.partyName)}</td><td class="num">${money(i.total)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No bills yet. Your first bill will show up here.</div>'}
    </section>`;

  $('#demo')?.addEventListener('click', async () => {
    await db.seedDemo();
    toast('Sample items and customers added');
    route();
  });
  $$('[data-go]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.go; }));
}

// ---------- items ----------
async function items() {
  const list = (await db.all('items')).sort(byName);
  view().innerHTML = `
    <div class="page-head"><h1>Items</h1><div class="actions"><button class="btn primary" id="add">Add item</button></div></div>
    <input id="q" class="search" placeholder="Search by name, brand, size or code" autocomplete="off">
    <div class="table-wrap"><table>
      <thead><tr><th>Item</th><th>Code</th><th class="num">Stock</th><th class="num">Retail price</th><th></th></tr></thead>
      <tbody id="rows"></tbody></table></div>`;

  const draw = () => {
    const q = $('#q').value.trim();
    const shown = q ? list.filter((i) => matchItem(i, q)) : list;
    $('#rows').innerHTML = shown.map((i) => {
      const low = i.minStock > 0 && i.stock <= i.minStock;
      return `<tr data-id="${i.id}">
        <td><b>${esc(i.name)}</b>${i.brand ? `<div class="muted small">${esc(i.brand)}</div>` : ''}</td>
        <td>${esc(i.code)}</td>
        <td class="num">${qtyFmt(i.stock)} ${esc(i.unit)} ${low ? '<span class="tag low">Low</span>' : ''}</td>
        <td class="num">${money(i.prices?.retail)} / ${esc(i.unit)}</td>
        <td class="num"><button class="btn small" data-act="stock">Stock in</button> <button class="btn small" data-act="edit">Edit</button></td></tr>`;
    }).join('') || `<tr><td colspan="5" class="empty">${list.length ? 'No item matches your search.' : 'No items yet. Add your first item.'}</td></tr>`;
  };
  draw();

  $('#q').addEventListener('input', draw);
  $('#add').addEventListener('click', () => itemForm({}, items));
  $('#rows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const it = list.find((i) => i.id === btn.closest('tr').dataset.id);
    if (btn.dataset.act === 'edit') itemForm(it, items);
    else stockInForm(it);
  });
}

function itemForm(it, after) {
  const alt = it.altUnits || [];
  const p = it.prices || {};
  const m = openModal(`
    <h2>${it.id ? 'Edit item' : 'Add item'}</h2>
    <form id="f" class="form">
      <label class="c6">Name and size *<input name="name" value="${esc(it.name)}" placeholder="e.g. Wire nails 2 inch" required></label>
      <label class="c3">Brand<input name="brand" value="${esc(it.brand)}"></label>
      <label class="c3">Item code<input name="code" value="${esc(it.code)}"></label>
      <datalist id="units">${UNITS.map((u) => `<option value="${u}">`).join('')}</datalist>
      <h3>Units</h3>
      <label class="c2">Base unit (stock is kept in this)<input name="unit" list="units" value="${esc(it.unit || 'pcs')}"></label>
      <label class="c2">Also sold as<input name="alt1" list="units" value="${esc(alt[0]?.unit)}" placeholder="e.g. box"></label>
      <label class="c2">Base units in it<input name="altf1" type="number" step="any" min="0" value="${alt[0]?.factor ?? ''}" placeholder="e.g. 5"></label>
      <label class="c2">Also sold as<input name="alt2" list="units" value="${esc(alt[1]?.unit)}"></label>
      <label class="c2">Base units in it<input name="altf2" type="number" step="any" min="0" value="${alt[1]?.factor ?? ''}"></label>
      <h3>Prices per base unit (₹)</h3>
      <label class="c2">Retail<input name="p_retail" type="number" step="0.01" min="0" value="${p.retail ?? ''}"></label>
      <label class="c2">Contractor<input name="p_contractor" type="number" step="0.01" min="0" value="${p.contractor ?? ''}"></label>
      <label class="c2">Wholesale<input name="p_wholesale" type="number" step="0.01" min="0" value="${p.wholesale ?? ''}"></label>
      <label class="c2">Your cost<input name="cost" type="number" step="0.01" min="0" value="${it.cost ?? ''}"></label>
      <label class="c2">Stock now<input name="stock" type="number" step="any" value="${it.stock ?? 0}"></label>
      <label class="c2">Warn me below<input name="minStock" type="number" step="any" min="0" value="${it.minStock ?? 0}"></label>
      <div class="btns">
        ${it.id ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}
        <button type="button" class="btn" id="cancel">Cancel</button>
        <button class="btn primary">Save item</button>
      </div>
    </form>`);
  $('[name=name]', m).focus();
  $('#cancel', m).onclick = closeModal;
  if (it.id) {
    $('#del', m).onclick = async () => {
      if (!confirm(`Delete ${it.name}? Past bills keep their copy of this item.`)) return;
      await db.remove('items', it.id);
      closeModal(); toast('Item deleted'); after();
    };
  }
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const v = (k) => (fd.get(k) ?? '').toString().trim();
    const altUnits = [1, 2].map((n) => ({ unit: v(`alt${n}`), factor: num(v(`altf${n}`)) })).filter((a) => a.unit && a.factor > 0);
    const obj = {
      id: it.id || db.uid(), name: v('name'), brand: v('brand'), code: v('code'),
      unit: v('unit') || 'pcs', altUnits,
      prices: { retail: num(v('p_retail')), contractor: num(v('p_contractor')), wholesale: num(v('p_wholesale')) },
      cost: num(v('cost')), stock: num(v('stock')), minStock: num(v('minStock')),
      createdAt: it.createdAt || Date.now(), updatedAt: Date.now(),
    };
    if (!obj.name) return toast('Enter the item name');
    await db.put('items', obj);
    closeModal(); toast('Item saved'); after();
  };
}

async function stockInForm(it) {
  const suppliers = (await db.all('parties')).filter((p) => p.type !== 'customer').sort(byName);
  const m = openModal(`
    <h2>Stock in: ${esc(itemLabel(it))}</h2>
    <p class="muted">Now in stock: ${qtyFmt(it.stock)} ${esc(it.unit)}</p>
    <form id="f" class="form">
      <label class="c3">Quantity received<input name="qty" type="number" step="any" min="0" required></label>
      <label class="c3">Unit<select name="unit">${unitsOf(it).map((u) => `<option value="${esc(u.unit)}">${esc(u.unit)}</option>`).join('')}</select></label>
      <label class="c3">Purchase price per unit (₹)<input name="cost" type="number" step="0.01" min="0"></label>
      <label class="c3">Supplier<select name="partyId"><option value="">No supplier</option>${suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="c3">Bill amount (₹)<input name="billAmount" type="number" step="0.01" min="0"></label>
      <label class="c3">Paid now (₹)<input name="paid" type="number" step="0.01" min="0"></label>
      <div class="btns"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Add stock</button></div>
    </form>`);
  $('[name=qty]', m).focus();
  $('#cancel', m).onclick = closeModal;
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const unit = unitsOf(it).find((u) => u.unit === fd.get('unit')) || { factor: 1 };
    try {
      await db.addStock({
        itemId: it.id, qty: num(fd.get('qty')), factor: unit.factor, cost: num(fd.get('cost')),
        partyId: fd.get('partyId'), billAmount: num(fd.get('billAmount')), paid: num(fd.get('paid')),
      });
      closeModal(); toast('Stock added'); items();
    } catch (err) { toast(err.message); }
  };
}

// ---------- parties ----------
async function parties() {
  const list = (await db.all('parties')).sort(byName);
  view().innerHTML = `
    <div class="page-head"><h1>Parties</h1><div class="actions"><button class="btn primary" id="add">Add customer or supplier</button></div></div>
    <div class="inline">
      <input id="q" class="search" style="margin:0" placeholder="Search by name or phone" autocomplete="off">
      <select id="type"><option value="">Everyone</option><option value="customer">Customers</option><option value="supplier">Suppliers</option><option value="owing">Customers who owe you</option></select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Phone</th><th>Type</th><th class="num">Balance</th></tr></thead><tbody id="rows"></tbody></table></div>`;

  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const t = $('#type').value;
    const shown = list.filter((p) => (!q || `${p.name} ${p.phone}`.toLowerCase().includes(q))
      && (!t || (t === 'owing' ? p.balance > 0 : p.type === t || p.type === 'both')));
    $('#rows').innerHTML = shown.map((p) => `
      <tr class="clickable" data-id="${p.id}"><td><b>${esc(p.name)}</b></td><td>${esc(p.phone)}</td><td>${esc(p.type)}</td>
      <td class="num ${p.balance > 0 ? 'neg' : p.balance < 0 ? 'pos' : ''}">${p.balance ? `${money(Math.abs(p.balance))} ${p.balance > 0 ? 'to receive' : 'to pay'}` : '-'}</td></tr>`).join('')
      || `<tr><td colspan="4" class="empty">${list.length ? 'No one matches.' : 'No customers or suppliers yet.'}</td></tr>`;
  };
  draw();
  $('#q').addEventListener('input', draw);
  $('#type').addEventListener('change', draw);
  $('#add').addEventListener('click', () => partyForm({}, parties));
  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/party/${tr.dataset.id}`;
  });
}

function partyForm(p, after) {
  const m = openModal(`
    <h2>${p.id ? 'Edit party' : 'Add customer or supplier'}</h2>
    <form id="f" class="form">
      <label class="c4">Name *<input name="name" value="${esc(p.name)}" required></label>
      <label class="c2">Phone<input name="phone" value="${esc(p.phone)}" inputmode="tel"></label>
      <label class="c2">Type<select name="type">${['customer', 'supplier', 'both'].map((t) => `<option value="${t}" ${t === (p.type || 'customer') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="c4">Address<input name="address" value="${esc(p.address)}"></label>
      <label class="c3">Credit limit (₹, 0 = no limit)<input name="creditLimit" type="number" min="0" step="1" value="${p.creditLimit ?? 0}"></label>
      ${p.id ? '' : '<label class="c3">Opening balance (₹; positive if they owe you)<input name="openingBalance" type="number" step="0.01" value="0"></label>'}
      <div class="btns"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Save</button></div>
    </form>`);
  $('[name=name]', m).focus();
  $('#cancel', m).onclick = closeModal;
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const v = (k) => (fd.get(k) ?? '').toString().trim();
    const opening = num(v('openingBalance'));
    const obj = {
      ...p, id: p.id || db.uid(), name: v('name'), phone: v('phone'), type: v('type'),
      address: v('address'), creditLimit: num(v('creditLimit')),
      createdAt: p.createdAt || Date.now(),
    };
    delete obj.gstin; // older saved customers may still carry these
    delete obj.state;
    if (!p.id) { obj.openingBalance = opening; obj.balance = opening; }
    await db.put('parties', obj);
    closeModal(); toast('Saved'); after(obj);
  };
}

async function partyView(id) {
  const p = await db.get('parties', id);
  if (!p) { view().innerHTML = '<div class="empty">This party was not found. <a href="#/parties">Back to parties</a></div>'; return; }
  const [invoiceList, payments, stockLog] = await Promise.all([db.all('invoices'), db.all('payments'), db.all('stockLog')]);

  const rows = [{ ts: 0, date: '', desc: 'Opening balance', debit: Math.max(p.openingBalance || 0, 0), credit: Math.max(-(p.openingBalance || 0), 0) }];
  for (const i of invoiceList.filter((x) => x.partyId === id && x.status !== 'cancelled')) {
    rows.push({ ts: i.createdAt, date: i.date, desc: `Invoice ${i.no}`, link: `#/invoice/${i.id}`, debit: i.total, credit: i.paid });
  }
  for (const x of payments.filter((y) => y.partyId === id)) {
    rows.push({ ts: x.createdAt, date: x.date, desc: `${x.direction === 'in' ? 'Payment received' : 'Payment made'} (${x.mode})${x.note ? `, ${x.note}` : ''}`, debit: x.direction === 'out' ? x.amount : 0, credit: x.direction === 'in' ? x.amount : 0 });
  }
  for (const s of stockLog.filter((y) => y.partyId === id && y.billAmount > 0)) {
    rows.push({ ts: s.createdAt, date: s.date, desc: `Purchase: ${s.itemName}`, debit: s.paid, credit: s.billAmount });
  }
  rows.sort((a, b) => a.ts - b.ts);
  let run = 0;
  for (const r of rows) { run = round2(run + r.debit - r.credit); r.run = run; }

  const isCustomer = p.type !== 'supplier';
  const isSupplier = p.type !== 'customer';
  const reminder = `Dear ${p.name}, your pending balance at ${settings.shopName} is ₹${fmt(p.balance)}. Please pay at your earliest convenience. Thank you.`;

  view().innerHTML = `
    <div class="page-head"><div><a href="#/parties" class="small">All parties</a><h1>${esc(p.name)}</h1>
      <div class="muted">${esc(p.phone)}</div></div>
      <div class="actions">
        ${isCustomer ? '<button class="btn primary" id="recv">Receive payment</button>' : ''}
        ${isSupplier ? '<button class="btn" id="pay">Pay supplier</button>' : ''}
        ${p.balance > 0 && p.phone ? `<a class="btn" target="_blank" rel="noopener" href="${waLink(p.phone, reminder)}">WhatsApp reminder</a>` : ''}
        <button class="btn" id="edit">Edit</button>
      </div></div>
    <div class="stats"><div class="stat"><span>${p.balance < 0 ? 'You owe them' : 'They owe you'}</span><b>${money(Math.abs(p.balance || 0))}</b>${p.creditLimit ? `<small>Credit limit ${money(p.creditLimit)}</small>` : ''}</div></div>
    <div class="table-wrap"><table>
      <thead><tr><th>Date</th><th>Details</th><th class="num">They owe more</th><th class="num">They paid</th><th class="num">Balance</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${r.date ? fmtDate(r.date) : ''}</td>
        <td>${r.link ? `<a href="${r.link}">${esc(r.desc)}</a>` : esc(r.desc)}</td>
        <td class="num">${r.debit ? fmt(r.debit) : ''}</td><td class="num">${r.credit ? fmt(r.credit) : ''}</td><td class="num"><b>${fmt(r.run)}</b></td></tr>`).join('')}</tbody></table></div>`;

  $('#recv')?.addEventListener('click', () => paymentForm(p, 'in'));
  $('#pay')?.addEventListener('click', () => paymentForm(p, 'out'));
  $('#edit').addEventListener('click', () => partyForm(p, () => partyView(id)));
}

function paymentForm(p, direction) {
  const m = openModal(`
    <h2>${direction === 'in' ? 'Receive payment from' : 'Pay'} ${esc(p.name)}</h2>
    <form id="f" class="form">
      <label class="c3">Amount (₹)<input name="amount" type="number" step="0.01" min="0" value="${direction === 'in' && p.balance > 0 ? p.balance : ''}" required></label>
      <label class="c3">Mode<select name="mode"><option>cash</option><option>upi</option><option>bank</option><option>cheque</option></select></label>
      <label class="c3">Date<input name="date" type="date" value="${db.todayISO()}"></label>
      <label class="c3">Note<input name="note"></label>
      <div class="btns"><button type="button" class="btn" id="cancel">Cancel</button><button class="btn primary">Save payment</button></div>
    </form>`);
  $('[name=amount]', m).focus();
  $('#cancel', m).onclick = closeModal;
  $('#f', m).onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await db.recordPayment({ partyId: p.id, amount: num(fd.get('amount')), direction, mode: fd.get('mode'), date: fd.get('date'), note: fd.get('note') });
      closeModal(); toast('Payment saved'); partyView(p.id);
    } catch (err) { toast(err.message); }
  };
}

// ---------- billing ----------
const newCart = () => ({ partyId: '', level: 'retail', lines: [], payMode: 'cash', paid: 0, paidTouched: false });

async function billing() {
  cart ??= newCart();
  const [itemList, partyList] = await Promise.all([db.all('items'), db.all('parties')]);
  const itemMap = new Map(itemList.map((i) => [i.id, i]));
  const customers = partyList.filter((p) => p.type !== 'supplier').sort(byName);

  view().innerHTML = `
    <div class="page-head"><h1>New bill</h1><div class="actions"><button class="btn" id="clear">Clear bill</button></div></div>
    ${itemList.length ? '' : '<div class="notice">Add items first on the <a href="#/items">Items</a> screen, or load sample items in <a href="#/settings">Settings</a>.</div>'}
    <div class="bill-grid">
      <section class="card">
        <div class="row2">
          <label>Customer
            <select id="party"><option value="">Walk-in customer</option>${customers.map((p) => `<option value="${p.id}" ${p.id === cart.partyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
          </label>
          <label>Price level
            <select id="level">${['retail', 'contractor', 'wholesale'].map((l) => `<option value="${l}" ${l === cart.level ? 'selected' : ''}>${l}</option>`).join('')}</select>
          </label>
        </div>
        <div class="muted small" id="partyinfo"></div>
        <div style="margin-top:6px"><button class="btn small" id="newparty">Add new customer</button></div>
        <div class="searchbox">
          <input id="isearch" class="search" placeholder="Type item name, size or code. Enter adds the top match." autocomplete="off">
          <div id="results" class="results" hidden></div>
        </div>
        <div class="table-wrap" style="margin:0"><table class="cart">
          <thead><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit</th><th>Rate (₹)</th><th>Disc %</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody id="cartrows"></tbody></table></div>
      </section>
      <aside class="card totals">
        <div id="totals"></div>
        <label>Payment mode
          <select id="mode">${['cash', 'upi', 'card', 'credit'].map((m) => `<option value="${m}" ${m === cart.payMode ? 'selected' : ''}>${m === 'credit' ? 'credit (udhaar)' : m}</option>`).join('')}</select>
        </label>
        <label>Amount received (₹)<input id="paid" type="number" step="0.01" min="0"></label>
        <div class="muted small" id="due" style="margin:6px 0 12px"></div>
        <button class="btn primary big" id="save">Save and print</button>
      </aside>
    </div>`;

  const currentCalc = () => {
    const party = partyList.find((p) => p.id === cart.partyId);
    return { party, calc: calcInvoice(cart.lines) };
  };

  function renderTotals() {
    const { party, calc } = currentCalc();
    $$('#cartrows tr[data-i]').forEach((tr, i) => {
      const l = calc.lines[i];
      const it = itemMap.get(l.itemId);
      $('[data-amt]', tr).textContent = fmt(l.total);
      $('[data-warn]', tr).textContent = it && l.qty * l.factor > it.stock ? `Only ${qtyFmt(it.stock)} ${it.unit} in stock` : '';
    });
    $('#totals').innerHTML = `<div>${calc.roundOff ? `<div><span>Sub total</span><b>${fmt(calc.subtotal)}</b></div><div><span>Round off</span><b>${fmt(calc.roundOff)}</b></div>` : ''}<div class="grand"><span>Total</span><b>${money(calc.total)}</b></div></div>`;
    if (!cart.paidTouched) {
      cart.paid = cart.payMode === 'credit' ? 0 : calc.total;
      $('#paid').value = cart.paid;
    }
    $('#due').textContent = `Balance due on this bill: ${money(Math.max(calc.total - (+cart.paid || 0), 0))}`;
    $('#partyinfo').textContent = party
      ? `Owes you ${money(party.balance || 0)} so far. ${party.creditLimit ? `Credit limit ${money(party.creditLimit)}.` : ''}`
      : 'Walk-in customer. The bill must be paid in full.';
  }

  function renderRows() {
    $('#cartrows').innerHTML = cart.lines.map((l, i) => {
      const it = itemMap.get(l.itemId);
      const units = it ? unitsOf(it) : [{ unit: l.unit, factor: l.factor }];
      return `<tr data-i="${i}">
        <td>${i + 1}</td>
        <td>${esc(l.name)}<div class="warn" data-warn></div></td>
        <td><input type="number" class="w70" min="0" step="any" value="${l.qty}" data-f="qty" aria-label="Quantity"></td>
        <td><select data-f="unit" aria-label="Unit">${units.map((u) => `<option value="${esc(u.unit)}" ${u.unit === l.unit ? 'selected' : ''}>${esc(u.unit)}</option>`).join('')}</select></td>
        <td><input type="number" class="w90" min="0" step="0.01" value="${l.rate}" data-f="rate" aria-label="Rate"></td>
        <td><input type="number" class="w60" min="0" max="100" step="0.5" value="${l.discPct || 0}" data-f="discPct" aria-label="Discount percent"></td>
        <td class="num" data-amt></td>
        <td><button class="icon" data-rm title="Remove item" aria-label="Remove item">✕</button></td></tr>`;
    }).join('') || '<tr><td colspan="8" class="empty">Search above and add items to start the bill.</td></tr>';
    renderTotals();
  }

  function addLine(it) {
    const same = cart.lines.find((l) => l.itemId === it.id && l.factor === 1);
    if (same) same.qty += 1;
    else cart.lines.push({ itemId: it.id, name: itemLabel(it), unit: it.unit, factor: 1, qty: 1, rate: priceFor(it, cart.level), discPct: 0 });
    matches = []; hi = 0;
    $('#isearch').value = '';
    drawResults();
    renderRows();
    $('#isearch').focus();
  }

  // item search box
  let matches = [];
  let hi = 0;
  function drawResults() {
    const box = $('#results');
    box.hidden = !matches.length;
    box.innerHTML = matches.map((it, i) => `
      <div class="result ${i === hi ? 'hi' : ''}" data-id="${it.id}">
        <span><b>${esc(it.name)}</b> <span class="muted">${esc(it.brand || '')}</span></span>
        <span class="r">${money(priceFor(it, cart.level))} per ${esc(it.unit)}, stock ${qtyFmt(it.stock)}</span></div>`).join('');
  }
  $('#isearch').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    matches = q ? itemList.filter((it) => matchItem(it, q)).slice(0, 8) : [];
    hi = 0;
    drawResults();
  });
  $('#isearch').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hi = Math.min(hi + 1, matches.length - 1); drawResults(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hi = Math.max(hi - 1, 0); drawResults(); e.preventDefault(); }
    else if (e.key === 'Enter' && matches[hi]) { addLine(matches[hi]); e.preventDefault(); }
    else if (e.key === 'Escape') { matches = []; drawResults(); }
  });
  $('#results').addEventListener('click', (e) => {
    const r = e.target.closest('.result');
    if (r) addLine(itemMap.get(r.dataset.id));
  });

  // cart row edits
  $('#cartrows').addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f || f === 'unit') return;
    cart.lines[+e.target.closest('tr').dataset.i][f] = num(e.target.value);
    renderTotals();
  });
  $('#cartrows').addEventListener('change', (e) => {
    if (e.target.dataset.f !== 'unit') return;
    const l = cart.lines[+e.target.closest('tr').dataset.i];
    const it = itemMap.get(l.itemId);
    const u = unitsOf(it).find((x) => x.unit === e.target.value);
    l.unit = u.unit; l.factor = u.factor; l.rate = round2(priceFor(it, cart.level) * u.factor);
    renderRows();
  });
  $('#cartrows').addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (!rm) return;
    cart.lines.splice(+rm.closest('tr').dataset.i, 1);
    renderRows();
  });

  // customer, price level, payment
  $('#party').addEventListener('change', (e) => { cart.partyId = e.target.value; renderTotals(); });
  $('#level').addEventListener('change', (e) => {
    cart.level = e.target.value;
    for (const l of cart.lines) { const it = itemMap.get(l.itemId); if (it) l.rate = round2(priceFor(it, cart.level) * l.factor); }
    renderRows();
  });
  $('#mode').addEventListener('change', (e) => { cart.payMode = e.target.value; cart.paidTouched = false; renderTotals(); });
  $('#paid').addEventListener('input', (e) => { cart.paid = num(e.target.value); cart.paidTouched = true; renderTotals(); });
  $('#newparty').addEventListener('click', () => partyForm({ type: 'customer' }, (np) => { cart.partyId = np.id; billing(); }));
  $('#clear').addEventListener('click', () => {
    if (cart.lines.length && !confirm('Clear this bill?')) return;
    cart = newCart();
    billing();
  });

  $('#save').addEventListener('click', async () => {
    const { party, calc } = currentCalc();
    const lines = calc.lines.filter((l) => l.qty > 0);
    if (!lines.length) return toast('Add at least one item');
    const paid = Math.min(Math.max(+cart.paid || 0, 0), calc.total);
    const due = round2(calc.total - paid);
    if (due > 0 && !party) return toast('Choose a customer for credit or part payment');
    if (party && party.creditLimit > 0 && (party.balance || 0) + due > party.creditLimit
      && !confirm(`This will take ${party.name} over the credit limit of ₹${fmt(party.creditLimit)}. Save anyway?`)) return;
    try {
      const inv = await db.saveInvoice({
        date: db.todayISO(), partyId: party?.id || '', partyName: party?.name || 'Walk-in Customer',
        partyPhone: party?.phone || '', partyAddress: party?.address || '', level: cart.level,
        lines, subtotal: calc.subtotal, roundOff: calc.roundOff,
        total: calc.total, paid, payMode: cart.payMode,
      });
      cart = null;
      toast(`Saved ${inv.no}`);
      location.hash = `#/invoice/${inv.id}`;
    } catch (err) { toast(err.message); }
  });

  renderRows();
  $('#isearch').focus();
}

// ---------- invoices ----------
async function invoices() {
  const list = (await db.all('invoices')).sort((a, b) => b.createdAt - a.createdAt);
  view().innerHTML = `
    <div class="page-head"><h1>Invoices</h1><a class="btn primary" href="#/billing">New bill</a></div>
    <div class="inline">
      <input id="q" class="search" style="margin:0" placeholder="Search by invoice number or customer" autocomplete="off">
      <select id="status"><option value="">All</option><option value="due">With balance due</option><option value="cancelled">Cancelled</option></select>
    </div>
    <div class="table-wrap"><table>
      <thead><tr><th>Invoice</th><th>Date</th><th>Customer</th><th class="num">Amount</th><th class="num">Due</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>`;
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase();
    const s = $('#status').value;
    const shown = list.filter((i) => (!q || `${i.no} ${i.partyName}`.toLowerCase().includes(q))
      && (!s || (s === 'due' ? i.status !== 'cancelled' && i.due > 0 : i.status === 'cancelled')));
    $('#rows').innerHTML = shown.map((i) => `
      <tr class="clickable" data-id="${i.id}"><td><b>${esc(i.no)}</b></td><td>${fmtDate(i.date)}</td><td>${esc(i.partyName)}</td>
      <td class="num">${money(i.total)}</td><td class="num">${i.due > 0 && i.status !== 'cancelled' ? money(i.due) : ''}</td>
      <td>${i.status === 'cancelled' ? '<span class="tag cancelled">Cancelled</span>' : ''}</td></tr>`).join('')
      || `<tr><td colspan="6" class="empty">${list.length ? 'No invoice matches.' : 'No invoices yet.'}</td></tr>`;
  };
  draw();
  $('#q').addEventListener('input', draw);
  $('#status').addEventListener('change', draw);
  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr) location.hash = `#/invoice/${tr.dataset.id}`;
  });
}

function thermalSheet(inv) {
  const s = settings;
  return `<div class="sheet thermal">
    <div class="c"><b>${esc(s.shopName)}</b><br>${esc(s.address)}<br>${s.phone ? `Ph ${esc(s.phone)}` : ''}</div>
    <hr>
    <div class="c"><b>INVOICE</b> ${inv.status === 'cancelled' ? '<span class="stamp">CANCELLED</span>' : ''}</div>
    <div class="t-line"><span>No ${esc(inv.no)}</span><span>${fmtDate(inv.date)}</span></div>
    <div><b>${esc(inv.partyName)}</b></div>
    <hr>
    ${inv.lines.map((l) => `<div>${esc(l.name)}</div><div class="t-line"><span>${qtyFmt(l.qty)} ${esc(l.unit)} x ${fmt(l.rate)}${l.discPct ? ` (-${l.discPct}%)` : ''}</span><span>${fmt(l.total)}</span></div>`).join('')}
    <hr>
    ${Math.abs(inv.roundOff || 0) >= 0.005 ? `<div class="t-line"><span>Round off</span><span>${fmt(inv.roundOff)}</span></div>` : ''}
    <div class="t-line"><b>TOTAL</b><b>${money(inv.total)}</b></div>
    <div class="t-line"><span>Paid (${esc(inv.payMode)})</span><span>${fmt(inv.paid)}</span></div>
    ${inv.due > 0 ? `<div class="t-line"><b>Balance due</b><b>${fmt(inv.due)}</b></div>` : ''}
    <hr>
    <div class="c">Thank you. Visit again.</div>
  </div>`;
}

// ---- sharing the bill as a picture or PDF ----
const canvasToBlob = (canvas, type, quality) => new Promise((resolve, reject) => {
  canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make the picture of the bill'))), type, quality);
});

/** Open the phone's share sheet with the files (WhatsApp is one of its choices). Falls back to saving them. */
async function shareFiles(files, title) {
  const nav = window.navigator;
  if (nav.share && nav.canShare && nav.canShare({ files })) {
    try {
      await nav.share({ files, title });
      return 'shared';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // anything else: fall through and save the files instead
    }
  }
  for (const f of files) download(f.name, f, f.type);
  return 'saved';
}

async function invoiceView(id) {
  const inv = await db.get('invoices', id);
  if (!inv) { view().innerHTML = '<div class="empty">This invoice was not found. <a href="#/invoices">Back to invoices</a></div>'; return; }
  let format = store.get('shawear.printFormat', 'a4');

  // The A4 portrait pages are drawn once; preview, print, picture and PDF all use these same pages.
  let pages = null;
  let drawError = '';
  try { pages = renderInvoicePages(inv, settings); } catch (err) { drawError = err.message; console.error(err); }
  const many = pages && pages.length > 1;
  // Pictures are made ahead of the tap, so the share sheet opens straight from the button press.
  const pictures = pages
    ? Promise.all(pages.map(async (c, i) => new File([await canvasToBlob(c, 'image/png')], `${inv.no}${many ? `-${i + 1}` : ''}.png`, { type: 'image/png' })))
    : null;
  if (pictures) pictures.catch(() => {});

  view().innerHTML = `
    <div class="page-head no-print"><div><a href="#/invoices" class="small">All invoices</a><h1>${esc(inv.no)}</h1></div>
      <div class="actions">
        <select id="fmt" aria-label="Print format" style="width:auto"><option value="a4">A4 page</option><option value="thermal">Thermal 80mm</option></select>
        <button class="btn primary" id="print">Print</button>
        <button class="btn" id="wa" ${pages ? '' : 'disabled'}>Share on WhatsApp</button>
        <button class="btn" id="pdf" ${pages ? '' : 'disabled'}>PDF</button>
        ${inv.status === 'cancelled' ? '' : '<button class="btn danger" id="cancelinv">Cancel invoice</button>'}
        <a class="btn" href="#/billing">New bill</a>
      </div></div>
    <div id="sheet"></div>`;

  const draw = () => {
    const box = $('#sheet');
    box.innerHTML = '';
    if (format === 'thermal') { box.innerHTML = thermalSheet(inv); return; }
    if (!pages) { box.innerHTML = `<div class="notice">The bill could not be drawn: ${esc(drawError)}</div>`; return; }
    pages.forEach((c, i) => {
      c.className = 'bill-page';
      c.setAttribute('role', 'img');
      c.setAttribute('aria-label', `Invoice ${inv.no}, page ${i + 1} of ${pages.length}`);
      box.appendChild(c);
    });
  };
  $('#fmt').value = format;
  draw();
  $('#fmt').addEventListener('change', (e) => { format = e.target.value; store.set('shawear.printFormat', format); draw(); });
  $('#print').addEventListener('click', () => {
    let st = $('#pagesize');
    if (!st) { st = document.createElement('style'); st.id = 'pagesize'; document.head.appendChild(st); }
    st.textContent = format === 'thermal' ? '@page{size:80mm auto;margin:3mm}' : '@page{size:A4 portrait;margin:0}';
    window.print();
  });

  $('#wa').addEventListener('click', async () => {
    try {
      const files = await pictures;
      const result = await shareFiles(files, `${inv.no} - ${settings.shopName}`);
      if (result === 'saved') {
        if (inv.partyPhone) window.open(waLink(inv.partyPhone, ''), '_blank', 'noopener');
        toast('Bill picture saved. Attach it in the WhatsApp chat.');
      }
    } catch (err) { toast(err.message); }
  });

  $('#pdf').addEventListener('click', async () => {
    try {
      const jpegs = await Promise.all(pages.map(async (c) => {
        const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
        return { bytes: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height };
      }));
      const file = new File([buildPdf(jpegs)], `${inv.no}.pdf`, { type: 'application/pdf' });
      const result = await shareFiles([file], `${inv.no} - ${settings.shopName}`);
      if (result === 'saved') toast('PDF saved');
    } catch (err) { toast(err.message); }
  });

  $('#cancelinv')?.addEventListener('click', async () => {
    if (!confirm(`Cancel ${inv.no}? Stock goes back and the unpaid amount comes off the customer's balance. Money already received must be refunded by you.`)) return;
    try { await db.cancelInvoice(id); toast('Invoice cancelled'); invoiceView(id); } catch (err) { toast(err.message); }
  });
}

// ---------- settings ----------
async function settingsView() {
  const s = settings;
  view().innerHTML = `
    <div class="page-head"><h1>Settings</h1></div>
    <section class="card"><h2>Shop details</h2>
      <form id="f" class="form">
        <label class="c4">Shop name<input name="shopName" value="${esc(s.shopName)}" required></label>
        <label class="c2">Phone<input name="phone" value="${esc(s.phone)}" inputmode="tel"></label>
        <label class="c6">Address<input name="address" value="${esc(s.address)}"></label>
        <label class="c2">Invoice prefix<input name="invoicePrefix" value="${esc(s.invoicePrefix)}" maxlength="8"></label>
        <label class="c6">Terms printed on the invoice<textarea name="terms">${esc(s.terms)}</textarea></label>
        <div class="btns"><button class="btn primary">Save settings</button></div>
      </form>
    </section>
    <section class="card"><h2>Your data</h2>
      <p class="muted">Everything is stored on this device, so Shawear works without internet. Take a backup regularly and keep it somewhere safe.</p>
      <div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="export">Download backup</button>
        <label class="btn" style="color:var(--ink);cursor:pointer">Restore from backup<input id="import" type="file" accept="application/json,.json" hidden></label>
        <button class="btn" id="demo">Add sample items</button>
        <button class="btn danger" id="wipe">Erase all data</button>
      </div>
    </section>`;

  $('#f').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const v = (k) => (fd.get(k) ?? '').toString().trim();
    await db.saveSettings({
      ...settings, shopName: v('shopName'), phone: v('phone'), address: v('address'),
      invoicePrefix: v('invoicePrefix') || 'INV', terms: v('terms'), configured: true,
    });
    settings = await db.getSettings();
    toast('Settings saved');
  };
  $('#export').addEventListener('click', async () => {
    download(`shawear-backup-${db.todayISO()}.json`, JSON.stringify(await db.exportAll(), null, 2));
    toast('Backup downloaded');
  });
  $('#import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Restoring replaces everything on this device with the backup. Continue?')) return;
    try {
      await db.importAll(JSON.parse(await file.text()));
      settings = await db.getSettings();
      toast('Backup restored');
      settingsView();
    } catch (err) { toast(err.message); }
  });
  $('#demo').addEventListener('click', async () => { await db.seedDemo(); toast('Sample items and customers added'); });
  $('#wipe').addEventListener('click', async () => {
    if (!confirm('Erase all items, customers and invoices on this device? This cannot be undone.')) return;
    await db.wipeAll();
    settings = await db.getSettings();
    cart = null;
    toast('All data erased');
    settingsView();
  });
}

// ---------- start ----------
function netStatus() {
  const el = $('#netstatus');
  const online = window.navigator.onLine !== false;
  el.textContent = online ? 'Online' : 'Offline, all data is saved on this device';
  el.classList.toggle('offline', !online);
}

async function init() {
  settings = await db.getSettings();
  window.addEventListener('hashchange', route);
  window.addEventListener('online', netStatus);
  window.addEventListener('offline', netStatus);
  netStatus();
  await route();
  if ('serviceWorker' in window.navigator) window.navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
