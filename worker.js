// Fiesta ST Garaje — servidor (Cloudflare Worker)
// Configuración en wrangler.jsonc (base de datos DB, variable SOURCE, cron cada minuto).
// Secret APP_KEY: contraseña de la app.
// SOURCE = "mock" (coche simulado) o "ford" (coche real).

const SCHEMA = '2';
const TANK_L = 42;               // depósito Fiesta ST Mk8
const LIVE_MIN_INTERVAL_S = 30;  // con Ford real: no consultar más a menudo
const GAP_PARKED_S = 300;        // registro del histórico aparcado
const GAP_DRIVING_S = 60;        // registro del histórico en marcha
const POINT_GAP_S = 15;          // puntos del recorrido
const UNLOCKED_GRACE_S = 300;    // margen antes de avisar de coche abierto
const TYRE_MIN = 2.2, BATT_MIN = 12.2, FUEL_MIN = 12, OIL_WARM = 80;
const PUSH_SUBJECT = 'https://alvarogp30699.github.io/fiesta-st-garaje/';
const TYRE_NAMES = { fl: 'delantera izquierda', fr: 'delantera derecha', rl: 'trasera izquierda', rr: 'trasera derecha' };
const DEFAULT_MAINT = [
  ['Aceite y filtro', 15000, 12],
  ['Revisión oficial Ford', 20000, 12],
  ['Revisar pastillas delanteras', 10000, null],
  ['Filtro de aire', 30000, 24],
  ['Líquido de frenos', null, 24]
];

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (!env.APP_KEY) return json({ error: 'Falta el secret APP_KEY en el Worker' }, 500);
    if (req.headers.get('x-app-key') !== env.APP_KEY) return json({ error: 'Contraseña incorrecta' }, 401);
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;
    let mt;
    try {
      await prepare(env);
      if (m === 'GET' && p === '/api/live') return json(await getLive(env, ctx));
      if (m === 'GET' && p === '/api/history') return json(await getHistory(env, clampInt(url.searchParams.get('days'), 1, 365, 7)));
      if (m === 'GET' && p === '/api/battery') return json(await getBattery(env, clampInt(url.searchParams.get('days'), 3, 90, 14)));
      if (m === 'GET' && p === '/api/refuels') return json(await getRefuels(env));
      if (m === 'POST' && (mt = p.match(/^\/api\/refuels\/(\d+)$/))) return json(await updateRefuel(env, +mt[1], await req.json()));
      if (m === 'GET' && p === '/api/trips') return json(await listTrips(env, clampInt(url.searchParams.get('limit'), 1, 200, 40)));
      if (m === 'GET' && (mt = p.match(/^\/api\/trips\/(\d+)$/))) return json(await getTrip(env, +mt[1]));
      if (m === 'GET' && p === '/api/maintenance') return json(await listMaint(env));
      if (m === 'POST' && p === '/api/maintenance') return json(await saveMaint(env, await req.json()));
      if (m === 'POST' && (mt = p.match(/^\/api\/maintenance\/(\d+)\/done$/))) return json(await doneMaint(env, +mt[1]));
      if (m === 'DELETE' && (mt = p.match(/^\/api\/maintenance\/(\d+)$/))) return json(await deleteMaint(env, +mt[1]));
      if (m === 'GET' && p === '/api/push/key') return json({ key: (await vapidKeys(env)).pub });
      if (m === 'POST' && p === '/api/push/subscribe') return json(await subscribe(env, await req.json()));
      if (m === 'POST' && p === '/api/push/test') {
        return json(await sendPushAll(env, { title: 'Fiesta ST', body: 'Los avisos funcionan correctamente.', url: '#estado', tag: 'test' }));
      }
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 500);
    }
  },

  async scheduled(event, env, ctx) {
    await prepare(env);
    const st = await loadState(env);
    const minute = new Date(event.scheduledTime).getUTCMinutes();
    // Con Ford real: aparcado, una consulta cada 5 min; en marcha, cada minuto.
    const poll = env.SOURCE !== 'ford' || st.trip || minute % 5 === 0;
    if (poll) {
      try { await ingest(env, await readCar(env), st); } catch (e) { console.error('ingest', e); }
    }
    await daily(env, event.scheduledTime);
  }
};

// ---------- Fuente de datos ----------

async function readCar(env) {
  const car = env.SOURCE === 'ford' ? await fordCar(env) : mockCar(Date.now());
  car.alerts = Object.values(carAlerts(car));
  return car;
}

async function fordCar(env) {
  // Se completa cuando tengamos tu acceso de Ford y una respuesta real del coche.
  throw new Error('Conexión con Ford pendiente. Deja SOURCE = mock hasta configurarla.');
}

// Coche simulado: función pura del tiempo, así el histórico es coherente.
function mockCar(now) {
  const BASE = Date.UTC(2026, 9, 1);
  const DAY = 86400e3;
  const local = now + 3600e3; // hora peninsular aprox.
  const days = Math.floor((local - BASE) / DAY);
  const minF = ((local - BASE) % DAY) / 60000;
  const trips = [[450, 20, 20], [960, 25, 25]]; // inicio (min), duración (min), km
  const rnd = d => Math.abs((Math.sin(d * 12.9898) * 43758.5453) % 1);
  const factor = d => 0.072 + 0.018 * rnd(d); // l/km

  let todayKm = 0, driving = false, tripMin = 0, sinceEnd = 9999, pos = 0;
  trips.forEach(([start, dur, km], i) => {
    if (minF >= start + dur) { todayKm += km; sinceEnd = Math.min(sinceEnd, minF - start - dur); pos = i === 0 ? 1 : 0; }
    else if (minF >= start) { const q = (minF - start) / dur; todayKm += km * q; driving = true; tripMin = minF - start; pos = i === 0 ? q : 1 - q; }
  });
  if (minF < trips[0][0]) sinceEnd = minF + 1440 - (trips[1][0] + trips[1][1]);

  let used = 0;
  for (let d = 0; d < days; d++) used += 45 * factor(d);
  used += todayKm * factor(days);
  const usable = TANK_L * 0.8;
  const fuel = 95 - ((used % usable) / TANK_L) * 100;

  const outside = Math.round(12 + 6 * Math.sin((minF / 1440 - 0.375) * 2 * Math.PI));
  const t = now / 1000;
  let speed = 0, gear = 0, rpm = 0, throttle = 0, brake = 0, oil, coolant;
  if (driving) {
    speed = Math.max(0, Math.min(140, Math.round(55 + 35 * Math.sin(t / 37) + 15 * Math.sin(t / 9))));
    gear = speed < 15 ? 1 : speed < 30 ? 2 : speed < 50 ? 3 : speed < 70 ? 4 : speed < 95 ? 5 : 6;
    rpm = Math.round(800 + speed * [0, 110, 65, 47, 37, 30, 25][gear] + (Math.sin(t / 3) > 0.9 ? 1800 : 0));
    throttle = Math.max(0, Math.min(100, Math.round(20 + 25 * Math.sin(t / 5))));
    brake = throttle < 8 ? 30 : 0;
    oil = Math.round(Math.min(98, outside + tripMin * 6));
    coolant = Math.round(Math.min(92, outside + tripMin * 9));
  } else {
    oil = Math.round(outside + (90 - outside) * Math.exp(-sinceEnd / 40));
    coolant = Math.round(outside + (88 - outside) * Math.exp(-sinceEnd / 35));
  }

  const A = [41.0763, 1.1416], B = [41.1105, 1.1442];
  const lat = A[0] + (B[0] - A[0]) * pos;
  const lon = A[1] + (B[1] - A[1]) * pos + 0.012 * Math.sin(pos * Math.PI);
  const rr = +(2.45 - (days % 20) * 0.02).toFixed(2);
  const base = 12.62 - 0.06 * rnd(days + 7);
  const battery = driving ? 14.2 : base - Math.min(0.15, sinceEnd / 8000);

  return {
    ts: now,
    source: 'mock',
    odometer_km: Math.round((17000 + days * 45 + todayKm) * 10) / 10,
    fuel_pct: Math.round(fuel * 10) / 10,
    range_km: Math.round((fuel / 100) * TANK_L / factor(days)),
    battery_v: Math.round(battery * 100) / 100,
    tyres: { fl: 2.5, fr: 2.5, rl: 2.45, rr },
    locked: !driving,
    doors_open: [],
    windows_open: [],
    ignition: driving ? 'run' : 'off',
    speed_kmh: speed, gear, rpm,
    throttle_pct: throttle, brake_pct: brake,
    oil_c: oil, coolant_c: coolant, outside_c: outside,
    location: { lat: +lat.toFixed(5), lon: +lon.toFixed(5) }
  };
}

function carAlerts(c) {
  const running = c.ignition !== 'off';
  const out = {};
  for (const k in c.tyres || {}) {
    const v = c.tyres[k];
    if (v != null && v < TYRE_MIN) out['tyre_' + k] = `Presión baja en la rueda ${TYRE_NAMES[k] || k} (${fmt(v, 1)} bar)`;
  }
  if (!running && c.battery_v != null && c.battery_v < BATT_MIN) out.batt = `Batería de 12 V baja (${fmt(c.battery_v, 1)} V)`;
  if (!running && c.locked === false) out.unlocked = 'El coche está aparcado sin cerrar';
  const open = [...(c.doors_open || []), ...(c.windows_open || [])];
  if (!running && open.length) out.open = 'Abierto: ' + open.join(', ');
  if (c.fuel_pct != null && c.fuel_pct < FUEL_MIN) out.fuel = `Queda poco combustible (${Math.round(c.fuel_pct)} %, unos ${c.range_km} km)`;
  return out;
}

// ---------- Procesado: histórico, repostajes, trayectos, avisos ----------

function newState() {
  return { last: null, snapFuel: null, trip: null, alerts: [], unlockedSince: null };
}

async function loadState(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'state'").first();
  return row ? { ...newState(), ...JSON.parse(row.v) } : newState();
}

function stateStmt(db, st) {
  return db.prepare("INSERT OR REPLACE INTO kv VALUES ('state', ?)").bind(JSON.stringify(st));
}

function processCar(db, st, c, opts = {}) {
  const stmts = [], notes = [];
  const running = c.ignition !== 'off';
  const gap = running ? (opts.gapDriving || GAP_DRIVING_S) : (opts.gapParked || GAP_PARKED_S);
  const ignChanged = st.last && (st.last.ignition !== 'off') !== running;

  // Histórico y repostajes
  if (!st.last || c.ts - st.last.ts >= gap * 1000 || ignChanged) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)')
      .bind(c.ts, c.odometer_km, c.fuel_pct, c.battery_v, JSON.stringify(c)));
    if (st.snapFuel != null && c.fuel_pct - st.snapFuel >= 15) {
      const litres = round(((c.fuel_pct - st.snapFuel) / 100) * TANK_L, 1);
      stmts.push(db.prepare('INSERT OR REPLACE INTO refuels (ts, odometer, fuel_before, fuel_after, litres) VALUES (?, ?, ?, ?, ?)')
        .bind(c.ts, c.odometer_km, st.snapFuel, c.fuel_pct, litres));
      notes.push({ title: 'Repostaje detectado', body: `Unos ${fmt(litres, 1)} L. Toca para apuntar el precio.`, url: '#datos', tag: 'refuel' });
    }
    st.snapFuel = c.fuel_pct;
    st.last = { ts: c.ts, ignition: c.ignition };
  }

  // Trayectos
  if (running) {
    if (!st.trip) {
      st.trip = {
        start_ts: c.ts, start_odo: c.odometer_km, start_fuel: c.fuel_pct, start_oil: c.oil_c,
        start: c.location ? [c.location.lat, c.location.lon] : null,
        pts: [], n: 0, spd: 0, thr: 0, hi: 0, max_speed: 0, max_rpm: 0, max_oil: 0, warm: false
      };
    }
    const t = st.trip;
    t.n++;
    t.spd += c.speed_kmh || 0;
    t.thr += c.throttle_pct || 0;
    if ((c.rpm || 0) >= 4000) t.hi++;
    t.max_speed = Math.max(t.max_speed, c.speed_kmh || 0);
    t.max_rpm = Math.max(t.max_rpm, c.rpm || 0);
    t.max_oil = Math.max(t.max_oil, c.oil_c || 0);
    t.end_ts = c.ts; t.end_odo = c.odometer_km; t.end_fuel = c.fuel_pct;
    if (c.location) {
      t.end = [c.location.lat, c.location.lon];
      const lp = t.pts[t.pts.length - 1];
      if (!lp || c.ts - lp[3] >= POINT_GAP_S * 1000) t.pts.push([c.location.lat, c.location.lon, c.speed_kmh || 0, c.ts]);
    }
    if (!t.warm && t.start_oil != null && t.start_oil < 60 && c.oil_c >= OIL_WARM) {
      t.warm = true;
      notes.push({ title: 'Motor a temperatura', body: `Aceite a ${c.oil_c} °C. Ya puedes apretar.`, url: '#motor', tag: 'warm' });
    }
  } else if (st.trip) {
    const t = st.trip;
    const endOdo = c.odometer_km ?? t.end_odo;
    const km = round(endOdo - t.start_odo, 1);
    if (km >= 0.3) {
      const dur = Math.max(60, Math.round((t.end_ts - t.start_ts) / 1000));
      const usedL = Math.max(0, ((t.start_fuel - (c.fuel_pct ?? t.end_fuel)) / 100) * TANK_L);
      const pts = t.pts.slice();
      if (c.location) pts.push([c.location.lat, c.location.lon, 0, c.ts]);
      const end = c.location ? [c.location.lat, c.location.lon] : t.end;
      stmts.push(db.prepare(`INSERT INTO trips (start_ts, end_ts, start_odo, end_odo, km, duration_s, avg_speed, max_speed,
          max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l, start_lat, start_lon, end_lat, end_lon, points)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(t.start_ts, t.end_ts, t.start_odo, endOdo, km, dur, Math.round(km / (dur / 3600)), t.max_speed,
          t.max_rpm, t.max_oil, Math.round(t.thr / t.n), Math.round((t.hi / t.n) * 100), round(usedL, 2),
          t.start?.[0] ?? null, t.start?.[1] ?? null, end?.[0] ?? null, end?.[1] ?? null, JSON.stringify(pts)));
    }
    st.trip = null;
  }

  // Avisos (solo cuando aparecen)
  const cur = carAlerts(c);
  if (cur.unlocked) {
    st.unlockedSince = st.unlockedSince || c.ts;
    if (c.ts - st.unlockedSince < UNLOCKED_GRACE_S * 1000) delete cur.unlocked;
  } else st.unlockedSince = null;
  for (const k in cur) {
    if (!st.alerts.includes(k)) notes.push({ title: 'Fiesta ST', body: cur[k], url: '#estado', tag: k });
  }
  st.alerts = Object.keys(cur);
  return { stmts, notes };
}

async function ingest(env, car, st) {
  st = st || await loadState(env);
  const { stmts, notes } = processCar(env.DB, st, car);
  stmts.push(stateStmt(env.DB, st));
  await env.DB.batch(stmts);
  for (const n of notes) await sendPushAll(env, n);
}

// Revisión diaria a las 9:00: mantenimiento y batería.
async function daily(env, when) {
  const local = new Date(when + 3600e3);
  if (local.getUTCHours() !== 9) return;
  const day = local.toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'daily'").first();
  if (row && row.v === day) return;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('daily', ?)").bind(day).run();

  const { items } = await listMaint(env);
  const due = items.filter(i => i.status === 'vencido' || i.status === 'pronto');
  if (due.length) {
    await sendPushAll(env, {
      title: 'Mantenimiento', url: '#taller', tag: 'maint',
      body: due.map(i => `${i.name}: ${i.summary}`).join(' · ')
    });
  }
  const b = await getBattery(env, 14);
  if (b.status === 'bajando') {
    await sendPushAll(env, { title: 'Batería de 12 V', body: `Va bajando unos ${fmt(Math.abs(b.slope), 2)} V al día. Conviene revisarla.`, url: '#datos', tag: 'batt_trend' });
  }
}

// ---------- Base de datos ----------

let ready = false;
async function prepare(env) {
  if (ready) return;
  const db = env.DB;
  await db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)').run();
  const ver = await db.prepare("SELECT v FROM kv WHERE k = 'schema'").first();
  if (!ver || ver.v !== SCHEMA) {
    // Versión anterior solo con datos de prueba: se recrea.
    await db.batch([
      db.prepare('DROP TABLE IF EXISTS snapshots'),
      db.prepare('DROP TABLE IF EXISTS refuels'),
      db.prepare('DROP TABLE IF EXISTS trips'),
      db.prepare("DELETE FROM kv WHERE k IN ('demo', 'state', 'live_cache')")
    ]);
  }
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, odometer REAL, fuel_pct REAL, battery_v REAL, data TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS refuels (ts INTEGER PRIMARY KEY, odometer REAL, fuel_before REAL, fuel_after REAL, litres REAL, price_total REAL, station TEXT)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, start_ts INTEGER, end_ts INTEGER,
      start_odo REAL, end_odo REAL, km REAL, duration_s INTEGER, avg_speed INTEGER, max_speed INTEGER, max_rpm INTEGER,
      max_oil INTEGER, avg_throttle INTEGER, rpm_high_pct INTEGER, fuel_used_l REAL,
      start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL, points TEXT)`),
    db.prepare('CREATE INDEX IF NOT EXISTS trips_start ON trips (start_ts)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS maintenance (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      interval_km INTEGER, interval_months INTEGER, last_km REAL, last_date TEXT, notes TEXT)`),
    db.prepare('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT, created INTEGER)'),
    db.prepare("INSERT OR REPLACE INTO kv VALUES ('schema', ?)").bind(SCHEMA)
  ]);
  const mc = await db.prepare('SELECT COUNT(*) AS n FROM maintenance').first();
  if (!mc.n) {
    await db.batch(DEFAULT_MAINT.map(([n, km, mo]) =>
      db.prepare('INSERT INTO maintenance (name, interval_km, interval_months) VALUES (?, ?, ?)').bind(n, km, mo)));
  }
  const demo = await db.prepare("SELECT v FROM kv WHERE k = 'demo'").first();
  if (env.SOURCE === 'ford' && demo) {
    // Al pasar a datos reales se borran los de prueba (el mantenimiento se conserva).
    await db.batch([
      db.prepare('DELETE FROM snapshots'),
      db.prepare('DELETE FROM refuels'),
      db.prepare('DELETE FROM trips'),
      db.prepare("DELETE FROM kv WHERE k IN ('demo', 'state', 'live_cache')")
    ]);
  } else if (env.SOURCE !== 'ford' && !demo) {
    await backfillMock(env);
  }
  ready = true;
}

async function backfillMock(env) {
  // 30 días simulados: cada minuto en marcha, cada 5 min aparcado.
  const db = env.DB;
  const st = newState();
  const all = [];
  const now = Date.now();
  let ts = now - 30 * 86400e3;
  while (ts < now) {
    const c = mockCar(ts);
    all.push(...processCar(db, st, c, { gapParked: 1800, gapDriving: 300 }).stmts);
    ts += c.ignition !== 'off' ? 60e3 : 300e3;
  }
  all.push(stateStmt(db, st));
  all.push(db.prepare("INSERT OR REPLACE INTO kv VALUES ('demo', '1')"));
  for (let i = 0; i < all.length; i += 250) await db.batch(all.slice(i, i + 250));
}

// ---------- Endpoints ----------

async function getLive(env, ctx) {
  if (env.SOURCE === 'ford') {
    const cached = await env.DB.prepare("SELECT v FROM kv WHERE k = 'live_cache'").first();
    if (cached) {
      const c = JSON.parse(cached.v);
      if (Date.now() - c.ts < LIVE_MIN_INTERVAL_S * 1000) return c;
    }
  }
  const car = await readCar(env);
  if (env.SOURCE === 'ford') {
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('live_cache', ?)").bind(JSON.stringify(car)).run();
  }
  await ingest(env, car);
  return car;
}

async function getHistory(env, days) {
  const from = Date.now() - days * 86400e3;
  const { results } = await env.DB.prepare(
    'SELECT ts, odometer, fuel_pct, battery_v FROM snapshots WHERE ts >= ? ORDER BY ts'
  ).bind(from).all();
  const step = Math.max(1, Math.ceil(results.length / 400));
  return { days, points: results.filter((_, i) => i % step === 0 || i === results.length - 1) };
}

async function getBattery(env, days) {
  const from = Date.now() - days * 86400e3;
  const { results } = await env.DB.prepare(
    `SELECT date((ts + 3600000) / 1000, 'unixepoch') AS d, MIN(battery_v) AS min, MAX(battery_v) AS max
     FROM snapshots WHERE ts >= ? AND json_extract(data, '$.ignition') = 'off' GROUP BY d ORDER BY d`
  ).bind(from).all();
  const last7 = results.slice(-7);
  let slope = 0;
  if (last7.length >= 3) {
    const n = last7.length, xs = last7.map((_, i) => i), ys = last7.map(r => r.min);
    const mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n;
    const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const den = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    slope = den ? num / den : 0;
  }
  const lastMin = results.length ? results[results.length - 1].min : null;
  const status = lastMin == null ? 'sin datos' : lastMin < BATT_MIN ? 'baja' : slope < -0.03 ? 'bajando' : 'estable';
  return { days: results, slope: round(slope, 3), status };
}

async function getRefuels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM refuels ORDER BY ts').all();
  let totalUsed = 0, totalKm = 0;
  const list = results.map((r, i) => {
    const p = results[i - 1];
    let km = null, l100 = null;
    if (p) {
      km = round(r.odometer - p.odometer, 1);
      const used = ((p.fuel_after - r.fuel_before) / 100) * TANK_L;
      if (km > 20) { l100 = round((used / km) * 100, 1); totalUsed += used; totalKm += km; }
    }
    const price_l = r.price_total && r.litres ? round(r.price_total / r.litres, 3) : null;
    return { ...r, km, l100, price_l };
  }).reverse();
  return { refuels: list, avg_l100: totalKm ? round((totalUsed / totalKm) * 100, 1) : null, tank_l: TANK_L };
}

async function updateRefuel(env, ts, body) {
  const price = body.price_total === null || body.price_total === '' ? null : Number(body.price_total);
  if (price !== null && !(price > 0 && price < 1000)) throw httpError('El precio no es válido', 400);
  const station = body.station ? String(body.station).slice(0, 80) : null;
  const r = await env.DB.prepare('UPDATE refuels SET price_total = ?, station = ? WHERE ts = ?').bind(price, station, ts).run();
  if (!r.meta.changes) throw httpError('Repostaje no encontrado', 404);
  return { ok: true };
}

async function listTrips(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT id, start_ts, end_ts, km, duration_s, avg_speed, max_speed, max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l
     FROM trips ORDER BY start_ts DESC LIMIT ?`
  ).bind(limit).all();
  return { trips: results };
}

async function getTrip(env, id) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!t) throw httpError('Trayecto no encontrado', 404);
  return { ...t, points: JSON.parse(t.points || '[]') };
}

async function currentOdo(env) {
  const r = await env.DB.prepare('SELECT odometer FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  return r ? r.odometer : null;
}

function maintStatus(i, odo, now) {
  const out = { ...i, next_km: null, rem_km: null, next_date: null, rem_days: null, pct: 0, status: 'sin datos', summary: 'Pon cuándo se hizo por última vez' };
  const parts = [];
  if (i.interval_km && i.last_km != null) {
    out.next_km = i.last_km + i.interval_km;
    out.rem_km = odo != null ? Math.round(out.next_km - odo) : null;
    if (out.rem_km != null) {
      out.pct = Math.max(out.pct, 1 - out.rem_km / i.interval_km);
      parts.push(out.rem_km >= 0 ? `quedan ${fmt(out.rem_km)} km` : `pasado ${fmt(-out.rem_km)} km`);
    }
  }
  if (i.interval_months && i.last_date) {
    const d = new Date(i.last_date + 'T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + i.interval_months);
    out.next_date = d.toISOString().slice(0, 10);
    out.rem_days = Math.round((d - now) / 86400e3);
    out.pct = Math.max(out.pct, 1 - out.rem_days / (i.interval_months * 30.4));
    parts.push(out.rem_days >= 0 ? `quedan ${out.rem_days} días` : `pasado ${-out.rem_days} días`);
  }
  if (parts.length) {
    const late = (out.rem_km != null && out.rem_km <= 0) || (out.rem_days != null && out.rem_days <= 0);
    const soon = (out.rem_km != null && out.rem_km <= 1000) || (out.rem_days != null && out.rem_days <= 30);
    out.status = late ? 'vencido' : soon ? 'pronto' : 'ok';
    out.summary = parts.join(' · ');
  }
  out.pct = Math.max(0, Math.min(1, out.pct));
  return out;
}

async function listMaint(env) {
  const odo = await currentOdo(env);
  const { results } = await env.DB.prepare('SELECT * FROM maintenance ORDER BY id').all();
  const now = Date.now();
  const order = { vencido: 0, pronto: 1, ok: 2, 'sin datos': 3 };
  const items = results.map(i => maintStatus(i, odo, now)).sort((a, b) => order[a.status] - order[b.status] || b.pct - a.pct);
  return { odometer: odo, items };
}

async function saveMaint(env, b) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) throw httpError('Ponle un nombre a la tarea', 400);
  const num = v => (v === '' || v == null ? null : Number(v));
  const ikm = num(b.interval_km), imo = num(b.interval_months), lkm = num(b.last_km);
  if ([ikm, imo, lkm].some(v => v !== null && !(v >= 0))) throw httpError('Hay algún número no válido', 400);
  if (!ikm && !imo) throw httpError('Pon cada cuántos km o meses se hace', 400);
  const ld = b.last_date && /^\d{4}-\d{2}-\d{2}$/.test(b.last_date) ? b.last_date : null;
  const notes = b.notes ? String(b.notes).slice(0, 300) : null;
  if (b.id) {
    await env.DB.prepare('UPDATE maintenance SET name=?, interval_km=?, interval_months=?, last_km=?, last_date=?, notes=? WHERE id=?')
      .bind(name, ikm, imo, lkm, ld, notes, b.id).run();
  } else {
    await env.DB.prepare('INSERT INTO maintenance (name, interval_km, interval_months, last_km, last_date, notes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(name, ikm, imo, lkm, ld, notes).run();
  }
  return listMaint(env);
}

async function doneMaint(env, id) {
  const odo = await currentOdo(env);
  const today = new Date(Date.now() + 3600e3).toISOString().slice(0, 10);
  await env.DB.prepare('UPDATE maintenance SET last_km = ?, last_date = ? WHERE id = ?').bind(odo, today, id).run();
  return listMaint(env);
}

async function deleteMaint(env, id) {
  await env.DB.prepare('DELETE FROM maintenance WHERE id = ?').bind(id).run();
  return listMaint(env);
}

// ---------- Avisos push (Web Push con VAPID, cifrado aes128gcm) ----------

const te = new TextEncoder();
const b64u = {
  enc: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: s => {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
  }
};
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  if (row) {
    const v = JSON.parse(row.v);
    return { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  }
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const pub = b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey));
  await env.DB.prepare("INSERT OR IGNORE INTO kv VALUES ('vapid', ?)").bind(JSON.stringify({ jwk, pub })).run();
  const again = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vapid'").first();
  const v = JSON.parse(again.v);
  return { pub: v.pub, priv: await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
}

async function encryptPush(sub, payload) {
  const uaPub = b64u.dec(sub.keys.p256dh);
  const auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = (await hmac(prkKey, concat(te.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(te.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  return concat(header, asPub, ct);
}

async function vapidAuth(env, endpoint) {
  const { pub, priv } = await vapidKeys(env);
  const h = b64u.enc(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const p = b64u.enc(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, te.encode(h + '.' + p));
  return `vapid t=${h}.${p}.${b64u.enc(sig)}, k=${pub}`;
}

async function subscribe(env, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw httpError('Suscripción no válida', 400);
  }
  await env.DB.prepare('INSERT OR REPLACE INTO push_subs VALUES (?, ?, ?)')
    .bind(sub.endpoint, JSON.stringify({ endpoint: sub.endpoint, keys: sub.keys }), Date.now()).run();
  return { ok: true };
}

async function sendPushAll(env, note) {
  const { results } = await env.DB.prepare('SELECT endpoint, sub FROM push_subs').all();
  let sent = 0, failed = 0;
  for (const r of results) {
    const sub = JSON.parse(r.sub);
    try {
      const body = await encryptPush(sub, JSON.stringify(note));
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: '86400',
          Urgency: 'high',
          Authorization: await vapidAuth(env, sub.endpoint)
        },
        body
      });
      if (res.status === 404 || res.status === 410) {
        await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(r.endpoint).run();
        failed++;
      } else if (res.ok) sent++;
      else { failed++; console.error('push', res.status, await res.text()); }
    } catch (e) { failed++; console.error('push', e); }
  }
  return { sent, failed, devices: results.length };
}

// ---------- Utilidades ----------

function round(v, d = 0) { const f = 10 ** d; return Math.round(v * f) / f; }
function fmt(v, d = 0) { return Number(v).toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function clampInt(v, min, max, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }
function httpError(msg, status) { const e = new Error(msg); e.status = status; return e; }

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'x-app-key, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  return res;
}
