// Handler HTTP-only para alsea.interfactura.com (multi-marca: VIPS, Starbucks,
// Domino's, Burger King, Chili's, P.F. Chang's, Italianni's).
//
// Reescrito desde la versión Playwright a flujo httpOnly basado en grabación
// real (expansion/apis/alsea_full.json) que capturó los 3 endpoints de
// validación del paso 1:
//   POST /api/chatbot/ValidaPagina1RFC
//   POST /api/chatbot/ValidaPagina1Ticket
//   POST /api/chatbot/ValidaPagina1Fecha
//
// Patrón Petro7: httpOnly, numerado por fases, try/catch + reportApi por fase.
// Paso 2 (datos fiscales) se delega a la app vía WebView — el handler retorna
// openWebView con la URL específica de la marca para que la app la abra.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://alsea.interfactura.com';

// Mapeo establecimiento → operador exacto que envía el portal en el body.
// "Starbucks" e "isFastFood:true" confirmados en captura. Resto inferidos.
const BRAND_OPERATORS = [
  { keys: ['starbucks'],                          operator: 'Starbucks',     isFastFood: true  },
  { keys: ['vips'],                               operator: 'Vips',          isFastFood: false },
  { keys: ['dominos','domino'],                   operator: "Domino's",      isFastFood: true  },
  { keys: ['burger king','bk'],                   operator: 'Burger King',   isFastFood: true  },
  { keys: ['chilis','chili'],                     operator: "Chili's",       isFastFood: false },
  { keys: ['p.f. chang','pf chang','pfchang'],    operator: "P.F. Chang's",  isFastFood: false },
  { keys: ['italianni'],                          operator: "Italianni's",   isFastFood: false }
];

function brandFor(establecimiento) {
  const n = (establecimiento || '').toLowerCase();
  for (const b of BRAND_OPERATORS) {
    if (b.keys.some(k => n.includes(k))) return b;
  }
  return null;
}

// El portal envía fecha como ISO 8601 UTC con hora 06:00 (medianoche CST).
// Capturado: "2026-05-05T06:00:00.000Z" para fecha local 05/05/2026.
function fechaToIso(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[0]}T06:00:00.000Z`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2,'0'), mm = m[2].padStart(2,'0');
    return `${m[3]}-${mm}-${dd}T06:00:00.000Z`;
  }
  return null;
}

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('alsea');

  const brand = brandFor(ticketData.establecimiento);
  if (!brand) {
    return { success: false, mensaje: `Alsea: marca no soportada — establecimiento="${ticketData.establecimiento}"` };
  }

  const ticket = ticketData.numero_ticket || ticketData.folio || '';
  const tienda = ticketData.numero_tienda || '';
  const fechaIso = fechaToIso(ticketData.fecha_compra || ticketData.fecha_formateada);
  if (!ticket)   return { success: false, mensaje: 'Alsea: numero_ticket (o folio) requerido' };
  if (!tienda)   return { success: false, mensaje: 'Alsea: numero_tienda requerido (5 dígitos)' };
  if (!fechaIso) return { success: false, mensaje: 'Alsea: fecha requerida (dd/mm/yyyy o YYYY-MM-DD)' };

  // Body shape exacto capturado. Paso 1 envía nombres/apellidos/usoCfdi/email
  // vacíos — esos van en paso 2 que ocurre en WebView del lado de la app.
  const body = {
    rfc: perfil.rfc,
    ticket,
    nombres: '',
    apellidos: '',
    usoCfdi: '',
    correoElectronico: '',
    tienda,
    fecha: fechaIso,
    operador: brand.operator,
    isFastFood: brand.isFastFood
  };

  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': BASE,
    'Referer': `${BASE}/?opc=${encodeURIComponent(brand.operator)}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  const opts = { headers, timeout: 30000, validateStatus: () => true };

  // 1-3. Las 3 validaciones del paso 1, en el orden capturado
  const phases = [
    { name: 'ValidaPagina1RFC',    path: '/api/chatbot/ValidaPagina1RFC' },
    { name: 'ValidaPagina1Ticket', path: '/api/chatbot/ValidaPagina1Ticket' },
    { name: 'ValidaPagina1Fecha',  path: '/api/chatbot/ValidaPagina1Fecha' }
  ];

  for (const ph of phases) {
    const url = BASE + ph.path;
    try {
      const r = await axios.post(url, body, opts);
      console.log(`[AUTO] Alsea ${ph.name} status=${r.status} body=${JSON.stringify(r.data).substring(0,200)}`);
      if (r.status >= 400) {
        return { success: false, mensaje: `Alsea ${ph.name}: HTTP ${r.status} — ${JSON.stringify(r.data).substring(0,150)}` };
      }
      // Sin captura del happy-path real desconocemos el discriminador exacto.
      // Aceptamos varias convenciones posibles de "rechazado".
      const d = r.data || {};
      if (d.exito === false || d.success === false || d.valido === false || d.response === false) {
        const msg = d.mensaje || d.message || d.error || JSON.stringify(d).substring(0, 150);
        return { success: false, mensaje: `Alsea ${ph.name} rechazado — ${msg}` };
      }
    } catch (e) {
      reportApi(url, body, e);
      return { success: false, mensaje: `Alsea ${ph.name} excepción — ${e.message}` };
    }
  }

  // Paso 1 OK. Devolvemos URL específica de marca para que la app abra
  // WebView donde el usuario completa datos fiscales (paso 2).
  const webviewUrl = `${BASE}/?opc=${encodeURIComponent(brand.operator)}`;
  return {
    success: false,
    openWebView: webviewUrl,
    paso1_valido: true,
    mensaje: `Alsea ${brand.operator}: paso 1 validado. Completa datos fiscales en el portal.`
  };
}

module.exports = { ejecutar };
