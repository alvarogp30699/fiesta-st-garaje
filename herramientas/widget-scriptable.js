// Fiesta ST Garaje — widget para la pantalla de inicio del iPhone (app gratuita "Scriptable").
// La primera vez que lo ejecutes dentro de Scriptable te pide la URL del servidor y la contraseña (APP_KEY)
// y las guarda en el llavero del iPhone. Para cambiarlas, borra el script y vuelve a crearlo.

const URL_KEY = 'fiesta_st_url', PASS_KEY = 'fiesta_st_key';
const AC = new Color('#ffd400'), OK = new Color('#2ee59d'), WA = new Color('#ffb21e'), BAD = new Color('#ff4d3d');
const MU = new Color('#7d858f'), TX = new Color('#f4f5f6'), BG = new Color('#0a0b0d');

async function ask(title, key, secure) {
  if (Keychain.contains(key) && Keychain.get(key).trim()) return Keychain.get(key);
  const a = new Alert();
  a.title = title;
  if (secure) a.addSecureTextField('Contraseña'); else a.addTextField('URL', 'https://fiesta-st-api.alvaroofimega.workers.dev');
  a.addAction('Guardar');
  await a.present();
  const v = a.textFieldValue(0).trim();
  Keychain.set(key, v);
  return v;
}

const base = (await ask('URL del servidor', URL_KEY, false)).replace(/\/+$/, '');
const pass = await ask('Contraseña de la app (APP_KEY)', PASS_KEY, true);

let d = null, err = null;
try {
  const r = new Request(base + '/api/widget');
  r.headers = { 'x-app-key': pass };
  d = await r.loadJSON();
  if (d.error) { err = d.error; d = null; }
} catch (e) { err = 'Sin conexión: ' + e.message; }
if (err && /401|Contraseña/i.test(err)) Keychain.remove(PASS_KEY);

const w = new ListWidget();
w.backgroundColor = BG;
w.setPadding(14, 14, 14, 14);
w.url = 'https://alvarogp30699.github.io/fiesta-st-garaje/';
w.refreshAfterDate = new Date(Date.now() + 15 * 60e3);

const head = w.addText('FIESTA ST');
head.font = Font.boldMonospacedSystemFont(11); head.textColor = MU;
w.addSpacer(4);

if (!d) {
  const t = w.addText(err || 'Sin datos'); t.textColor = BAD; t.font = Font.mediumSystemFont(13);
} else {
  const range = w.addText(`${d.range_km ?? '—'} km`);
  range.font = Font.boldMonospacedSystemFont(28); range.textColor = TX;
  const fuel = w.addText(`Depósito ${Math.round(d.fuel_pct ?? 0)} %`);
  fuel.font = Font.mediumSystemFont(12); fuel.textColor = (d.fuel_pct ?? 100) < 15 ? WA : MU;
  w.addSpacer(6);

  const lock = w.addText(d.locked ? '● Cerrado' : '● Abierto');
  lock.font = Font.boldSystemFont(13); lock.textColor = d.locked ? OK : WA;
  if (d.doors_open && d.doors_open.length) { const t = w.addText('Puerta abierta'); t.font = Font.mediumSystemFont(12); t.textColor = WA; }

  const t = d.tyres || {}, f = v => v == null ? '—' : v.toFixed(2).replace('.', ',');
  const low = d.tyres_low || [];
  for (const [a, b] of [['fl', 'fr'], ['rl', 'rr']]) {
    const row = w.addStack();
    for (const k of [a, b]) {
      const x = row.addText(f(t[k]));
      x.font = Font.mediumMonospacedSystemFont(12);
      x.textColor = low.includes(k) ? WA : TX;
      if (k === a) row.addSpacer(10);
    }
  }
  if (d.circuit) { const c = w.addText('🏁 ' + d.circuit); c.font = Font.boldSystemFont(11); c.textColor = AC; }

  w.addSpacer();
  const ago = Math.round((Date.now() - d.data_ts) / 60e3);
  const when = w.addText(ago < 60 ? `hace ${ago} min` : `hace ${Math.round(ago / 60)} h`);
  when.font = Font.systemFont(10); when.textColor = MU;
}

if (config.runsInWidget) Script.setWidget(w); else await w.presentSmall();
Script.complete();
