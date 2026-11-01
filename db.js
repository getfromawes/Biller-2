// Local-first data layer on IndexedDB. Everything works offline.
// Balance convention for parties: positive = they owe the shop, negative = the shop owes them.
import { round2, round3 } from './billing.js';

const DB_NAME = 'shawear';
const DB_VERSION = 1;
export const STORES = ['items', 'parties', 'invoices', 'payments', 'stockLog', 'meta'];

let dbPromise;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, { keyPath: s === 'meta' ? 'key' : 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

// Start a read-write transaction. `finished` settles when it commits or aborts.
async function begin(stores) {
  const db = await openDB();
  const tx = db.transaction(stores, 'readwrite');
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
  finished.catch(() => {}); // avoid unhandled rejection when we throw before awaiting it
  return { tx, finished, store: (name) => tx.objectStore(name) };
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// ---------- basic CRUD ----------

export async function all(store) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, id) {
  const db = await openDB();
  return wrap(db.transaction(store).objectStore(store).get(id));
}

export async function put(store, obj) {
  const { store: s, finished } = await begin([store]);
  s(store).put(obj);
  await finished;
  return obj;
}

export async function remove(store, id) {
  const { store: s, finished } = await begin([store]);
  s(store).delete(id);
  await finished;
}

// ---------- settings ----------

export const DEFAULT_SETTINGS = {
  key: 'settings',
  configured: false,
  shopName: 'My Hardware Store',
  address: '',
  phone: '',
  invoicePrefix: 'INV',
  terms: 'Goods once sold will not be taken back. Subject to local jurisdiction.',
};

export async function getSettings() {
  const s = await get('meta', 'settings');
  const merged = { ...DEFAULT_SETTINGS, ...(s || {}) };
  delete merged.gstin; // older saved settings may still carry these
  delete merged.state;
  delete merged.taxInclusive;
  return merged;
}

export async function saveSettings(s) {
  return put('meta', { ...s, key: 'settings' });
}

// ---------- invoices ----------

/**
 * Save an invoice. In ONE transaction: assign the next invoice number, reduce stock,
 * add the unpaid amount to the customer's balance and store the invoice.
 * draft needs: lines[{itemId, qty, factor}], total, paid, partyId (required if paid < total).
 */
export async function saveInvoice(draft) {
  const due = round2((draft.total || 0) - (draft.paid || 0));
  if (!draft.lines || !draft.lines.length) throw new Error('Add at least one item');
  if (due > 0.009 && !draft.partyId) throw new Error('Select a customer for credit or part payment');

  const { store, finished } = await begin(['items', 'parties', 'invoices', 'meta']);
  const settings = { ...DEFAULT_SETTINGS, ...((await wrap(store('meta').get('settings'))) || {}) };
  const counter = (await wrap(store('meta').get('counter'))) || { key: 'counter', invoice: 0 };
  counter.invoice += 1;
  store('meta').put(counter);

  const inv = {
    ...draft,
    id: uid(),
    no: `${settings.invoicePrefix || 'INV'}-${String(counter.invoice).padStart(4, '0')}`,
    due,
    status: 'active',
    createdAt: Date.now(),
  };

  for (const l of inv.lines) {
    const it = await wrap(store('items').get(l.itemId));
    if (it) {
      it.stock = round3((it.stock || 0) - l.qty * l.factor);
      it.updatedAt = Date.now();
      store('items').put(it);
    }
  }

  if (inv.partyId && due !== 0) {
    const p = await wrap(store('parties').get(inv.partyId));
    if (p) {
      p.balance = round2((p.balance || 0) + due);
      store('parties').put(p);
    }
  }

  store('invoices').put(inv);
  await finished;
  return inv;
}

/** Cancel an invoice: put stock back and take the unpaid amount off the customer's balance. */
export async function cancelInvoice(id) {
  const { tx, store, finished } = await begin(['items', 'parties', 'invoices']);
  const inv = await wrap(store('invoices').get(id));
  if (!inv) { tx.abort(); throw new Error('Invoice not found'); }
  if (inv.status === 'cancelled') { tx.abort(); throw new Error('Invoice is already cancelled'); }

  for (const l of inv.lines) {
    const it = await wrap(store('items').get(l.itemId));
    if (it) {
      it.stock = round3((it.stock || 0) + l.qty * l.factor);
      store('items').put(it);
    }
  }
  if (inv.partyId && inv.due) {
    const p = await wrap(store('parties').get(inv.partyId));
    if (p) {
      p.balance = round2((p.balance || 0) - inv.due);
      store('parties').put(p);
    }
  }
  inv.status = 'cancelled';
  inv.cancelledAt = Date.now();
  store('invoices').put(inv);
  await finished;
  return inv;
}

// ---------- payments ----------

/** direction 'in' = money received from a customer, 'out' = money paid to a supplier. */
export async function recordPayment({ partyId, amount, direction = 'in', mode = 'cash', note = '', date }) {
  amount = round2(+amount);
  if (!(amount > 0)) throw new Error('Enter a valid amount');

  const { store, finished } = await begin(['parties', 'payments']);
  const p = await wrap(store('parties').get(partyId));
  if (!p) throw new Error('Party not found');
  p.balance = round2((p.balance || 0) + (direction === 'in' ? -amount : amount));
  store('parties').put(p);

  const pay = { id: uid(), partyId, amount, direction, mode, note, date: date || todayISO(), createdAt: Date.now() };
  store('payments').put(pay);
  await finished;
  return pay;
}

// ---------- stock ----------

/**
 * Stock in (purchase). qty is in the unit chosen, factor converts it to the item's base unit.
 * If a supplier and bill amount are given, the unpaid part goes on the supplier's account.
 */
export async function addStock({ itemId, qty, factor = 1, cost = 0, partyId = '', billAmount = 0, paid = 0, note = '', date }) {
  qty = +qty;
  if (!(qty > 0)) throw new Error('Enter a quantity');

  const { store, finished } = await begin(['items', 'parties', 'stockLog']);
  const it = await wrap(store('items').get(itemId));
  if (!it) throw new Error('Item not found');

  const baseQty = round3(qty * factor);
  it.stock = round3((it.stock || 0) + baseQty);
  if (cost > 0) it.cost = round2(cost / factor);
  it.updatedAt = Date.now();
  store('items').put(it);

  if (partyId && billAmount > 0) {
    const p = await wrap(store('parties').get(partyId));
    if (p) {
      p.balance = round2((p.balance || 0) - (billAmount - paid));
      store('parties').put(p);
    }
  }

  const log = {
    id: uid(), itemId, itemName: it.name, qty: baseQty, unit: it.unit,
    partyId, billAmount: +billAmount || 0, paid: +paid || 0, note,
    date: date || todayISO(), createdAt: Date.now(),
  };
  store('stockLog').put(log);
  await finished;
  return log;
}

// ---------- backup / restore ----------

export async function exportAll() {
  const out = { app: 'shawear', version: 1, exportedAt: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  return out;
}

export async function importAll(data) {
  if (!data || data.app !== 'shawear') throw new Error('This is not a Shawear backup file');
  const { store, finished } = await begin(STORES);
  for (const s of STORES) {
    store(s).clear();
    for (const row of data[s] || []) store(s).put(row);
  }
  await finished;
}

export async function wipeAll() {
  const { store, finished } = await begin(STORES);
  for (const s of STORES) store(s).clear();
  await finished;
}

// ---------- demo data ----------

export async function seedDemo() {
  const now = Date.now();
  const mk = (name, brand, code, unit, altUnits, retail, contractor, wholesale, cost, stock, minStock) => ({
    id: uid(), name, brand, code, unit, altUnits,
    prices: { retail, contractor, wholesale }, cost, stock, minStock,
    createdAt: now, updatedAt: now,
  });
  const items = [
    mk('Cement 50kg', 'UltraTech', 'CEM-50', 'bag', [], 390, 380, 372, 355, 120, 20),
    mk('Wall Putty 20kg', 'Birla White', 'PUT-20', 'bag', [], 780, 760, 740, 690, 30, 8),
    mk('Wire Nails 2 inch', '', 'NAIL-2', 'kg', [{ unit: 'box', factor: 5 }], 95, 90, 85, 72, 60, 15),
    mk('Binding Wire 20G', '', 'BW-20', 'kg', [{ unit: 'coil', factor: 25 }], 78, 74, 70, 62, 200, 40),
    mk('TMT Bar 12mm', 'Tata Tiscon', 'TMT-12', 'kg', [{ unit: 'rod', factor: 10.7 }], 68, 66, 64, 60, 1500, 300),
    mk('PVC Pipe 1 inch 3m', 'Supreme', 'PVC-1', 'pcs', [], 285, 270, 255, 220, 40, 10),
    mk('Fevicol SH 1kg', 'Pidilite', 'FEV-1', 'pcs', [], 255, 245, 235, 205, 6, 10),
    mk('Wall Plug 8mm', '', 'WP-8', 'pcs', [{ unit: 'box', factor: 100 }], 1.5, 1.2, 1, 0.7, 2000, 500),
    mk('Hammer 500g', 'Taparia', 'HAM-500', 'pcs', [], 240, 225, 210, 170, 18, 5),
    mk('Padlock 50mm', 'Godrej', 'PAD-50', 'pcs', [], 320, 300, 285, 240, 25, 6),
    mk('House Wire 1.5 sq mm', 'Havells', 'WIRE-15', 'm', [{ unit: 'coil', factor: 90 }], 24, 22, 20.5, 17.5, 450, 90),
    mk('Modular Switch 6A', 'Anchor', 'SW-6', 'pcs', [], 42, 38, 35, 28, 150, 30),
    mk('Cut-off Wheel 4 inch', 'Bosch', 'CW-4', 'pcs', [{ unit: 'box', factor: 25 }], 38, 34, 31, 24, 9, 25),
  ];
  const mkp = (name, phone, type, creditLimit, balance) => ({
    id: uid(), name, phone, type, address: '', creditLimit, openingBalance: balance, balance, createdAt: now,
  });
  const parties = [
    mkp('Ramesh Contractors', '9876500001', 'customer', 50000, 12500),
    mkp('Sharma Constructions', '9876500002', 'customer', 100000, 0),
    mkp('Patel Builders', '9876500003', 'customer', 75000, 0),
    mkp('Supreme Hardware Distributors', '9876500004', 'supplier', 0, 0),
  ];
  const { store, finished } = await begin(['items', 'parties']);
  for (const it of items) store('items').put(it);
  for (const p of parties) store('parties').put(p);
  await finished;
  return { items: items.length, parties: parties.length };
}
