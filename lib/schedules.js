const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'mint-schedules.json');
let fireFn = null;
const timers = new Map();

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

function init(fn) {
  fireFn = fn;
}

function arm(s) {
  if (!fireFn) return;
  const t = setTimeout(() => fire(s.id), Math.max(0, s.startMs - Date.now()));
  timers.set(s.id, t);
}

function fire(id) {
  timers.delete(id);
  const s = load().find((x) => x.id === id && x.status === 'pending');
  if (s && fireFn) fireFn(s);
}

function add(s) {
  const all = load();
  all.push(s);
  save(all);
  arm(s);
}

function mark(id, status) {
  const all = load();
  const s = all.find((x) => x.id === id);
  if (!s) return;
  s.status = status;
  save(all);
}

function cancel(id) {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  mark(id, 'cancelled');
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

module.exports = { init, add, mark, cancel, armAll, list: () => load().filter((s) => s.status === 'pending') };
