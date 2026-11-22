// Fiesta ST Garaje — servidor (Cloudflare Worker)
// Configuración en wrangler.jsonc (base de datos DB, variable SOURCE, cron cada minuto).
// Secret APP_KEY: contraseña de la app.
// SOURCE = "mock" (coche simulado) o "ford" (coche real).

const SCHEMA = '3';
const TANK_L = 45;               // depósito Fiesta ST Mk8
const LIVE_MIN_INTERVAL_S = 30;  // con Ford real: no consultar más a menudo
const GAP_PARKED_S = 300;        // registro del histórico aparcado
const GAP_DRIVING_S = 60;        // registro del histórico en marcha
const POINT_GAP_S = 15;          // puntos del recorrido
const UNLOCKED_GRACE_S = 300;    // margen antes de avisar de coche abierto
const TYRE_MIN = 2.2, BATT_MIN = 12.2, FUEL_MIN = 12, OIL_WARM = 80;
const FUEL_API = 'https://sedeaplicaciones.minetur.gob.es/ServiciosRESTCarburantes/PreciosCarburantes/EstacionesTerrestres/FiltroProvincia/';
const FUEL_FIELDS = { '95': 'Precio Gasolina 95 E5', '98': 'Precio Gasolina 98 E5' };
const PUSH_SUBJECT = 'https://alvarogp30699.github.io/fiesta-st-garaje/';
// Circuitos conocidos: centro del recinto y radio en km (o rectángulo "box" para la Nordschleife).
// approx: ubicación sacada de la dirección, no de coordenadas publicadas.
const CIRCUITS = [
  { id: 'albacete', name: 'Circuito de Albacete', lat: 39.00782, lon: -1.79590, r: 1.0 },
  { id: 'motorland', name: 'MotorLand Aragón', lat: 41.0755, lon: -0.1980, r: 1.9 },
  { id: 'jarama', name: 'Circuito del Jarama', lat: 40.61711, lon: -3.58558, r: 0.9 },
  { id: 'montmelo', name: 'Circuit de Barcelona-Catalunya', lat: 41.5700, lon: 2.2611, r: 1.5 },
  { id: 'cheste', name: 'Circuit Ricardo Tormo (Cheste)', lat: 39.48583, lon: -0.62806, r: 1.2 },
  { id: 'navarra', name: 'Circuito de Navarra', lat: 42.56106, lon: -2.16361, r: 1.3 },
  { id: 'jerez', name: 'Circuito de Jerez', lat: 36.70833, lon: -6.03417, r: 1.3 },
  { id: 'almeria', name: 'Circuito de Almería', lat: 37.0899, lon: -2.2719, r: 2.0 },
  { id: 'guadix', name: 'Circuito de Guadix', lat: 37.40167, lon: -3.07472, r: 1.2 },
  { id: 'monteblanco', name: 'Circuito Monteblanco', lat: 37.35917, lon: -6.56565, r: 1.5 },
  { id: 'calafat', name: 'Circuit de Calafat', lat: 40.93389, lon: 0.84167, r: 1.0 },
  { id: 'cartagena', name: 'Circuito de Cartagena', lat: 37.64556, lon: -1.03626, r: 1.0 },
  { id: 'parcmotor', name: 'Parcmotor Castellolí', lat: 41.5902, lon: 1.69077, r: 1.3 },
  { id: 'ascari', name: 'Ascari Race Resort', lat: 36.82556, lon: -5.08361, r: 1.5 },
  { id: 'alcarras', name: "Circuit d'Alcarràs", lat: 41.575, lon: 0.500, r: 3.5, approx: true },
  { id: 'kotarr', name: 'Circuito Kotarr', lat: 41.800, lon: -3.570, r: 3.0, approx: true },
  { id: 'mallorca', name: 'Circuit Mallorca (Llucmajor)', lat: 39.505, lon: 2.850, r: 3.5, approx: true },
  // Nürburgring: GP-Strecke por radio y Nordschleife por rectángulo (el lazo de 20,8 km)
  { id: 'nring-gp', group: 'nring', name: 'Nürburgring GP-Strecke', lat: 50.3330, lon: 6.9440, r: 1.1 },
  { id: 'nring-nords', group: 'nring', name: 'Nürburgring Nordschleife', box: [50.336, 6.905, 50.388, 7.022] }
];
let CUSTOM_CIRCUITS = []; // añadidos desde la app ("Guardar este circuito"), se cargan en prepare()
function inCircuit(c, loc) {
  if (c.box) return loc.lat >= c.box[0] && loc.lat <= c.box[2] && loc.lon >= c.box[1] && loc.lon <= c.box[3];
  return distKm(loc.lat, loc.lon, c.lat, c.lon) <= c.r;
}
function circuitAt(loc) {
  if (!loc || loc.lat == null) return null;
  return [...CUSTOM_CIRCUITS, ...CIRCUITS].find(c => inCircuit(c, loc)) || null;
}
// Nombre final de una sesión según las zonas recorridas (variantes del Nürburgring)
function sessionName(zones, fallback) {
  const z = new Set(zones || []);
  if (z.has('nring-gp') && z.has('nring-nords')) return 'Nürburgring 24h (GP + Nordschleife)';
  if (z.has('nring-nords')) return 'Nürburgring Nordschleife';
  if (z.has('nring-gp')) return 'Nürburgring GP-Strecke';
  return fallback;
}
const CIRCUIT_MIN_SHARE = 0.5; // para etiquetar un trayecto como circuito, al menos la mitad de los puntos dentro
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
      if (m === 'POST' && p === '/api/ford/connect') return json(await fordConnect(env, await req.json()));
      if (m === 'POST' && p === '/api/ford/refresh') return json(await fordRefresh(env));
      if (m === 'GET' && p === '/api/ford/status') return json(await fordStatus(env));
      if (m === 'GET' && p === '/api/circuits') return json(await circuitStats(env));
      if (m === 'POST' && p === '/api/circuits/custom') return json(await addCustomCircuit(env, await req.json()));
      if (m === 'DELETE' && p.startsWith('/api/circuits/custom/')) return json(await delCustomCircuit(env, decodeURIComponent(p.slice(21))));
      if (m === 'GET' && p === '/api/track') return json(await getTrack(env));
      if (m === 'POST' && p === '/api/track') return json(await setTrack(env, await req.json()));
      if (m === 'GET' && p === '/api/tyreset') return json(await getTyreSet(env));
      if (m === 'POST' && p === '/api/tyreset') return json(await setTyreSet(env, await req.json()));
      if (m === 'GET' && p === '/api/trackdays') return json(await trackDays(env));
      if (m === 'POST' && p === '/api/trackdays/note') return json(await setTrackNote(env, await req.json()));
      if (m === 'GET' && p === '/api/deadlines') return json(await listDeadlines(env));
      if (m === 'POST' && p === '/api/deadlines') return json(await saveDeadline(env, await req.json()));
      if (m === 'DELETE' && p.startsWith('/api/deadlines/')) return json(await deleteDeadline(env, decodeURIComponent(p.slice(15))));
      if (m === 'GET' && p === '/api/widget') return json(await widget(env));
      if (m === 'GET' && p === '/api/tyres') return json(await getTyrePrefs(env));
      if (m === 'POST' && p === '/api/tyres') return json(await setTyrePrefs(env, await req.json()));
      if (m === 'GET' && p === '/api/guard') return json(await getGuard(env));
      if (m === 'POST' && p === '/api/guard') return json(await setGuard(env, await req.json()));
      if (m === 'GET' && p === '/api/parking') return json(await getParking(env));
      if (m === 'POST' && p === '/api/parking') return json(await setParking(env, await req.json()));
      if (m === 'GET' && p === '/api/export') return json(await exportAll(env));
      if (m === 'GET' && p === '/api/trips/records') return json(await tripRecords(env));
      if (m === 'GET' && p === '/api/fuel') return json(await nearbyFuel(env, url.searchParams));
      if (m === 'POST' && p === '/api/fuel/fav') return json(await setFavStation(env, await req.json()));
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
    const poll = src(env) !== 'ford' || st.trip || minute % 5 === 0;
    if (poll) {
      try { await ingest(env, await readCar(env), st); } catch (e) { console.error('ingest', e); }
    }
    // En marcha el coche casi no manda nada por su cuenta: se le pide el estado cada 2 min la primera hora
    // y cada 5 min después (viajes largos), hasta 8 h por trayecto.
    const st2 = await loadState(env);
    const age = st2.trip ? Date.now() - st2.trip.start_ts : 0;
    if (src(env) === 'ford' && st2.trip && age < 8 * 3600e3) {
      try { await fordRefresh(env, { auto: true, every: age < 3600e3 ? 115e3 : 295e3 }); } catch (e) { console.error('autorefresh', e); }
    }
    await parkingTimer(env);
    await daily(env, event.scheduledTime);
  }
};

// ---------- Fuente de datos ----------

async function readCar(env) {
  const car = src(env) === 'ford' ? await fordCar(env) : mockCar(Date.now());
  applyTyrePrefs(car, await getTyrePrefs(env));
  const track = await getTrack(env);
  const here = circuitAt(car.location);
  car.circuit = here ? here.name : null;
  if (here) { track.active = true; track.auto = true; track.circuit = here.name; }
  car.track = track.active ? track : null;
  car.alerts = Object.entries(carAlerts(car)).filter(([k]) => !(track.active && k.startsWith('tyre_'))).map(([, v]) => v);
  return car;
}

// ---------- Ford real (mismas llamadas que la app oficial; ver pyfordpass) ----------

const FORD = {
  UA: 'okhttp/4.12.0', APP_ID: '667D773E-1BDC-4139-8AD0-2B16474E8DC7', COUNTRY: 'ESP', LOCALE: 'es-ES',
  FOUND: 'https://api.foundational.ford.com', TMC_ACC: 'https://accounts.autonomic.ai', TMC: 'https://api.autonomic.ai'
};

function jwtExp(t) {
  try {
    let p = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    return (JSON.parse(atob(p)).exp || 0) * 1000;
  } catch (e) { return 0; }
}

async function fordLoad(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford'").first();
  return row ? JSON.parse(row.v) : null;
}
async function fordSave(env, f) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford', ?)").bind(JSON.stringify(f)).run();
}

async function fordTokens(env) {
  const f = await fordLoad(env);
  if (!f || !f.cat_refresh) throw httpError('El coche no está conectado con Ford.', 409);
  const now = Date.now();
  let changed = false;
  if (!f.cat || !f.cat_exp || f.cat_exp - now < 120e3) {
    const r = await fetch(FORD.FOUND + '/api/token/v2/cat-with-refresh-token', {
      method: 'POST',
      headers: { 'application-id': FORD.APP_ID, 'content-type': 'application/json', 'user-agent': FORD.UA },
      body: JSON.stringify({ refresh_token: f.cat_refresh })
    });
    if (!r.ok) {
      f.error = `Renovar acceso: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      await fordSave(env, f);
      throw httpError('Ford ha rechazado el acceso guardado. Hay que volver a conectar la cuenta.', 502);
    }
    const j = await r.json();
    f.cat = j.access_token;
    if (j.refresh_token) f.cat_refresh = j.refresh_token;
    f.cat_exp = jwtExp(f.cat) || now + (j.expires_in || 1800) * 1000;
    f.tmc = null;
    changed = true;
  }
  if (!f.tmc || !f.tmc_exp || f.tmc_exp - now < 120e3) {
    const r = await fetch(FORD.TMC_ACC + '/v1/auth/oidc/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': FORD.UA },
      body: new URLSearchParams({
        client_id: 'fordpass-prod', grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_issuer: 'fordpass', subject_token: f.cat_refresh, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt'
      })
    });
    if (!r.ok) {
      f.error = `Token de telemetría: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`;
      await fordSave(env, f);
      throw httpError('Ford no ha dado acceso a la telemetría del coche.', 502);
    }
    const j = await r.json();
    f.tmc = j.access_token;
    f.tmc_exp = jwtExp(f.tmc) || now + (j.expires_in || 1800) * 1000;
    changed = true;
  }
  if (changed) { f.error = null; await fordSave(env, f); }
  return f;
}

async function fordCar(env) {
  const f = await fordTokens(env);
  const r = await fetch(`${FORD.TMC}/v1beta/telemetry/sources/fordpass/vehicles/${f.vin}:query`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + f.tmc, 'content-type': 'application/json', 'user-agent': FORD.UA },
    body: '{}'
  });
  if (!r.ok) {
    const t = (await r.text()).slice(0, 200);
    f.error = `Telemetría: HTTP ${r.status} ${t}`;
    if (r.status === 401) f.tmc = null;
    await fordSave(env, f);
    throw httpError(`Ford no ha devuelto datos del coche (HTTP ${r.status}).`, 502);
  }
  const data = await r.json();
  // Guardamos la última respuesta en bruto (como mucho una vez por hora) para ajustar la traducción.
  const raw = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_raw_at'").first();
  if (!raw || Date.now() - Number(raw.v) > 3600e3) {
    await env.DB.batch([
      env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_raw', ?)").bind(JSON.stringify(data).slice(0, 900000)),
      env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_raw_at', ?)").bind(String(Date.now()))
    ]);
  }
  return mapTelemetry(data);
}

const DOORS_ES = {
  DRIVER: 'puerta conductor', PASSENGER: 'puerta acompañante', UNSPECIFIED_FRONT: 'puerta delantera',
  REAR_LEFT: 'puerta trasera izq.', REAR_RIGHT: 'puerta trasera der.', TAILGATE: 'maletero', INNER_TAILGATE: 'maletero',
  HOOD: 'capó', HOOD_DOOR: 'capó', ROOF: 'techo'
};
const GEARS = { PARK: 'P', REVERSE: 'R', NEUTRAL: 'N', DRIVE: 'D', FIRST: 1, SECOND: 2, THIRD: 3, FOURTH: 4, FIFTH: 5, SIXTH: 6, SEVENTH: 7 };

function mapTelemetry(data) {
  const m = data.metrics || {};
  const val = k => { const e = m[k]; return e && !Array.isArray(e) && typeof e === 'object' ? e.value : undefined; };
  const num = x => (typeof x === 'number' ? x : x != null && x !== '' && !isNaN(+x) ? +x : null);
  const r1 = x => (x == null ? null : Math.round(x * 10) / 10);
  const ign = String(val('ignitionStatus') ?? 'OFF').toUpperCase();
  const running = !/OFF|LOCK/.test(ign) && /RUN|ON|START/.test(ign);
  const WHEEL = { FRONT_LEFT: 'fl', FRONT_RIGHT: 'fr', REAR_LEFT: 'rl', REAR_RIGHT: 'rr' };
  const tyres = {}, tyre_ref = {}, tyres_low = [];
  for (const t of Array.isArray(m.tirePressure) ? m.tirePressure : []) {
    const k = WHEEL[t.vehicleWheel];
    if (!k || t.value == null) continue;
    tyres[k] = Math.round(num(t.value)) / 100; // kPa → bar
    const ref = num(t.wheelPlacardFront ?? t.wheelPlacardRear);
    if (ref) tyre_ref[k] = Math.round(ref) / 100;
  }
  for (const t of Array.isArray(m.tirePressureStatus) ? m.tirePressureStatus : []) {
    const k = WHEEL[t.vehicleWheel];
    if (k && /LOW/i.test(String(t.value))) tyres_low.push(k);
  }
  for (const k in tyres) if (!tyres_low.includes(k) && tyre_ref[k] && tyres[k] < tyre_ref[k] * 0.88) tyres_low.push(k);
  const side = x => (x === 'DRIVER' ? 'izq.' : x === 'PASSENGER' ? 'der.' : '');
  const doors = Array.isArray(m.doorStatus) ? m.doorStatus : [];
  const doors_open = doors.filter(d => d.value && !/CLOSED|UNKNOWN|UNDEFINED/i.test(String(d.value)))
    .map(d => {
      const p = d.vehiclePart || d.vehicleDoor;
      if (p === 'UNSPECIFIED_FRONT') return 'puerta delantera ' + side(d.vehicleSide);
      return DOORS_ES[p] || String(p || 'puerta').toLowerCase();
    });
  if (val('hoodStatus') && !/CLOSED|UNDEFINED/i.test(String(val('hoodStatus')))) doors_open.push('capó');
  const windows_open = (Array.isArray(m.windowStatus) ? m.windowStatus : [])
    .filter(w => { const r = w.value && w.value.doubleRange; return r ? num(r.upperBound) > 0 : w.value && !/CLOSED|UNDEFINED/i.test(String(w.value)); })
    .map(w => 'ventana ' + (/REAR/.test(w.vehicleWindow) ? 'trasera ' : 'delantera ') + side(w.vehicleSide));
  let locked = null;
  const lk = m.doorLockStatus;
  if (Array.isArray(lk)) {
    const all = lk.find(d => /ALL/.test(String(d.vehicleDoor || ''))) || lk[0];
    if (all && all.value != null) locked = /LOCK/i.test(all.value) && !/UNLOCK/i.test(all.value);
  } else if (lk && lk.value != null) locked = /LOCK/i.test(lk.value) && !/UNLOCK/i.test(lk.value);
  const pos = val('position');
  const loc = pos && pos.location && pos.location.lat != null ? { lat: +pos.location.lat, lon: +pos.location.lon } : null;
  // En cambio manual Ford solo informa la marcha atrás y se queda la última lectura: si es más vieja que el arranque, no vale.
  const gUpd = m.gearLeverPosition && m.gearLeverPosition.updateTime ? Date.parse(m.gearLeverPosition.updateTime) : 0;
  const iUpd = m.ignitionStatus && m.ignitionStatus.updateTime ? Date.parse(m.ignitionStatus.updateTime) : 0;
  const gearRaw = gUpd && iUpd && gUpd < iUpd - 60e3 ? null : val('gearLeverPosition');
  let dataTs = 0;
  for (const k of ['ignitionStatus', 'position', 'odometer', 'fuelLevel', 'batteryVoltage']) {
    const t = m[k] && m[k].updateTime ? Date.parse(m[k].updateTime) : 0;
    if (t > dataTs) dataTs = t;
  }
  const brake = val('brakePedalStatus');
  return {
    ts: Date.now(),
    data_ts: dataTs || null,
    source: 'ford',
    odometer_km: r1(num(val('odometer'))),
    fuel_pct: num(val('fuelLevel')) != null ? r1(Math.min(100, num(val('fuelLevel')))) : null,
    range_km: num(val('fuelRange')) != null ? Math.round(num(val('fuelRange'))) : null,
    battery_v: num(val('batteryVoltage')) != null ? Math.round(num(val('batteryVoltage')) * 100) / 100 : null,
    tyres,
    tyre_ref,
    tyres_low,
    locked,
    doors_open,
    windows_open,
    ignition: running ? 'run' : 'off',
    ignition_raw: ign,
    battery_soc: num(val('batteryStateOfCharge')),
    parking_brake: val('parkingBrakeStatus') ? /ON|ENGAGED/i.test(String(val('parkingBrakeStatus'))) : null,
    alarm: val('alarmStatus') || null,
    speed_kmh: running ? Math.round((num(val('speed')) || 0) * 3.6) : 0, // Ford la manda en m/s
    gear: running ? (GEARS[String(gearRaw).toUpperCase()] ?? gearRaw ?? gearFrom(Math.round((num(val('speed')) || 0) * 3.6), num(val('engineSpeed')))) : null,
    rpm: running ? Math.round(num(val('engineSpeed')) || 0) : 0,
    throttle_pct: running ? Math.round(num(val('acceleratorPedalPosition')) || 0) : 0,
    brake_pct: running && (brake === true || /ON|APPLIED|PRESS/i.test(String(brake))) ? 100 : 0,
    oil_c: num(val('engineOilTemp')),
    coolant_c: num(val('engineCoolantTemp')),
    outside_c: num(val('outsideTemperature') ?? val('ambientTemp')),
    oil_life_pct: num(val('oilLifeRemaining')),
    location: loc,
    metrics_count: Object.keys(m).length
  };
}

// Pide al coche que se despierte y mande datos nuevos (como hace la app de Ford al abrirla).
// Limitado a una vez cada 10 minutos para no gastar batería.
async function fordRefresh(env, opts = {}) {
  if (src(env) !== 'ford') return { ok: false, error: 'Solo funciona con el coche real conectado.' };
  const last = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_refresh_at'").first();
  const wait = last ? (opts.auto ? (opts.every || 115e3) : 600e3) - (Date.now() - Number(last.v)) : 0;
  if (opts.auto && wait > 0) return { ok: false };
  if (wait > 0) return { ok: false, error: `Ya se pidió hace poco. Espera ${Math.ceil(wait / 60e3)} min para no gastar batería.` };
  const f = await fordTokens(env);
  const r = await fetch(`${FORD.TMC}/v1/command/vehicles/${f.vin}/commands`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + f.tmc, 'content-type': 'application/json', 'user-agent': FORD.UA },
    body: JSON.stringify({ properties: {}, tags: {}, type: 'statusRefresh', wakeUp: !opts.auto })
  });
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('ford_refresh_at', ?)").bind(String(Date.now())).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  if (!r.ok) return { ok: false, error: `Ford no ha aceptado la petición (HTTP ${r.status}).` };
  return { ok: true };
}

async function fordConnect(env, b) {
  if (!b || typeof b.cat_refresh !== 'string' || typeof b.vin !== 'string' || b.vin.length !== 17) throw httpError('Faltan los datos de Ford', 400);
  const f = { cat: typeof b.cat === 'string' ? b.cat : null, cat_refresh: b.cat_refresh, vin: b.vin.toUpperCase(), connected_at: Date.now() };
  f.cat_exp = f.cat ? jwtExp(f.cat) : 0;
  await fordSave(env, f);
  let car;
  try { car = await fordCar(env); }
  catch (e) { return { ok: false, error: e.message + ((await fordLoad(env)).error ? ' · ' + (await fordLoad(env)).error : '') }; }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('source', 'ford')").run();
  ready = false;
  return {
    ok: true,
    summary: { fuel_pct: car.fuel_pct, range_km: car.range_km, odometer_km: car.odometer_km, battery_v: car.battery_v, ignition: car.ignition_raw, fields: car.metrics_count }
  };
}

async function fordStatus(env) {
  const f = await fordLoad(env);
  const raw = await env.DB.prepare("SELECT v FROM kv WHERE k = 'ford_raw'").first();
  return {
    source: src(env), connected: !!(f && f.cat_refresh), vin_end: f && f.vin ? f.vin.slice(-6) : null,
    connected_at: f && f.connected_at, error: f && f.error,
    metrics: raw ? Object.keys(JSON.parse(raw.v).metrics || {}) : []
  };
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
    const low = Array.isArray(c.tyres_low) ? c.tyres_low.includes(k) : v != null && v < TYRE_MIN;
    const ref = c.tyre_ref && c.tyre_ref[k] ? `, recomendada ${fmt(c.tyre_ref[k], 2)}` : '';
    if (low) out['tyre_' + k] = `Presión baja en la rueda ${TYRE_NAMES[k] || k} (${fmt(v, 2)} bar${ref})`;
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
  const sameData = c.data_ts && st.last && st.last.dts === c.data_ts && c.ts - st.last.ts < 1800e3;
  if ((!st.last || c.ts - st.last.ts >= gap * 1000 || ignChanged) && !(sameData && !ignChanged)) {
    stmts.push(db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?)')
      .bind(c.ts, c.odometer_km, c.fuel_pct, c.battery_v, JSON.stringify(c)));
    if (st.snapFuel != null && c.fuel_pct - st.snapFuel >= 15) {
      const litres = round(((c.fuel_pct - st.snapFuel) / 100) * TANK_L, 1);
      stmts.push(db.prepare('INSERT OR REPLACE INTO refuels (ts, odometer, fuel_before, fuel_after, litres) VALUES (?, ?, ?, ?, ?)')
        .bind(c.ts, c.odometer_km, st.snapFuel, c.fuel_pct, litres));
      notes.push({ title: 'Repostaje detectado', body: `Unos ${fmt(litres, 1)} L. Toca para apuntar el precio.`, url: '#datos', tag: 'refuel' });
      st.newRefuel = { ts: c.ts, litres, lat: c.location?.lat, lon: c.location?.lon };
    }
    st.snapFuel = c.fuel_pct;
    st.last = { ts: c.ts, ignition: c.ignition, dts: c.data_ts || null };
  }

  // Trayectos
  if (running) {
    if (!st.trip) {
      if (opts.guard && guardActive(opts.guard, c.ts)) {
        notes.push({ title: '⚠️ El coche se ha encendido', body: `Tu Fiesta ST se ha puesto en marcha a las ${hhmm(c.ts)}. Si no eres tú, revisa dónde está.`, url: '#estado', tag: 'guard', urgent: true });
      }
      st.trip = {
        start_ts: c.data_ts && c.data_ts < c.ts ? c.data_ts : c.ts, start_odo: c.odometer_km, start_fuel: c.fuel_pct, start_oil: c.oil_c ?? c.coolant_c,
        start: c.location ? [c.location.lat, c.location.lon] : null, track: !!c.track,
        pts: [], n: 0, spd: 0, thr: 0, hi: 0, max_speed: 0, max_rpm: 0, max_oil: 0, warm: false, moving: 0, last_dts: 0
      };
    }
    const t = st.trip;
    // Solo cuentan las lecturas nuevas (Ford repite la última hasta que el coche manda otra)
    const fresh = !c.data_ts || c.data_ts !== t.last_dts;
    t.last_dts = c.data_ts || 0;
    if (fresh) {
    t.n++;
    if ((c.speed_kmh || 0) > 0) t.moving = (t.moving || 0) + 1;
    t.spd += c.speed_kmh || 0;
    t.thr += c.throttle_pct || 0;
    if ((c.rpm || 0) >= 4000) t.hi++;
    t.max_speed = Math.max(t.max_speed, c.speed_kmh || 0);
    t.max_rpm = Math.max(t.max_rpm, c.rpm || 0);
    t.max_oil = Math.max(t.max_oil, c.oil_c ?? c.coolant_c ?? 0);
    t.end_ts = c.ts; t.end_odo = c.odometer_km; t.end_fuel = c.fuel_pct;
    if (c.location) {
      t.end = [c.location.lat, c.location.lon];
      const lp = t.pts[t.pts.length - 1];
      const pts_ts = c.data_ts || c.ts;
      if (!lp || pts_ts - lp[3] >= POINT_GAP_S * 1000) t.pts.push([c.location.lat, c.location.lon, c.speed_kmh || 0, pts_ts]);
    }
    }
    const warmT = c.oil_c ?? c.coolant_c, warmMax = c.oil_c != null ? OIL_WARM : 85;
    if (!t.warm && t.start_oil != null && t.start_oil < 60 && warmT >= warmMax) {
      t.warm = true;
      notes.push({ title: 'Motor a temperatura', body: `${c.oil_c != null ? 'Aceite' : 'Refrigerante'} a ${warmT} °C. Ya puedes apretar.`, url: '#motor', tag: 'warm' });
    }
  } else if (st.trip) {
    const t = st.trip;
    const endOdo = c.odometer_km ?? t.end_odo;
    const km = round(endOdo - t.start_odo, 1);
    if (km >= 0.3) {
      if (c.data_ts && c.data_ts > t.start_ts) t.end_ts = c.data_ts; // hora real a la que se apagó
      const dur = Math.max(60, Math.round((t.end_ts - t.start_ts) / 1000));
      const noLive = !t.moving; // el coche no mandó nada en marcha: sin velocidad ni rpm reales
      // El aforador no es lineal: se corrige con el factor calibrado en los repostajes (litros reales / litros según aforador)
      const usedL = Math.max(0, ((t.start_fuel - (c.fuel_pct ?? t.end_fuel)) / 100) * TANK_L) * (opts.fuelFactor || 1);
      const pts = t.pts.slice();
      if (c.location) pts.push([c.location.lat, c.location.lon, 0, c.data_ts || c.ts]);
      const end = c.location ? [c.location.lat, c.location.lon] : t.end;
      const sess = tripCircuit(t, pts, c);
      stmts.push(db.prepare(`INSERT INTO trips (start_ts, end_ts, start_odo, end_odo, km, duration_s, avg_speed, max_speed,
          max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l, start_lat, start_lon, end_lat, end_lon, points, track, circuit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(t.start_ts, t.end_ts, t.start_odo, endOdo, km, dur, Math.round(km / (dur / 3600)), noLive ? null : t.max_speed,
          noLive ? null : t.max_rpm, Math.max(t.max_oil, c.oil_c ?? c.coolant_c ?? 0), noLive ? null : Math.round(t.thr / Math.max(1, t.n)), noLive ? null : Math.round((t.hi / Math.max(1, t.n)) * 100), round(usedL, 2),
          t.start?.[0] ?? null, t.start?.[1] ?? null, end?.[0] ?? null, end?.[1] ?? null, JSON.stringify(pts), sess.track ? 1 : 0, sess.circuit));
    }
    st.trip = null;
    if (c.location) st.parked = { ts: c.ts, lat: c.location.lat, lon: c.location.lon };
  } else if (opts.guard && c.location && st.parked && distKm(st.parked.lat, st.parked.lon, c.location.lat, c.location.lon) > 0.3 && !st.movedAlerted) {
    st.movedAlerted = true;
    notes.push({ title: '⚠️ El coche se ha movido', body: 'Se ha desplazado más de 300 m con el motor apagado (¿grúa?). Revisa la ubicación.', url: '#estado', tag: 'moved', urgent: true });
  }
  if (running) st.movedAlerted = false;

  // Llegada / salida de un circuito
  // Solo cuenta si se queda dentro: aparcado en el recinto o 5 lecturas seguidas en marcha (no al pasar por al lado).
  const circ = circuitAt(c.location);
  const key = circ ? (circ.group || circ.id) : null;
  st.circuitPolls = key && key === st.circuitKey ? (st.circuitPolls || 0) + 1 : key ? 1 : 0;
  st.circuitKey = key;
  const settled = circ && (!running || st.circuitPolls >= 5);
  if (settled && st.circuit !== key && !opts.silent) {
    notes.push({ title: '🏁 ' + (circ.group === 'nring' ? 'Nürburgring' : circ.name), body: 'Modo circuito activado: sin avisos de presión y trayectos guardados como circuito.', url: '#viajes', tag: 'circuit' });
  }
  if (settled) st.circuit = key; else if (!circ) st.circuit = null;
  if (circ && st.trip) {
    st.trip.zones = [...new Set([...(st.trip.zones || []), circ.id])];
    st.trip.circuit = circ.group ? null : circ.name;
  }

  // Avisos (solo cuando aparecen)
  const cur = carAlerts(c);
  if (cur.unlocked) {
    st.unlockedSince = st.unlockedSince || c.ts;
    if (c.ts - st.unlockedSince < UNLOCKED_GRACE_S * 1000) delete cur.unlocked;
  } else st.unlockedSince = null;
  if (c.track) for (const k in cur) if (k.startsWith('tyre_')) delete cur[k];
  for (const k in cur) {
    if (!st.alerts.includes(k)) notes.push({ title: 'Fiesta ST', body: cur[k], url: '#estado', tag: k });
  }
  st.alerts = Object.keys(cur);
  return { stmts, notes };
}

async function ingest(env, car, st) {
  st = st || await loadState(env);
  applyTyrePrefs(car, await getTyrePrefs(env));
  const guard = await getGuard(env);
  const ff = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
  const { stmts, notes } = processCar(env.DB, st, car, { guard, fuelFactor: ff ? Number(ff.v) : 1 });
  if (car.ignition === 'off' && car.location && !st.parked) {
    st.parked = { ts: car.data_ts || car.ts, lat: car.location.lat, lon: car.location.lon };
    const has = await env.DB.prepare("SELECT 1 AS x FROM kv WHERE k = 'parking'").first();
    if (!has) stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  }
  if (st.trip == null && st.parked && st.parked.ts === car.ts) {
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  }
  const nr = st.newRefuel;
  delete st.newRefuel;
  if (nr && nr.lat != null) {
    try {
      const type = env.FUEL_TYPE || '98';
      const { list } = await fuelStationsNear(env, nr.lat, nr.lon);
      const near = list.map(s => ({ ...s, km: distKm(nr.lat, nr.lon, s.lat, s.lon) })).filter(s => s.km < 0.35 && s['p' + type]).sort((a, b) => a.km - b.km)[0];
      if (near) {
        const price = near['p' + type];
        const total = round(price * nr.litres, 2);
        stmts.push(env.DB.prepare('UPDATE refuels SET price_total = ?, station = ?, price_auto = 1 WHERE ts = ? AND price_total IS NULL').bind(total, near.name, nr.ts));
        const n = notes.find(x => x.tag === 'refuel');
        if (n) n.body = `${near.name}: unos ${fmt(nr.litres, 1)} L a ${fmt(price, 3)} €/L ≈ ${fmt(total, 2)} €. Toca para corregirlo.`;
      }
    } catch (e) { console.error('precio auto', e); }
  }
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
  if (local.getUTCDay() === 1) {
    try { await sendPushAll(env, await weeklySummary(env)); } catch (e) { console.error('semanal', e); }
  }
  // Fechas (ITV, seguro, impuesto): a 30, 7 y 1 días y el mismo día
  const { items: dl } = await listDeadlines(env);
  const hits = dl.filter(d => d.days != null && [30, 7, 1, 0].includes(d.days));
  if (hits.length) await sendPushAll(env, { title: 'Fechas del coche', url: '#taller', tag: 'deadline',
    body: hits.map(d => `${d.name}: ${d.days === 0 ? 'vence hoy' : d.days === 1 ? 'vence mañana' : 'vence en ' + d.days + ' días'}`).join(' · ') });
  // Coche parado varios días con la batería baja
  const st = await loadState(env);
  const last = await env.DB.prepare('SELECT battery_v AS battery FROM snapshots ORDER BY ts DESC LIMIT 1').first();
  if (st.parked && !st.trip && Date.now() - st.parked.ts > 3 * 86400e3 && last && last.battery != null && last.battery < 12.3) {
    await sendPushAll(env, { title: 'Batería baja', body: `Lleva ${Math.floor((Date.now() - st.parked.ts) / 86400e3)} días parado y la batería está a ${fmt(last.battery, 2)} V. Arráncalo y da una vuelta de 20 min.`, url: '#estado', tag: 'batt_idle' });
  }
  const b = await getBattery(env, 14);
  if (b.status === 'bajando') {
    await sendPushAll(env, { title: 'Batería de 12 V', body: `Va bajando unos ${fmt(Math.abs(b.slope), 2)} V al día. Conviene revisarla.`, url: '#datos', tag: 'batt_trend' });
  }
}

// ---------- Base de datos ----------

let ready = false, SRC = null;
function src(env) { return SRC || env.SOURCE || 'mock'; }
async function prepare(env) {
  const db = env.DB;
  const [, srcRow, ccRes] = await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare("SELECT v FROM kv WHERE k = 'source'"),
    db.prepare("SELECT v FROM kv WHERE k = 'custom_circuits'")
  ]);
  const ccRow = ccRes;
  try { CUSTOM_CIRCUITS = JSON.parse((ccRow && ccRow.results[0] && ccRow.results[0].v) || '[]'); } catch (e) { CUSTOM_CIRCUITS = []; }
  const s = (srcRow.results && srcRow.results[0] && srcRow.results[0].v) || env.SOURCE || 'mock';
  if (ready && s === SRC) return;
  SRC = s;
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
    db.prepare('CREATE TABLE IF NOT EXISTS refuels (ts INTEGER PRIMARY KEY, odometer REAL, fuel_before REAL, fuel_after REAL, litres REAL, price_total REAL, station TEXT, price_auto INTEGER)'),
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
  try { await db.prepare('ALTER TABLE trips ADD COLUMN track INTEGER DEFAULT 0').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE trips ADD COLUMN circuit TEXT').run(); } catch (e) { /* ya existe */ }
  try { await db.prepare('ALTER TABLE refuels ADD COLUMN price_l REAL').run(); } catch (e) { /* ya existe */ }
  const mc = await db.prepare('SELECT COUNT(*) AS n FROM maintenance').first();
  if (!mc.n) {
    await db.batch(DEFAULT_MAINT.map(([n, km, mo]) =>
      db.prepare('INSERT INTO maintenance (name, interval_km, interval_months) VALUES (?, ?, ?)').bind(n, km, mo)));
  }
  const demo = await db.prepare("SELECT v FROM kv WHERE k = 'demo'").first();
  if (src(env) === 'ford' && demo) {
    // Al pasar a datos reales se borran los de prueba (el mantenimiento se conserva).
    await db.batch([
      db.prepare('DELETE FROM snapshots'),
      db.prepare('DELETE FROM refuels'),
      db.prepare('DELETE FROM trips'),
      db.prepare("DELETE FROM kv WHERE k IN ('demo', 'state', 'live_cache', 'parking')")
    ]);
  } else if (src(env) !== 'ford' && !demo) {
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
  delete st.newRefuel;
  if (st.parked) all.push(db.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify({ ...st.parked, note: null, timer_at: null })));
  all.push(stateStmt(db, st));
  all.push(db.prepare("INSERT OR REPLACE INTO kv VALUES ('demo', '1')"));
  for (let i = 0; i < all.length; i += 250) await db.batch(all.slice(i, i + 250));
}

// ---------- Endpoints ----------

async function getLive(env, ctx) {
  if (src(env) === 'ford') {
    const cached = await env.DB.prepare("SELECT v FROM kv WHERE k = 'live_cache'").first();
    if (cached) {
      const c = JSON.parse(cached.v);
      if (Date.now() - c.ts < LIVE_MIN_INTERVAL_S * 1000) return c;
    }
  }
  const car = await readCar(env);
  if (src(env) === 'ford') {
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
      if (km > 20 && r.fuel_before != null && p.fuel_after != null) { l100 = round((used / km) * 100, 1); totalUsed += used; totalKm += km; }
    }
    const price_l = r.price_total && r.litres ? round(r.price_total / r.litres, 3) : r.price_l ?? null;
    return { ...r, km, l100, price_l };
  }).reverse();
  return { refuels: list, avg_l100: totalKm ? round((totalUsed / totalKm) * 100, 1) : null, tank_l: TANK_L };
}

// Calibra el aforador: litros reales del repostaje frente a lo que marcó el depósito desde el anterior lleno
async function calibrateFuel(env, ts, litres) {
  const prev = await env.DB.prepare('SELECT ts, fuel_after FROM refuels WHERE ts < ? ORDER BY ts DESC LIMIT 1').bind(ts).first();
  const cur = await env.DB.prepare('SELECT fuel_before, fuel_after FROM refuels WHERE ts = ?').bind(ts).first();
  if (!prev || !cur || cur.fuel_before == null || cur.fuel_after < 95 || prev.fuel_after < 95) return null;
  const gauge = ((prev.fuel_after - cur.fuel_before) / 100) * TANK_L;
  if (gauge < 10) return null;
  const f = Math.min(1.25, Math.max(0.75, litres / gauge));
  const old = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fuel_factor'").first();
  const nf = old ? round(Number(old.v) * 0.5 + f * 0.5, 3) : round(f, 3);
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fuel_factor', ?)").bind(String(nf)).run();
  return nf;
}

async function updateRefuel(env, ts, body) {
  if (body.litres != null && body.litres !== '') {
    const l = Number(String(body.litres).replace(',', '.'));
    if (!(l > 1 && l <= TANK_L + 2)) throw httpError('Los litros no son válidos', 400);
    await env.DB.prepare('UPDATE refuels SET litres = ? WHERE ts = ?').bind(l, ts).run();
    await calibrateFuel(env, ts, l);
  }
  const price = body.price_total === null || body.price_total === '' ? null : Number(body.price_total);
  if (price !== null && !(price > 0 && price < 1000)) throw httpError('El precio no es válido', 400);
  const station = body.station ? String(body.station).slice(0, 80) : null;
  const r = await env.DB.prepare('UPDATE refuels SET price_total = ?, station = ? WHERE ts = ?').bind(price, station, ts).run();
  if (!r.meta.changes) throw httpError('Repostaje no encontrado', 404);
  return { ok: true };
}

async function listTrips(env, limit) {
  const { results } = await env.DB.prepare(
    `SELECT id, start_ts, end_ts, km, duration_s, avg_speed, max_speed, max_rpm, max_oil, avg_throttle, rpm_high_pct, fuel_used_l,
     track, circuit, points FROM trips ORDER BY start_ts DESC LIMIT ?`
  ).bind(limit).all();
  const price = await priceFinder(env);
  return {
    trips: results.map(({ points, ...t }) => {
      const sp = JSON.parse(points || '[]').map(p => p[2]);
      const n = 16, spark = [];
      if (sp.length > 1) for (let i = 0; i < n; i++) spark.push(sp[Math.round(i * (sp.length - 1) / (n - 1))]);
      return { ...t, spark, cost_eur: t.fuel_used_l != null ? round(t.fuel_used_l * price(t.start_ts), 2) : null };
    })
  };
}

async function getTrip(env, id) {
  const t = await env.DB.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first();
  if (!t) throw httpError('Trayecto no encontrado', 404);
  let route = null;
  if (t.start_lat != null && t.end_lat != null) {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(duration_s) AS dur, MIN(duration_s) AS best, AVG(avg_speed) AS spd,
        SUM(fuel_used_l) AS fuel, SUM(km) AS km FROM trips
       WHERE id != ? AND COALESCE(track, 0) = 0 AND round(start_lat, 2) = round(?, 2) AND round(start_lon, 2) = round(?, 2)
         AND round(end_lat, 2) = round(?, 2) AND round(end_lon, 2) = round(?, 2)`
    ).bind(id, t.start_lat, t.start_lon, t.end_lat, t.end_lon).first();
    if (r && r.n) route = { count: r.n, avg_duration_s: Math.round(r.dur), best_duration_s: r.best, avg_speed: Math.round(r.spd), avg_l100: r.km ? round(r.fuel / r.km * 100, 1) : null };
  }
  const price = await priceFinder(env);
  if (route) route.avg_cost_eur = r2(route.avg_l100 != null ? route.avg_l100 / 100 * t.km * price(t.start_ts) : null);
  return { ...t, points: JSON.parse(t.points || '[]'), route, ...(await tripSeries(env, t)), cost_eur: t.fuel_used_l != null ? round(t.fuel_used_l * price(t.start_ts), 2) : null, price_l: round(price(t.start_ts), 3) };
}

const r2 = v => v == null ? null : Math.round(v * 100) / 100;
// Relación km/h por cada 1.000 rpm de cada marcha (Fiesta ST Mk8, aprox.): sirve para deducir la marcha,
// porque en cambio manual Ford no la manda.
const GEAR_KMH_PER_1000 = [7.6, 13.4, 20.3, 27.0, 33.6, 40.6];
function gearFrom(speed, rpm) {
  if (!speed || speed < 8 || !rpm || rpm < 1100) return null;
  const r = speed / (rpm / 1000);
  let best = null, err = 1e9;
  GEAR_KMH_PER_1000.forEach((g, i) => { const e = Math.abs(r - g) / g; if (e < err) { err = e; best = i + 1; } });
  return err < 0.12 ? best : null; // embrague pisado o punto muerto: sin marcha
}

// Lecturas del coche durante el trayecto (una por cada dato nuevo que mandó)
async function tripSeries(env, t) {
  const { results } = await env.DB.prepare('SELECT data FROM snapshots WHERE ts BETWEEN ? AND ? ORDER BY ts')
    .bind(t.start_ts - 60e3, t.end_ts + 300e3).all();
  const seen = new Set(), series = [];
  for (const r of results) {
    let c; try { c = JSON.parse(r.data); } catch (e) { continue; }
    const k = c.data_ts || c.ts;
    if (seen.has(k) || k < t.start_ts - 60e3 || k > t.end_ts + 60e3) continue;
    seen.add(k);
    const ty = c.tyres || {};
    series.push({ ts: k, spd: c.speed_kmh || 0, rpm: c.rpm || 0, temp: c.oil_c ?? c.coolant_c ?? null, fuel: c.fuel_pct, bat: c.battery_v,
      thr: c.throttle_pct || 0, brake: c.brake_pct || 0, gear: gearFrom(c.speed_kmh, c.rpm),
      tf: ty.fl != null && ty.fr != null ? r2((ty.fl + ty.fr) / 2) : null, tr: ty.rl != null && ty.rr != null ? r2((ty.rl + ty.rr) / 2) : null });
  }
  const moving = series.filter(p => p.spd > 0);
  const stats = series.length > 3 ? {
    highway_pct: moving.length ? Math.round(moving.filter(p => p.spd >= 90).length / moving.length * 100) : null,
    city_pct: moving.length ? Math.round(moving.filter(p => p.spd < 50).length / moving.length * 100) : null,
    cruise_rpm: (() => { const h = series.filter(p => p.spd >= 110 && p.spd <= 125); return h.length ? Math.round(h.reduce((a, p) => a + p.rpm, 0) / h.length) : null; })(),
    warm_min: (() => { const w = series.find(p => p.temp != null && p.temp >= OIL_WARM); return w ? Math.max(0, Math.round((w.ts - t.start_ts) / 60e3)) : null; })(),
    tyre_rise: (() => { const a = series.find(p => p.tf != null), b = [...series].reverse().find(p => p.tf != null); return a && b ? { front: r2(b.tf - a.tf), rear: r2(b.tr - a.tr), from: [a.tf, a.tr], to: [b.tf, b.tr] } : null; })(),
    alternator_v: (() => { const v = series.filter(p => p.rpm > 1500 && p.bat).map(p => p.bat); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; })(),
    gears: (() => { const g = {}; for (const p of series) if (p.gear) g[p.gear] = (g[p.gear] || 0) + 1; return g; })()
  } : null;
  return { series, stats };
}

const hhmm = ts => new Date(ts + 3600e3).toISOString().slice(11, 16);

// Precio por litro para un momento dado: último repostaje con precio antes de esa fecha,
// si no el más reciente, si no la media de gasolineras cercanas, si no 1,70 €/L.
async function priceFinder(env) {
  const { results } = await env.DB.prepare('SELECT ts, COALESCE(price_l, price_total / litres) AS pl FROM refuels WHERE price_l > 0 OR (price_total > 0 AND litres > 0) ORDER BY ts').all();
  let fallback = 1.70;
  const fc = await env.DB.prepare("SELECT v FROM kv WHERE k LIKE 'fuel_cache_%' LIMIT 1").first();
  if (fc) {
    const key = 'p' + (env.FUEL_TYPE || '98');
    const ps = JSON.parse(fc.v).list.map(s => s[key]).filter(Boolean);
    if (ps.length) fallback = ps.reduce((a, b) => a + b, 0) / ps.length;
  }
  return ts => {
    let p = null;
    for (const r of results) { if (r.ts <= ts) p = r.pl; else break; }
    return p ?? (results.length ? results[results.length - 1].pl : fallback);
  };
}

// ---------- Vigilancia y aparcamiento ----------

function tripCircuit(t, pts, c) {
  const inside = pts.map(p => circuitAt({ lat: p[0], lon: p[1] }));
  const hits = inside.filter(Boolean);
  const manual = !!(t.track || c.track) && !(c.track && c.track.auto);
  if (!hits.length || hits.length / pts.length < CIRCUIT_MIN_SHARE) return { track: manual, circuit: null };
  const zones = [...new Set(hits.map(h => h.id))];
  const counts = {};
  for (const h of hits) counts[h.name] = (counts[h.name] || 0) + 1;
  const main = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return { track: true, circuit: sessionName(zones, main) };
}

async function saveCustom(env) {
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('custom_circuits', ?)").bind(JSON.stringify(CUSTOM_CIRCUITS)).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return { custom: CUSTOM_CIRCUITS };
}

// Guarda la ubicación actual del coche como circuito (para los que no están en la lista).
async function addCustomCircuit(env, b) {
  const car = await readCar(env);
  if (!car.location) return { error: 'No hay ubicación del coche' };
  const name = String(b.name || '').trim().slice(0, 40) || 'Circuito';
  const r = Math.min(3, Math.max(0.5, Number(b.r) || 1.2));
  CUSTOM_CIRCUITS = CUSTOM_CIRCUITS.filter(c => distKm(c.lat, c.lon, car.location.lat, car.location.lon) > 0.5);
  CUSTOM_CIRCUITS.push({ id: 'custom-' + Date.now(), name, lat: round(car.location.lat, 5), lon: round(car.location.lon, 5), r });
  return saveCustom(env);
}

async function delCustomCircuit(env, id) {
  CUSTOM_CIRCUITS = CUSTOM_CIRCUITS.filter(c => c.id !== id);
  return saveCustom(env);
}

// ---------- Frenos: el circuito desgasta más ----------
const PAD_TRACK_FACTOR = 5;      // 1 km de circuito ≈ 5 km de carretera para las pastillas
const FLUID_DAYS_PER_TRACKDAY = 60; // cada día de circuito adelanta 2 meses el cambio de líquido

async function trackSince(env, dateStr) {
  const since = dateStr ? Date.parse(dateStr + 'T00:00:00Z') : 0;
  const r = await env.DB.prepare(`SELECT COALESCE(SUM(km), 0) AS km, COUNT(DISTINCT date((start_ts + 3600000) / 1000, 'unixepoch')) AS days
    FROM trips WHERE track = 1 AND start_ts >= ?`).bind(since).first();
  return { km: r ? r.km : 0, days: r ? r.days : 0 };
}

async function brakeWear(env, i, odo) {
  if (!i.last_date && i.last_km == null) return i;
  if (/pastilla|disco/i.test(i.name) && i.interval_km && i.last_km != null) {
    const t = await trackSince(env, i.last_date);
    if (t.km > 0) {
      const extra = Math.round(t.km * (PAD_TRACK_FACTOR - 1));
      return { ...i, last_km: i.last_km - extra, track_note: `${fmt(t.km, 0)} km en circuito cuentan como ${fmt(t.km * PAD_TRACK_FACTOR, 0)}` };
    }
  }
  if (/l[ií]quido de frenos/i.test(i.name) && i.interval_months && i.last_date) {
    const t = await trackSince(env, i.last_date);
    if (t.days > 0) {
      const d = new Date(i.last_date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - t.days * FLUID_DAYS_PER_TRACKDAY);
      return { ...i, last_date: d.toISOString().slice(0, 10), real_last_date: i.last_date, track_note: `${t.days} día${t.days > 1 ? 's' : ''} de circuito: adelanta el cambio` };
    }
  }
  return i;
}

// ---------- Neumáticos montados ----------
async function getTyreSet(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_set'").first();
  const t = row ? JSON.parse(row.v) : { model: null, size: null, mounted_date: null, mounted_km: null, rotated_km: null };
  const odo = await currentOdo(env);
  const out = { ...t, odometer: odo, km: null, track_km: 0, track_days: 0, rotate_in_km: null };
  if (t.mounted_km != null && odo != null) out.km = Math.max(0, Math.round(odo - t.mounted_km));
  if (t.mounted_date) Object.assign(out, (({ km, days }) => ({ track_km: round(km, 1), track_days: days }))(await trackSince(env, t.mounted_date)));
  const base = t.rotated_km ?? t.mounted_km;
  if (base != null && odo != null) out.rotate_in_km = Math.round(base + 10000 - odo);
  return out;
}

async function setTyreSet(env, b) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_set'").first();
  const t = row ? JSON.parse(row.v) : {};
  const n = v => (v === '' || v == null || isNaN(Number(String(v).replace(/\./g, '').replace(',', '.'))) ? null : Math.round(Number(String(v).replace(/\./g, '').replace(',', '.'))));
  if (b.rotated) t.rotated_km = await currentOdo(env);
  else {
    t.model = String(b.model || '').trim().slice(0, 60) || null;
    t.size = String(b.size || '').trim().slice(0, 30) || null;
    t.mounted_date = /^\d{4}-\d{2}-\d{2}$/.test(b.mounted_date || '') ? b.mounted_date : null;
    t.mounted_km = n(b.mounted_km);
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('tyre_set', ?)").bind(JSON.stringify(t)).run();
  return getTyreSet(env);
}

// ---------- Días de circuito ----------
async function trackDays(env) {
  const { results } = await env.DB.prepare(
    `SELECT date((start_ts + 3600000) / 1000, 'unixepoch') AS day, COALESCE(circuit, 'Circuito') AS circuit,
      COUNT(*) AS sessions, SUM(km) AS km, SUM(duration_s) AS secs, MAX(max_speed) AS top_speed, MAX(max_rpm) AS top_rpm,
      MAX(max_oil) AS top_temp, SUM(fuel_used_l) AS fuel_l, MIN(start_ts) AS first_ts
     FROM trips WHERE track = 1 GROUP BY day, COALESCE(circuit, 'Circuito') ORDER BY day DESC LIMIT 60`).all();
  const price = await priceFinder(env);
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track_notes'").first();
  const notes = row ? JSON.parse(row.v) : {};
  return { days: results.map(d => ({ ...d, km: round(d.km || 0, 1), fuel_l: d.fuel_l != null ? round(d.fuel_l, 1) : null,
    cost_eur: d.fuel_l != null ? round(d.fuel_l * price(d.first_ts), 2) : null, note: notes[d.day + '|' + d.circuit] || '' })) };
}

async function setTrackNote(env, b) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track_notes'").first();
  const notes = row ? JSON.parse(row.v) : {};
  const key = String(b.day || '') + '|' + String(b.circuit || '');
  const note = String(b.note || '').trim().slice(0, 2000);
  if (note) notes[key] = note; else delete notes[key];
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('track_notes', ?)").bind(JSON.stringify(notes)).run();
  return { ok: true };
}

// ---------- Fechas: ITV, seguro, impuesto ----------
async function rawDeadlines(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'deadlines'").first();
  return row ? JSON.parse(row.v) : [
    { id: 'itv', name: 'ITV', date: null }, { id: 'seguro', name: 'Seguro', date: null }, { id: 'ivtm', name: 'Impuesto de circulación', date: null }
  ];
}

async function listDeadlines(env) {
  const now = Date.now();
  const items = (await rawDeadlines(env)).map(d => {
    const days = d.date ? Math.ceil((Date.parse(d.date + 'T00:00:00Z') - now) / 86400e3) : null;
    return { ...d, days, status: days == null ? 'sin datos' : days < 0 ? 'vencido' : days <= 30 ? 'pronto' : 'ok' };
  }).sort((a, b) => (a.days ?? 1e9) - (b.days ?? 1e9));
  return { items };
}

async function saveDeadline(env, b) {
  const list = await rawDeadlines(env);
  const name = String(b.name || '').trim().slice(0, 50);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null;
  const i = list.findIndex(d => d.id === b.id);
  if (i >= 0) list[i] = { ...list[i], name: name || list[i].name, date };
  else { if (!name) throw httpError('Ponle un nombre', 400); list.push({ id: 'd' + Date.now(), name, date }); }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('deadlines', ?)").bind(JSON.stringify(list)).run();
  return listDeadlines(env);
}

async function deleteDeadline(env, id) {
  const list = (await rawDeadlines(env)).filter(d => d.id !== id);
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('deadlines', ?)").bind(JSON.stringify(list)).run();
  return listDeadlines(env);
}

// ---------- Widget (Scriptable / Atajos) ----------
async function widget(env) {
  const c = await readCar(env);
  return {
    range_km: c.range_km, fuel_pct: c.fuel_pct, locked: c.locked, doors_open: c.doors_open || [],
    tyres: c.tyres, tyres_low: c.tyres_low || [], battery_v: c.battery_v, odometer_km: c.odometer_km,
    alerts: c.alerts || [], data_ts: c.data_ts || c.ts, circuit: c.circuit || null,
    engine_c: c.oil_c ?? c.coolant_c ?? null, oil_life_pct: c.oil_life_pct ?? null, battery_soc: c.battery_soc ?? null,
    ignition: c.ignition, speed_kmh: c.speed_kmh || 0, next: await widgetNext(env)
  };
}

// Lo próximo que toca: fecha o mantenimiento más cercano
async function widgetNext(env) {
  try {
    const { items: dl } = await listDeadlines(env);
    const { items: mt } = await listMaint(env);
    const c = [];
    for (const d of dl) if (d.days != null && d.days <= 60) c.push({ text: d.days < 0 ? `${d.name} vencido` : `${d.name} en ${d.days} d`, urgent: d.days <= 7, w: d.days });
    for (const m of mt) if (m.status === 'vencido' || m.status === 'pronto') c.push({ text: `${m.name}: ${m.summary.split(' · ')[0]}`, urgent: m.status === 'vencido', w: m.status === 'vencido' ? -1 : 30 });
    c.sort((a, b) => a.w - b.w);
    return c[0] || null;
  } catch (e) { return null; }
}

async function circuitStats(env) {
  const { results } = await env.DB.prepare(
    `SELECT circuit, COUNT(*) AS sessions, COUNT(DISTINCT date((start_ts + 3600000) / 1000, 'unixepoch')) AS days,
      MAX(max_speed) AS top_speed, MAX(max_rpm) AS top_rpm, MAX(max_oil) AS top_temp, SUM(km) AS km,
      SUM(duration_s) AS secs, MAX(start_ts) AS last_ts
     FROM trips WHERE circuit IS NOT NULL GROUP BY circuit ORDER BY last_ts DESC`
  ).all();
  return { circuits: results, known: CIRCUITS.map(c => c.name), custom: CUSTOM_CIRCUITS };
}

async function getTrack(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'track'").first();
  const t = row ? JSON.parse(row.v) : {};
  return { until: t.until || null, active: !!(t.until && t.until > Date.now()) };
}

async function setTrack(env, b) {
  let until = null;
  if (b.until === 'midnight') {
    const d = new Date(Date.now() + 3600e3);
    d.setUTCHours(23, 59, 0, 0);
    until = d.getTime() - 3600e3;
  } else if (Number(b.hours) > 0 && Number(b.hours) <= 24) until = Date.now() + Number(b.hours) * 3600e3;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('track', ?)").bind(JSON.stringify({ until })).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return getTrack(env);
}

// Presiones de referencia propias (bar). Si no hay, se usan las que manda el coche.
async function getTyrePrefs(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'tyre_prefs'").first();
  return { front: null, rear: null, ...(row ? JSON.parse(row.v) : {}) };
}

async function setTyrePrefs(env, b) {
  const v = x => { const n = parseFloat(String(x ?? '').replace(',', '.')); return n >= 1.5 && n <= 3.5 ? Math.round(n * 100) / 100 : null; };
  const t = { front: v(b.front), rear: v(b.rear) };
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('tyre_prefs', ?)").bind(JSON.stringify(t)).run();
  await env.DB.prepare("DELETE FROM kv WHERE k = 'live_cache'").run();
  return t;
}

function applyTyrePrefs(car, pr) {
  if (!car || !car.tyres || (!pr.front && !pr.rear)) return car;
  const car_ref = car.tyre_ref || {};
  const ref = { ...car_ref };
  if (pr.front) ref.fl = ref.fr = pr.front;
  if (pr.rear) ref.rl = ref.rr = pr.rear;
  car.tyre_ref = ref;
  car.tyre_ref_custom = true;
  // Baja: más de un 12 % por debajo de tu presión, o el coche la marca como baja
  const carLow = car.tyres_low_car || car.tyres_low || [];
  car.tyres_low_car = carLow;
  car.tyres_low = Object.keys(car.tyres).filter(k => car.tyres[k] != null && ((ref[k] && car.tyres[k] < ref[k] * 0.88) || carLow.includes(k)));
  return car;
}

async function getGuard(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'guard'").first();
  return { enabled: false, night: true, from: '00:00', to: '06:00', ...(row ? JSON.parse(row.v) : {}) };
}

async function setGuard(env, b) {
  const t = v => (/^\d{2}:\d{2}$/.test(v || '') ? v : null);
  const g = { ...(await getGuard(env)) };
  if (typeof b.enabled === 'boolean') g.enabled = b.enabled;
  if (typeof b.night === 'boolean') g.night = b.night;
  if (t(b.from)) g.from = b.from;
  if (t(b.to)) g.to = b.to;
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('guard', ?)").bind(JSON.stringify(g)).run();
  return g;
}

function guardActive(g, ts) {
  if (g.enabled) return true;
  if (!g.night) return false;
  const now = hhmm(ts);
  return g.from <= g.to ? now >= g.from && now < g.to : now >= g.from || now < g.to;
}

async function getParking(env) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'parking'").first();
  return row ? JSON.parse(row.v) : null;
}

async function setParking(env, b) {
  const p = await getParking(env);
  if (!p) throw httpError('Todavía no hay ningún aparcamiento guardado', 404);
  if ('note' in b) p.note = b.note ? String(b.note).slice(0, 120) : null;
  if ('minutes' in b) {
    const min = Number(b.minutes);
    p.timer_at = min > 0 && min <= 24 * 60 ? Date.now() + min * 60e3 : null;
    p.timer_warned = false;
  }
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify(p)).run();
  return p;
}

async function parkingTimer(env) {
  const p = await getParking(env);
  if (!p || !p.timer_at) return;
  const left = p.timer_at - Date.now();
  if (left <= 10 * 60e3 && !p.timer_warned) {
    p.timer_warned = true;
    await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('parking', ?)").bind(JSON.stringify(p)).run();
    await sendPushAll(env, { title: 'Aparcamiento', body: left > 60e3 ? `Te quedan ${Math.round(left / 60e3)} minutos de aparcamiento.` : 'Se ha acabado el tiempo de aparcamiento.', url: '#estado', tag: 'parking', urgent: true });
  }
}

async function exportAll(env) {
  const all = async sql => (await env.DB.prepare(sql).all()).results;
  const [snapshots, refuels, trips, maintenance, kv] = await Promise.all([
    all('SELECT ts, odometer, fuel_pct, battery_v, data FROM snapshots ORDER BY ts'),
    all('SELECT * FROM refuels ORDER BY ts'),
    all('SELECT * FROM trips ORDER BY start_ts'),
    all('SELECT * FROM maintenance ORDER BY id'),
    all("SELECT k, v FROM kv WHERE k IN ('guard', 'parking')")
  ]);
  return { app: 'fiesta-st-garaje', schema: SCHEMA, exported_at: new Date().toISOString(), source: src(env) || 'mock', snapshots, refuels, trips, maintenance, settings: kv };
}

async function tripRecords(env) {
  const cols = 'id, start_ts, km, duration_s, avg_speed, max_speed, max_rpm, fuel_used_l';
  const q = sql => env.DB.prepare(sql).first();
  const [top, eff, longest, rpm] = await Promise.all([
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY max_speed DESC LIMIT 1`),
    q(`SELECT ${cols}, fuel_used_l / km * 100 AS l100 FROM trips WHERE COALESCE(track, 0) = 0 AND km >= 5 AND fuel_used_l > 0 ORDER BY l100 ASC LIMIT 1`),
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY km DESC LIMIT 1`),
    q(`SELECT ${cols} FROM trips WHERE COALESCE(track, 0) = 0 ORDER BY max_rpm DESC LIMIT 1`)
  ]);
  if (eff) eff.l100 = round(eff.l100, 1);
  return { top_speed: top, best_eff: eff, longest, top_rpm: rpm };
}

async function weeklySummary(env) {
  const from = Date.now() - 7 * 86400e3;
  const t = await env.DB.prepare('SELECT COUNT(*) AS n, SUM(km) AS km, SUM(fuel_used_l) AS fuel, MAX(max_speed) AS top FROM trips WHERE start_ts >= ?').bind(from).first();
  const r = await env.DB.prepare('SELECT SUM(price_total) AS eur, COUNT(*) AS n FROM refuels WHERE ts >= ?').bind(from).first();
  const { items } = await listMaint(env);
  const due = items.filter(i => i.status === 'vencido' || i.status === 'pronto').length;
  const parts = [`${fmt(t.km || 0)} km en ${t.n || 0} trayectos`];
  if (t.km > 20 && t.fuel) parts.push(`${fmt(t.fuel / t.km * 100, 1)} l/100 km`);
  if (r.eur) parts.push(`${fmt(r.eur, 2)} € en gasolina`);
  if (t.top) parts.push(`punta ${t.top} km/h`);
  parts.push(due ? `${due} tarea${due > 1 ? 's' : ''} de taller pendiente${due > 1 ? 's' : ''}` : 'todo al día en el taller');
  return { title: 'Tu semana con el ST', body: parts.join(' · '), url: '#viajes', tag: 'weekly' };
}

// ---------- Gasolineras (datos oficiales del Ministerio) ----------

function distKm(a, b, c, d) {
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Centro aproximado de cada provincia (código INE) para saber dónde buscar gasolineras.
const PROVINCES = {
  '01': [42.85, -2.67], '02': [38.83, -1.98], '03': [38.48, -0.57], '04': [37.17, -2.33], '05': [40.57, -4.93], '06': [38.71, -6.42],
  '07': [39.57, 2.9], '08': [41.73, 1.98], '09': [42.37, -3.59], '10': [39.71, -6.16], '11': [36.55, -5.76], '12': [40.24, -0.15],
  '13': [38.92, -3.82], '14': [37.99, -4.81], '15': [43.13, -8.43], '16': [39.9, -2.19], '17': [42.13, 2.67], '18': [37.31, -3.27],
  '19': [40.82, -2.62], '20': [43.15, -2.2], '21': [37.57, -6.83], '22': [42.2, -0.07], '23': [37.96, -3.44], '24': [42.61, -5.84],
  '25': [42.05, 1.05], '26': [42.28, -2.52], '27': [43.0, -7.56], '28': [40.5, -3.71], '29': [36.81, -4.72], '30': [38.0, -1.5],
  '31': [42.67, -1.65], '32': [42.2, -7.59], '33': [43.29, -5.99], '34': [42.37, -4.53], '35': [28.4, -14.9], '36': [42.43, -8.46],
  '37': [40.8, -6.06], '38': [28.29, -17.2], '39': [43.2, -4.03], '40': [41.17, -4.05], '41': [37.43, -5.68], '42': [41.62, -2.59],
  '43': [41.06, 0.83], '44': [40.66, -0.82], '45': [39.79, -4.15], '46': [39.37, -0.79], '47': [41.63, -4.85], '48': [43.24, -2.85],
  '49': [41.73, -6.0], '50': [41.62, -1.06], '51': [35.89, -5.32], '52': [35.29, -2.94]
};
function provincesNear(lat, lon, n = 2) {
  return Object.entries(PROVINCES).map(([c, [a, b]]) => [c, distKm(lat, lon, a, b)]).sort((x, y) => x[1] - y[1]).slice(0, n).map(x => x[0]);
}

async function fuelStationsNear(env, lat, lon) {
  const provs = provincesNear(lat, lon, 2);
  const res = await Promise.allSettled(provs.map(p => fuelStations(env, p)));
  const ok = res.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (!ok.length) throw res[0].reason;
  return { date: ok[0].date, list: ok.flatMap(r => r.list) };
}

async function fuelStations(env, prov) {
  prov = prov || env.PROVINCE || '43';
  const ck = 'fuel_cache_' + prov;
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(ck).first();
  if (row) {
    const c = JSON.parse(row.v);
    if (Date.now() - c.at < 3600e3) return c;
  }
  let res;
  try {
    res = await fetch(FUEL_API + prov, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (FiestaSTGaraje)' },
      cf: { cacheTtl: 1800 }
    });
  } catch (e) { res = null; }
  if (!res || !res.ok) {
    if (row) return JSON.parse(row.v);
    throw httpError('El servicio de precios del Ministerio no responde ahora mismo', 502);
  }
  const j = await res.json();
  const n = v => { const x = parseFloat(String(v || '').replace(',', '.')); return isNaN(x) ? null : x; };
  const list = (j.ListaEESSPrecio || []).map(s => ({
    id: s.IDEESS,
    name: String(s['Rótulo'] || 'Gasolinera').trim(),
    address: String(s['Dirección'] || '').trim(),
    town: String(s.Localidad || s.Municipio || '').trim(),
    hours: s.Horario || '',
    lat: n(s.Latitud), lon: n(s['Longitud (WGS84)']),
    p95: n(s[FUEL_FIELDS['95']]), p98: n(s[FUEL_FIELDS['98']])
  })).filter(s => s.lat && s.lon && (s.p95 || s.p98));
  if (!list.length) throw httpError('El Ministerio no ha devuelto gasolineras', 502);
  const c = { at: Date.now(), date: j.Fecha || null, list };
  await env.DB.prepare('INSERT OR REPLACE INTO kv VALUES (?, ?)').bind(ck, JSON.stringify(c)).run();
  return c;
}

async function nearbyFuel(env, qs) {
  const type = qs.get('type') === '95' ? '95' : '98';
  let lat = parseFloat(qs.get('lat')), lon = parseFloat(qs.get('lon'));
  if (isNaN(lat) || isNaN(lon)) {
    const last = await env.DB.prepare('SELECT data FROM snapshots ORDER BY ts DESC LIMIT 1').first();
    const loc = last && JSON.parse(last.data).location;
    if (!loc) throw httpError('No hay ubicación para buscar gasolineras', 400);
    lat = loc.lat; lon = loc.lon;
  }
  const radius = Math.min(30, Math.max(1, parseFloat(qs.get('radius')) || 10));
  const { date, list } = await fuelStationsNear(env, lat, lon);
  const key = 'p' + type;
  const near = list.map(s => ({ ...s, km: round(distKm(lat, lon, s.lat, s.lon), 1), price: s[key] }))
    .filter(s => s.price && s.km <= radius);
  const byPrice = near.slice().sort((a, b) => a.price - b.price || a.km - b.km);
  const nearest = near.slice().sort((a, b) => a.km - b.km)[0] || null;
  const avg = near.length ? round(near.reduce((s, x) => s + x.price, 0) / near.length, 3) : null;
  const fav = await favStation(env, type, lat, lon);
  return { type, date, radius_km: radius, count: near.length, avg, nearest, stations: byPrice.slice(0, 12), fav };
}

// Gasolinera habitual: se muestra siempre con su precio de hoy, estés donde estés
async function favStation(env, type, lat, lon) {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'fav_station'").first();
  if (!row) return null;
  const f = JSON.parse(row.v);
  try {
    const { list } = await fuelStations(env, f.prov);
    const s = list.find(x => x.id === f.id);
    if (!s) return { ...f, missing: true };
    const key = 'p' + type;
    return { ...s, prov: f.prov, price: s[key], km: lat != null ? round(distKm(lat, lon, s.lat, s.lon), 1) : null };
  } catch (e) { return { ...f, missing: true }; }
}

async function setFavStation(env, b) {
  if (!b || !b.id) { await env.DB.prepare("DELETE FROM kv WHERE k = 'fav_station'").run(); return { fav: null }; }
  const lat = Number(b.lat), lon = Number(b.lon);
  const f = { id: String(b.id), name: String(b.name || '').slice(0, 60), town: String(b.town || '').slice(0, 60), lat, lon, prov: provincesNear(lat, lon, 1)[0] };
  await env.DB.prepare("INSERT OR REPLACE INTO kv VALUES ('fav_station', ?)").bind(JSON.stringify(f)).run();
  return { fav: f };
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
  const items = (await Promise.all(results.map(i => brakeWear(env, i, odo)))).map(i => {
    const o = maintStatus(i, odo, now);
    const orig = results.find(r => r.id === i.id);
    return { ...o, last_km: orig.last_km, last_date: orig.last_date };
  }).sort((a, b) => order[a.status] - order[b.status] || b.pct - a.pct);
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
          Urgency: note.urgent ? 'high' : 'normal',
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
