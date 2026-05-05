const axios = require('axios');
const db = require('../db/database');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01'
};

const TTL_POSITIVE_MS   = 30 * 24 * 60 * 60 * 1000;  // 30 días
const TTL_NEGATIVE_MS   =  7 * 24 * 60 * 60 * 1000;  // 7 días
const HEAD_TIMEOUT_MS   = 5000;
const SEARCH_TIMEOUT_MS = 90000;

const selectCache = db.prepare(`SELECT * FROM portal_url_cache WHERE cache_key = ?`);
const upsertCache = db.prepare(`
  INSERT INTO portal_url_cache (cache_key, rfc_emisor, establecimiento, portal_url, source, confidence, searched_at, last_verified, expires_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(cache_key) DO UPDATE SET
    rfc_emisor      = excluded.rfc_emisor,
    establecimiento = excluded.establecimiento,
    portal_url      = excluded.portal_url,
    source          = excluded.source,
    confidence      = excluded.confidence,
    searched_at     = excluded.searched_at,
    last_verified   = excluded.last_verified,
    expires_at      = excluded.expires_at
`);
const updateLastVerified = db.prepare(`UPDATE portal_url_cache SET last_verified = ? WHERE cache_key = ?`);
const invalidateCache    = db.prepare(`DELETE FROM portal_url_cache WHERE cache_key = ?`);

function buildCacheKey({ rfc_emisor, establecimiento }) {
  if (rfc_emisor)     return `rfc:${String(rfc_emisor).toUpperCase().trim()}`;
  if (establecimiento) return `estab:${String(establecimiento).toLowerCase().trim()}`;
  return null;
}

async function isAlive(url) {
  try {
    const r = await axios.head(url, {
      timeout: HEAD_TIMEOUT_MS, maxRedirects: 5, validateStatus: () => true
    });
    if (r.status < 400) return true;
    // 405/403 puede significar HEAD no permitido — fallback a GET stream
    if (r.status === 405 || r.status === 403) {
      const g = await axios.get(url, {
        timeout: HEAD_TIMEOUT_MS, maxRedirects: 5,
        validateStatus: () => true, responseType: 'stream'
      });
      try { g.data?.destroy?.(); } catch {}
      return g.status < 400;
    }
    return false;
  } catch {
    return false;
  }
}

async function webSearch({ rfc_emisor, establecimiento }) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const userMsg = `Busca en internet la URL OFICIAL VIGENTE del portal de facturación electrónica de "${establecimiento || '(desconocido)'}"${rfc_emisor ? ` (RFC: ${rfc_emisor})` : ''} en México.

Solo URLs oficiales del propio negocio. NO listicles, blogs, comparativas o sitios de terceros.

Responde SOLO con JSON sin backticks:
{"portal_url": "https://...", "confidence": 0.0-1.0, "razon": "una línea"}

Si no encuentras una URL oficial confiable: {"portal_url": null, "confidence": 0.0, "razon": "..."}`;

  const resp = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{ role: 'user', content: userMsg }]
  }, { headers: HEADERS, timeout: SEARCH_TIMEOUT_MS });

  const text = (resp.data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Scout: respuesta de Claude sin JSON');
  return JSON.parse(m[0]);
}

/**
 * Busca la URL del portal de facturación de un emisor.
 * Cache: por rfc_emisor (preferido) o establecimiento. TTL 30d positivo, 7d negativo.
 * Devuelve URL string o null. Errores de búsqueda no se cachean (return null silencioso).
 */
async function findPortalURL({ rfc_emisor, establecimiento }) {
  const key = buildCacheKey({ rfc_emisor, establecimiento });
  if (!key) return null;

  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Cache lookup
  const cached = selectCache.get(key);
  if (cached && cached.expires_at && cached.expires_at > nowIso) {
    if (cached.portal_url) {
      // Hit positivo — validar que la URL sigue viva
      if (await isAlive(cached.portal_url)) {
        try { updateLastVerified.run(nowIso, key); } catch {}
        return cached.portal_url;
      }
      // Muerta — invalidar y proceder a re-buscar
      try { invalidateCache.run(key); } catch {}
    } else {
      // Hit negativo no expirado — no re-buscar
      return null;
    }
  }

  // 2. Web search via Claude API
  let result;
  try {
    result = await webSearch({ rfc_emisor, establecimiento });
  } catch (e) {
    console.warn('[scout] webSearch falló:', e.message);
    return null;  // errores transitorios no se cachean
  }

  // 3. Validar shape de la URL
  if (result.portal_url && !/^https?:\/\//.test(result.portal_url)) {
    result.portal_url = null;
  }

  // 4. Validar HEAD antes de aceptar
  if (result.portal_url && !(await isAlive(result.portal_url))) {
    console.warn(`[scout] URL devuelta por Claude no responde: ${result.portal_url}`);
    result.portal_url = null;
  }

  // 5. Persistir en cache (positivo o negativo)
  const ttl = result.portal_url ? TTL_POSITIVE_MS : TTL_NEGATIVE_MS;
  const expires = new Date(now.getTime() + ttl).toISOString();
  try {
    upsertCache.run(
      key,
      rfc_emisor || null,
      establecimiento || null,
      result.portal_url || null,
      'web_search',
      typeof result.confidence === 'number' ? result.confidence : null,
      nowIso,
      result.portal_url ? nowIso : null,
      expires
    );
  } catch (e) {
    console.warn('[scout] no se pudo persistir cache:', e.message);
  }

  return result.portal_url || null;
}

module.exports = { findPortalURL };
