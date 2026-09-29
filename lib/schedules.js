const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'mint-schedules.json');
let fireFn = null;
let prewarmFn = null;
let refreshFn = null;
const timers = new Map();

// Timeline per schedule: prewarm (heavy: drop scrape, fees, nonces, balances, pre-sign) at
// T-PREWARM, refresh (fresh nonce/fee + re-sign + reopen keep-alive sockets) at T-REFRESH,
// fire at T-LEAD. LEAD > 0 sends slightly early to cover one-way latency; too early = revert.
const PREWARM_MS = (Number(process.env.MINT_PREWARM_SEC) || 20) * 1000;
const REFRESH_MS = (Number(process.env.MINT_REFRESH_SEC) || 2) * 1000;
const LEAD_MS = Number(process.env.MINT_FIRE_LEAD_MS) || 0;

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(all) {
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function init(fn, prewarm = null, refresh = null) {
  fireFn = fn;
  prewarmFn = prewarm;
  refreshFn = refresh;
}

function arm(s) {
  if (!fireFn) return;
  const startIn = s.startMs - Date.now();
  const t = { fire: setTimeout(() => fire(s.id), Math.max(0, startIn - LEAD_MS)) };
  if (prewarmFn) t.prewarm = setTimeout(() => phase(s.id, prewarmFn), Math.max(0, startIn - PREWARM_MS));
  if (refreshFn) t.refresh = setTimeout(() => phase(s.id, refreshFn), Math.max(0, startIn - REFRESH_MS));
  timers.set(s.id, t);
}

function clearTimers(id) {
  const t = timers.get(id);
  if (!t) return;
  Object.values(t).forEach(clearTimeout);
  timers.delete(id);
}

function phase(id, fn) {
  const s = load().find((x) => x.id === id && x.status === 'pending');
  if (s) Promise.resolve(fn(s)).catch((err) => console.error(`schedule ${id} phase error:`, err.message));
}

function fire(id) {
  clearTimers(id);
  const s = load().find((x) => x.id === id && x.status === 'pending');
  if (s && fireFn) fireFn(s);
}

function add(s) {
  const all = load();
  all.push(s);
  save(all);
  arm(s);
}

function sweep() {
  const all = load();
  const keep = all.filter((s) => s.status === 'pending' || Date.now() - (s.startMs || 0) < 864e5);
  if (keep.length !== all.length) save(keep);
}

function mark(id, status) {
  const all = load();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  save(all);
  setTimeout(sweep, 60e3);
}

function cancel(id) {
  clearTimers(id);
  mark(id, 'cancelled');
}

// Apply a live-config patch (e.g. new startMs/endMs/priceEth) to a pending schedule and re-arm its
// timers against the new startMs. Used by dropwatch when OpenSea/dev changes the stage on-chain.
function reschedule(id, patch) {
  const all = load();
  const s = all.find((x) => x.id === id && x.status === 'pending');
  if (!s) return null;
  Object.assign(s, patch);
  save(all);
  clearTimers(id);
  arm(s);
  return s;
}

function armAll() {
  const all = load();
  let pending = 0;
  let dirty = false;
  for (const s of all) {
    if (s.status !== 'pending') continue;
    if (s.startMs <= Date.now()) {
      s.status = 'missed';
      dirty = true;
      continue;
    }
    arm(s);
    pending++;
  }
  if (dirty) save(all);
  return pending;
}

module.exports = { init, add, mark, cancel, reschedule, armAll, list: () => load().filter((s) => s.status === 'pending') };


