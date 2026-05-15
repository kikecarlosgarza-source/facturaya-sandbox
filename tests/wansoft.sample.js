// Validación por muestreo del catálogo Wansoft (Reino C).
//
// Toma 20 sids al azar de wansoft_sid_map (activo=1) y corre SOLO el PASO 1
// del protocolo (GET ElectronicInvoice → seguir 30x → obtener cookies +
// __RequestVerificationToken). NO factura nada.
//
// Un sid "pasa" si la URL final contiene 'autoInvoicing' y se extrae token.
// Esperado: > 90% pasa.
//
// Ejecutar: npm run sample:wansoft
// Exit: 0 = >90% pasa, 1 = <=90%

const axios = require('axios');
const db = require('../db/database');

const ORIGIN = 'https://www.wansoft.net';
const PUB = ORIGIN + '/Wansoft.Web/Public';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const N = 20;

function extractToken(html) {
  if (!html || typeof html !== 'string') return null;
  let m = html.match(/name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/i);
  if (m) return m[1];
  m = html.match(/\bvalue="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  return m ? m[1] : null;
}

// PASO 1 del handler (replicado, sin facturar): loop de redirects manual.
async function paso1(sid) {
  const jar = {};
  const parseCookies = (h) => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

  let url = `${PUB}/ElectronicInvoice?sid=${sid}`;
  let html = '', referer = '';
  for (let hop = 0; hop < 5; hop++) {
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Cookie': cookieHeader() },
      timeout: 30000, maxRedirects: 0, validateStatus: () => true
    });
    parseCookies(r.headers);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      url = r.headers.location.startsWith('http') ? r.headers.location : ORIGIN + r.headers.location;
      continue;
    }
    if (r.status >= 400) return { ok: false, error: `HTTP ${r.status}` };
    html = typeof r.data === 'string' ? r.data : '';
    referer = url;
    break;
  }
  if (!referer) return { ok: false, error: 'sin pagina (redirect loop)' };
  if (!/autoInvoicing/i.test(referer)) return { ok: false, error: 'sid roto (sin autoInvoicing)' };
  const token = extractToken(html);
  if (!token) return { ok: false, error: 'sin token' };
  return { ok: true };
}

(async () => {
  let rows;
  try {
    rows = db.prepare('SELECT sid, marca_nombre, sucursal_nombre FROM wansoft_sid_map WHERE activo=1 ORDER BY RANDOM() LIMIT ?').all(N);
  } catch (e) {
    console.error('[Sample] no se pudo leer wansoft_sid_map — ¿corriste el crawler?', e.message);
    process.exit(1);
  }
  if (!rows.length) { console.error('[Sample] wansoft_sid_map vacía'); process.exit(1); }

  console.log(`──────── SAMPLE WANSOFT: ${rows.length} sids random (PASO 1) ────────`);
  let pass = 0;
  const fails = [];
  for (const row of rows) {
    let res;
    try { res = await paso1(row.sid); }
    catch (e) { res = { ok: false, error: 'excepción: ' + e.message }; }
    if (res.ok) { pass++; console.log(`  PASS  sid=${row.sid}  ${row.marca_nombre} / ${row.sucursal_nombre || ''}`); }
    else { fails.push({ sid: row.sid, marca: row.marca_nombre, error: res.error });
           console.log(`  FAIL  sid=${row.sid}  ${row.marca_nombre} — ${res.error}`); }
  }
  const pct = (pass / rows.length) * 100;
  console.log('-----------------------------------------------------------');
  console.log(`Pasan: ${pass}/${rows.length} (${pct.toFixed(1)}%)`);
  if (fails.length) {
    console.log('Fallas:');
    for (const f of fails) console.log(`  sid=${f.sid} ${f.marca} → ${f.error}`);
  }
  const okGate = pct > 90;
  console.log(okGate ? `SAMPLE PASS ✅ (>90%)` : `SAMPLE FAIL ❌ (<=90%)`);
  process.exit(okGate ? 0 : 1);
})();
