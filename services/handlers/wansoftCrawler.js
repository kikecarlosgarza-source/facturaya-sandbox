// wansoftCrawler.js — CRAWLER ONE-SHOT del catálogo Wansoft (Reino C).
//
// Puebla la tabla wansoft_sid_map con TODOS los sids válidos descubiertos
// desde el hub https://www.wansoft.net/fact.html. NO se corre en automático
// ni en el flujo de facturación: es una herramienta de mantenimiento que se
// dispara a mano (npm run crawl:wansoft) cuando hay que refrescar el mapa.
//
// Flujo:
//   1. GET hub fact.html → opciones del <select> { text, value }
//   2. Por marca (pool de 10 workers, sleep 100-300ms, 2 reintentos):
//      a. GET marca.value (URL EXACTA del dropdown, no construida)
//      b. 404 → registro activo=0 motivo '404_marca'
//      c. sids = /[?&]sid=(\d+)/gi  (se descarta sid=1614, demo universal)
//      d. sin sids → activo=0 motivo 'sin_sucursales'
//      e. por cada sid: GET ElectronicInvoice?sid=; si la URL final no
//         contiene 'autoInvoicing' → activo=0 motivo 'sid_roto'; si sí,
//         extraer datos del emisor del HTML
//      f. INSERT OR REPLACE en wansoft_sid_map
//   3. Reporte final con métricas.
//
// Parámetros: concurrencia 10, timeout 15s/req, 2 reintentos (backoff
// 1s/3s), rate-limit 100-300ms entre requests del mismo worker.

const axios = require('axios');
const db = require('../../db/database');

const ORIGIN = 'https://www.wansoft.net';
const HUB_URL = `${ORIGIN}/fact.html`;
const PUB = `${ORIGIN}/Wansoft.Web/Public`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONCURRENCY = 10;
const REQ_TIMEOUT = 15000;
const MAX_RETRIES = 2;
const BACKOFFS_MS = [1000, 3000];
const SID_DEMO = 1614; // demo universal de Wansoft, se ignora

// ── Migración: crear tabla + índices si no existen ────────────────────────
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wansoft_sid_map (
      sid              INTEGER PRIMARY KEY,
      marca_nombre     TEXT NOT NULL,
      marca_slug       TEXT NOT NULL,
      marca_url        TEXT NOT NULL,
      sucursal_nombre  TEXT,
      rfc_emisor       TEXT,
      razon_social     TEXT,
      direccion        TEXT,
      cp_emisor        TEXT,
      regimen_fiscal   TEXT,
      email_soporte    TEXT,
      modelo           TEXT NOT NULL,
      activo           INTEGER NOT NULL DEFAULT 1,
      motivo_inactivo  TEXT,
      ultima_revision  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_wansoft_rfc ON wansoft_sid_map(rfc_emisor);
    CREATE INDEX IF NOT EXISTS idx_wansoft_marca_nombre ON wansoft_sid_map(marca_nombre);
    CREATE INDEX IF NOT EXISTS idx_wansoft_activo ON wansoft_sid_map(activo);
  `);
}

const upsertStmt = () => db.prepare(`
  INSERT OR REPLACE INTO wansoft_sid_map
    (sid, marca_nombre, marca_slug, marca_url, sucursal_nombre, rfc_emisor,
     razon_social, direccion, cp_emisor, regimen_fiscal, email_soporte,
     modelo, activo, motivo_inactivo, ultima_revision)
  VALUES
    (@sid, @marca_nombre, @marca_slug, @marca_url, @sucursal_nombre, @rfc_emisor,
     @razon_social, @direccion, @cp_emisor, @regimen_fiscal, @email_soporte,
     @modelo, @activo, @motivo_inactivo, CURRENT_TIMESTAMP)
`);

// ── Utilidades ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = () => 100 + Math.floor(Math.random() * 200); // 100-300ms

function finalUrlOf(resp) {
  // Node http: URL final tras seguir redirects.
  return resp?.request?.res?.responseUrl || resp?.config?.url || '';
}

// GET con 2 reintentos + backoff exponencial. Devuelve {status, finalUrl, html}
// o lanza tras agotar reintentos.
async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
        timeout: REQ_TIMEOUT,
        maxRedirects: 5,
        validateStatus: () => true
      });
      return {
        status: resp.status,
        finalUrl: finalUrlOf(resp),
        html: typeof resp.data === 'string' ? resp.data : ''
      };
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(BACKOFFS_MS[attempt]);
    }
  }
  throw lastErr;
}

function slugFromUrl(url) {
  // último segmento antes de /FE.html (o el último path no vacío).
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean);
    if (!p.length) return '';
    const i = p.findIndex(s => /FE\.html/i.test(s));
    return (i > 0 ? p[i - 1] : p[p.length - 1] || p[0]).replace(/\.html?$/i, '');
  } catch { return ''; }
}

function is404(res) {
  return /\/404(\.html?)?(\?|#|$)/i.test(res.finalUrl) || /404\s*not\s*found/i.test(res.html);
}

function extractSids(html) {
  const out = new Set();
  let m;
  const re = /[?&]sid=(\d+)/gi;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n !== SID_DEMO) out.add(n);
  }
  return [...out];
}

// Texto del <a>/<button> que apunta a un sid concreto (mejor esfuerzo).
function sucursalNombreFor(html, sid) {
  const pats = [
    new RegExp(`<a[^>]*sid=${sid}[^>]*>([\\s\\S]*?)</a>`, 'i'),
    new RegExp(`<button[^>]*sid=${sid}[^>]*>([\\s\\S]*?)</button>`, 'i'),
    new RegExp(`sid=${sid}[^>]*>\\s*([^<]{2,80})`, 'i')
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      const t = m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (t) return t.substring(0, 200);
    }
  }
  return null;
}

// Estructura real del emisor (capturada en vivo):
//   <span class="subsidiary-fe">RAZON SOCIAL</span>
//   <div class="address">CALLE, NO.EXTERIOR... CP 12345</div>   ← dirección
//   <div class="address">RFC: XXX</div>
//   <div class="address">LUGAR DE EXPEDICIÓN: ...</div>
//   <div class="address">RÉGIMEN FISCAL: ...</div>
function extractEmisor(html) {
  const clean = (s) => s
    ? s.replace(/<[^>]+>/g, ' ').replace(/&amp;/gi, '&').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim()
    : null;

  // razon_social ← <span class="subsidiary-fe">
  let razon_social = null;
  const rs = html.match(/<span[^>]*class="[^"]*\bsubsidiary-fe\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
  if (rs) razon_social = clean(rs[1]) || null;

  // todos los <div class="address">
  const addrs = [];
  const reA = /<div[^>]*class="[^"]*\baddress\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  let a;
  while ((a = reA.exec(html))) { const t = clean(a[1]); if (t) addrs.push(t); }

  const labeled = (re) => { for (const t of addrs) { const m = t.match(re); if (m) return m[1].trim(); } return null; };
  const rfc_emisor = labeled(/^RFC:?\s*([A-Z&Ñ0-9]{12,13})/i);
  const regimen_fiscal = labeled(/^R[ÉE]GIMEN\s+FISCAL:?\s*(.+)$/i);

  // dirección = primer address que NO sea RFC:/LUGAR/RÉGIMEN
  let direccion = null;
  for (const t of addrs) {
    if (/^(RFC:|LUGAR\s+DE\s+EXPEDICI[ÓO]N:|R[ÉE]GIMEN\s+FISCAL:)/i.test(t)) continue;
    direccion = t;
    break;
  }

  const cpM = (direccion || '').match(/C\.?P\.?\s*:?\s*(\d{5})/i) || (direccion || '').match(/\b(\d{5})\b/);
  const cp_emisor = cpM ? cpM[1] : null;

  const emM = html.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i);
  const email_soporte = emM ? emM[1] : null;

  return { rfc_emisor, razon_social, direccion, cp_emisor, regimen_fiscal, email_soporte };
}

// ── Procesamiento de una marca ────────────────────────────────────────────
async function procesarMarca(marca, stats, upsert) {
  const slug = slugFromUrl(marca.value);
  const base = {
    marca_nombre: marca.text,
    marca_slug: slug,
    marca_url: marca.value,
    sucursal_nombre: null,
    rfc_emisor: null, razon_social: null, direccion: null,
    cp_emisor: null, regimen_fiscal: null, email_soporte: null,
    modelo: 'A'
  };

  let res;
  try {
    res = await fetchWithRetry(marca.value);
  } catch (e) {
    stats.errores++;
    // Sin sid no hay PK; registramos un placeholder negativo determinístico.
    upsert.run({ ...base, sid: -Math.abs(hashStr(marca.value)), activo: 0, motivo_inactivo: `fetch_error: ${e.message}`.substring(0, 120) });
    return;
  }

  if (is404(res)) {
    stats.marcas404++;
    upsert.run({ ...base, sid: -Math.abs(hashStr(marca.value)), activo: 0, motivo_inactivo: '404_marca' });
    return;
  }

  const sids = extractSids(res.html);
  if (sids.length === 0) {
    stats.sinSucursales++;
    upsert.run({ ...base, sid: -Math.abs(hashStr(marca.value)), activo: 0, motivo_inactivo: 'sin_sucursales' });
    return;
  }
  if (sids.length > 1) base.modelo = 'A'; // N sucursales mismo portal

  stats.marcasOk++;
  for (const sid of sids) {
    await sleep(jitter());
    const row = { ...base, sid, sucursal_nombre: sucursalNombreFor(res.html, sid) };
    try {
      const inv = await fetchWithRetry(`${PUB}/ElectronicInvoice?sid=${sid}`);
      if (!/autoInvoicing/i.test(inv.finalUrl)) {
        stats.sidsRotos++;
        upsert.run({ ...row, activo: 0, motivo_inactivo: 'sid_roto' });
        continue;
      }
      Object.assign(row, extractEmisor(inv.html));
      upsert.run({ ...row, activo: 1, motivo_inactivo: null });
      stats.sidsOk++;
    } catch (e) {
      stats.sidsRotos++;
      upsert.run({ ...row, activo: 0, motivo_inactivo: `sid_fetch_error: ${e.message}`.substring(0, 120) });
    }
  }
}

// hash determinístico para PK placeholder de marcas sin sid (negativo).
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h || 1;
}

// ── Pool de workers ───────────────────────────────────────────────────────
async function runPool(items, worker) {
  let idx = 0;
  const next = async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
      await sleep(jitter());
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, next));
}

function parseHubOptions(html) {
  const opts = [];
  const re = /<option\b[^>]*value="([^"]+)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = re.exec(html))) {
    const value = m[1].trim();
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!value || !/^https?:\/\//i.test(value)) continue; // saltar placeholders
    opts.push({ value, text });
  }
  return opts;
}

async function run() {
  const t0 = Date.now();
  console.log('[Crawler] Asegurando esquema wansoft_sid_map…');
  ensureSchema();
  const upsert = upsertStmt();

  console.log(`[Crawler] GET hub ${HUB_URL}`);
  const hub = await fetchWithRetry(HUB_URL);
  if (hub.status >= 400) { console.error(`[Crawler] hub HTTP ${hub.status} — abortando`); process.exit(1); }
  const marcas = parseHubOptions(hub.html);
  console.log(`[Crawler] ${marcas.length} marcas en el dropdown`);
  if (!marcas.length) { console.error('[Crawler] 0 marcas — selector no parseó, abortando'); process.exit(1); }

  const stats = { marcasOk: 0, marcas404: 0, sinSucursales: 0, sidsOk: 0, sidsRotos: 0, errores: 0 };
  let done = 0;
  await runPool(marcas, async (marca) => {
    await procesarMarca(marca, stats, upsert);
    if (++done % 50 === 0) console.log(`[Crawler] progreso ${done}/${marcas.length} — sidsOk=${stats.sidsOk}`);
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const distRows = db.prepare(`
    SELECT n_suc, COUNT(*) n_marcas FROM (
      SELECT marca_url, COUNT(*) n_suc FROM wansoft_sid_map
      WHERE activo=1 GROUP BY marca_url
    ) GROUP BY n_suc ORDER BY n_suc
  `).all();
  const totalRows = db.prepare('SELECT COUNT(*) c FROM wansoft_sid_map').get().c;
  const activos = db.prepare('SELECT COUNT(*) c FROM wansoft_sid_map WHERE activo=1').get().c;

  console.log('\n──────────── REPORTE CRAWLER WANSOFT ────────────');
  console.log(`Marcas en dropdown:        ${marcas.length}`);
  console.log(`Marcas con sucursales OK:  ${stats.marcasOk}`);
  console.log(`Marcas 404:                ${stats.marcas404}`);
  console.log(`Marcas sin sucursales:     ${stats.sinSucursales}`);
  console.log(`Marcas con fetch error:    ${stats.errores}`);
  console.log(`Sids OK (activos):         ${stats.sidsOk}`);
  console.log(`Sids rotos/error:          ${stats.sidsRotos}`);
  console.log(`Filas en wansoft_sid_map:  ${totalRows} (activas: ${activos})`);
  console.log('Distribución sucursales/marca:');
  for (const d of distRows) console.log(`  ${d.n_suc} suc → ${d.n_marcas} marcas`);
  console.log(`Tiempo total:              ${secs}s`);
  console.log('─────────────────────────────────────────────────');
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error('[Crawler] fatal:', e.stack || e.message); process.exit(1); });
}

module.exports = { run, ensureSchema, parseHubOptions, extractSids, extractEmisor };
