// Fiesta ST Garaje — servidor (Cloudflare Worker)
// Necesita:
//   - Binding D1 llamado DB
//   - Secret APP_KEY  (tu contraseña para la app)
//   - Variable SOURCE = "mock" (datos de prueba) o "ford" (coche real)
//   - Cron trigger: */5 * * * *

const TANK_L = 42;               // depósito Fiesta ST Mk8
const LIVE_MIN_INTERVAL_S = 30;  // con Ford real: no consultar más a menudo
const SNAPSHOT_GAP_S = 60;       // mínimo entre registros del histórico

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (!env.APP_KEY) return json({ error: 'Falta el secret APP_KEY en el Worker' }, 500);
    if (req.headers.get('x-app-key') !== env.APP_KEY) return json({ error: 'Clave incorrecta' }, 401);
    const url = new URL(req.url);
    try {
      await prepare(env);
      if (url.pathname === '/api/live') return json(await getLive(env));
      if (url.pathname === '/api/history') {
        const days = Math.min(Math.max(+url.searchParams.get('days') || 7, 1), 365);
        return json(await getHistory(env, days));
      }
      if (url.pathname === '/api/refuels') return json(await getRefuels(env));
      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    await prepare(env);
    const car = await readCar(env);
    await saveSnapshot(env, car);
  }
};

// ---------- Fuente de datos ----------

async function readCar(env) {
  if (env.SOURCE === 'ford') return fordCar(env);
  return mockCar(Date.now());
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
  const factor = d => 0.072 + 0.018 * Math.abs((Math.sin(d * 12.9898) * 43758.5453) % 1); // l/km

  let todayKm = 0, driving = false, tripMin = 0, sinceEnd = 9999, pos = 0;
  trips.forEach(([start, dur, km], i) => {
    if (minF >= start + dur) { todayKm += km; sinceEnd = Math.min(sinceEnd, minF - start - dur); pos = i === 0 ? 1 : 0; }
    else if (minF >= start) { const p = (minF - start) / dur; todayKm += km * p; driving = true; tripMin = minF - start; pos = i === 0 ? p : 1 - p; }
  });

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
    rpm = Math.round(800 + speed * [0, 110, 65, 47, 37, 30, 25][gear]);
    throttle = Math.max(0, Math.min(100, Math.round(20 + 25 * Math.sin(t / 5))));
    brake = throttle < 8 ? 30 : 0;
    oil = Math.round(Math.min(98, outside + tripMin * 6));
    coolant = Math.round(Math.min(92, outside + tripMin * 9));
  } else {
    oil = Math.round(outside + (90 - outside) * Math.exp(-sinceEnd / 40));
    coolant = Math.round(outside + (88 - outside) * Math.exp(-sinceEnd / 35));
  }

  const A = [41.0763, 1.1416], B = [41.1105, 1.1442];
  const lat = A[0] + (B[0] - A[0]) * pos, lon = A[1] + (B[1] - A[1]) * pos;
  const rr = +(2.45 - (days % 20) * 0.02).toFixed(2);
  const battery = driving ? 14.2 : 12.6 - Math.min(0.2, sinceEnd / 6000);
  const tyres = { fl: 2.5, fr: 2.5, rl: 2.45, rr };

  const alerts = [];
  const names = { fl: 'delantera izquierda', fr: 'delantera derecha', rl: 'trasera izquierda', rr: 'trasera derecha' };
  for (const k in tyres) if (tyres[k] < 2.2) alerts.push(`Presión baja en la rueda ${names[k]}`);
  if (battery < 12.2) alerts.push('Batería de 12 V baja');

  return {
    ts: now,
    source: 'mock',
    odometer_km: Math.round((17000 + days * 45 + todayKm) * 10) / 10,
    fuel_pct: Math.round(fuel * 10) / 10,
    range_km: Math.round((fuel / 100) * TANK_L / factor(days)),
    battery_v: Math.round(battery * 100) / 100,
    tyres,
    locked: !driving,
    doors_open: [],
    windows_open: [],
    ignition: driving ? 'run' : 'off',
    speed_kmh: speed, gear, rpm,
    throttle_pct: throttle, brake_pct: brake,
    oil_c: oil, coolant_c: coolant, outside_c: outside,
    location: { lat: +lat.toFixed(5), lon: +lon.toFixed(5) },
    alerts
  };
}

// ---------- Base de datos ----------

let ready = false;
async function prepare(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS snapshots (ts INTEGER PRIMARY KEY, odometer REAL, fuel_pct REAL, battery_v REAL, data TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS refuels (ts INTEGER PRIMARY KEY, odometer REAL, fuel_before REAL, fuel_after REAL, litres REAL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
  ]);
  const demo = await env.DB.prepare("SELECT v FROM kv WHERE k = 'demo'").first();
  if (env.SOURCE === 'ford' && demo) {
    // Al pasar a datos reales se borran los de prueba.
    await env.DB.batch([
      env.DB.prepare('DELETE FROM snapshots'),
      env.DB.prepare('DELETE FROM refuels'),
      env.DB.prepare("DELETE FROM kv WHERE k IN ('demo', 'live_cache')")
    ]);
  } else if (env.SOURCE !== 'ford' && !demo) {
    await backfillMock(env);
  }
  ready = true;
}

async function backfillMock(env) {
  // 30 días de histórico simulado, un registro cada 30 min.
  const now = Date.now();
  const stmts = [];
  let prev = null;
  for (let ts = now - 30 * 86400e3; ts < now; ts += 30 * 60e3) {
    const c = mockCar(ts);
    stmts.push(env.DB.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)')
      .bind(c.ts, c.odometer_km, c.fuel_pct, c.battery_v, JSON.stringify(c)));
    if (prev && c.fuel_pct - prev.fuel_pct >= 15) stmts.push(refuelStmt(env, prev, c));
    prev = c;
  }
  stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('demo', '1')"));
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}

function refuelStmt(env, prev, c) {
  const litres = Math.round(((c.fuel_pct - prev.fuel_pct) / 100) * TANK_L * 10) / 10;
  return env.DB.prepare('INSERT OR REPLACE INTO refuels VALUES (?, ?, ?, ?, ?)')
    .bind(c.ts, c.odometer_km, prev.fuel_pct, c.fuel_pct, litres);
}

async function saveSnapshot(env, c) {
  const prev = await env.DB.prepare('SELECT ts, fuel_pct FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  if (prev && c.ts - prev.ts < SNAPSHOT_GAP_S * 1000) return;
  const stmts = [env.DB.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)')
    .bind(c.ts, c.odometer_km, c.fuel_pct, c.battery_v, JSON.stringify(c))];
  if (prev && c.fuel_pct - prev.fuel_pct >= 15) stmts.push(refuelStmt(env, prev, c));
  await env.DB.batch(stmts);
}

// ---------- Endpoints ----------

async function getLive(env) {
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
  await saveSnapshot(env, car);
  return car;
}

async function getHistory(env, days) {
  const from = Date.now() - days * 86400e3;
  const { results } = await env.DB.prepare(
    'SELECT ts, odometer, fuel_pct, battery_v FROM snapshots WHERE ts >= ? ORDER BY ts'
  ).bind(from).all();
  const step = Math.max(1, Math.ceil(results.length / 400));
  const points = results.filter((_, i) => i % step === 0 || i === results.length - 1);
  return { days, points };
}

async function getRefuels(env) {
  const { results } = await env.DB.prepare('SELECT * FROM refuels ORDER BY ts').all();
  let totalUsed = 0, totalKm = 0;
  const list = results.map((r, i) => {
    const p = results[i - 1];
    let km = null, l100 = null;
    if (p) {
      km = Math.round((r.odometer - p.odometer) * 10) / 10;
      const used = ((p.fuel_after - r.fuel_before) / 100) * TANK_L;
      if (km > 20) { l100 = Math.round((used / km) * 1000) / 10; totalUsed += used; totalKm += km; }
    }
    return { ...r, km, l100 };
  }).reverse();
  return { refuels: list, avg_l100: totalKm ? Math.round((totalUsed / totalKm) * 1000) / 10 : null };
}

// ---------- Utilidades ----------

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8' }
  }));
}

function cors(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'x-app-key, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  return res;
}
