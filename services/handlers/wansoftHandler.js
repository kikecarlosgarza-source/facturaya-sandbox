// Handler HTTP-only para www.wansoft.net (motor POS detrás de Clip).
//
// Wansoft sirve ~1000+ marcas (Doña Concha, Tony Romas, OakBerry, Le Pain
// Quotidien, Johnny Rockets, ...). Stack ASP.NET MVC viejo + jQuery 1.11,
// sin captcha ni antibots — HTTP simple. Todo el protocolo se mueve por
// `sid` (id de sucursal en Wansoft), no por nombre de marca.
//
// Flujo de 5 pasos (capturado en vivo, ticket Doña Concha #158074):
//   PASO 1  GET  /Wansoft.Web/Public/ElectronicInvoice?sid={SID}
//             → 302 a /Wansoft.Web/Public/autoInvoicing40?id=ENC&code=ENC
//             → cookies HttpOnly ASP.NET (jar) + __RequestVerificationToken
//               en un <input hidden> del HTML.
//   PASO 2  POST /Wansoft.Web/Public/GetBillingInformation
//             → billingCodeInfo { Total, Tip, Invoiced, isCanceled, ... }
//   PASO 3  POST /Wansoft.Web/Public/GetBillingInformationWithTotalAndTip
//             → server precarga hidden fields en sesión
//   PASO 4  POST /Wansoft.Web//Public/IssueDocument40   (DOBLE SLASH LITERAL)
//             → Document { UUID, status:"Vigente", ... } = timbrado real
//   PASO 5  GET  /Wansoft.Web/Public/DownloadPdf|DownloadXml?UUID=&SubsidiaryId=
//
// Notas críticas del scout (NO tocar sin re-capturar en vivo):
//   - El doble slash de IssueDocument40 es LITERAL, no typo. Replicar exacto.
//   - MessageType NO es un discriminador binario éxito/error. Matriz del
//     PASO 2 (POST GetBillingInformation) capturada en vivo:
//         | Caso            | HTTP | Message                         | MsgType | billingCodeInfo |
//         | Facturable      | 200  | ""                              |    1    | presente        |
//         | Ya facturado    | 200  | "Su ticket ya se encuentra ..." |    2    | AUSENTE         |
//         | Código inválido | 200  | "El ticket aún no está ..."     |    2    | AUSENTE         |
//     MessageType:1 = info-OK (con billingCodeInfo); MessageType:2 = warning
//     informativo (sin billingCodeInfo). Se discrimina por la PRESENCIA de
//     billingCodeInfo + regex sobre Message, nunca por MessageType.
//   - Éxito real del timbrado (PASO 4) = HTTP 200 + Document.UUID válido
//     (no all-zeros) + Document.status === 'Vigente'.
//   - Total/Tip viajan como string con punto y 2 decimales: "75.00", "0.00".
//   - El jar de cookies del PASO 1 debe persistir en los pasos 2-5; si se
//     pierde la sesión, el __RequestVerificationToken queda huérfano y el
//     PASO 4 responde 403.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');
const db = require('../../db/database');

const ORIGIN = 'https://www.wansoft.net';
const PUB = ORIGIN + '/Wansoft.Web/Public';
// PASO 4 — doble slash LITERAL entre "Web" y "Public". Capturado así en vivo.
const ISSUE_URL = ORIGIN + '/Wansoft.Web//Public/IssueDocument40';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const UUID_ZERO = '00000000-0000-0000-0000-000000000000';

// Catálogo de sucursales conocidas (análogo a resolveBranchCode de otros
// handlers). Por ahora hardcoded con las 2 sucursales de Doña Concha
// capturadas en vivo. TODO futuro (NO en este commit): crawler de
// https://www.wansoft.net/fact.html para descubrir las ~1000 marcas y sids.
// El primer patrón que matchee gana; ordenar de más específico a más genérico.
const SID_CATALOG = [
  { sid: 5676,  rfcEmisor: 'ADC2404103S2', re: /do[ñn]a\s*concha.*(monarka|calzada\s*del\s*valle|san\s*pedro)/i },
  { sid: 10900, rfcEmisor: 'ADC2404103S2', re: /do[ñn]a\s*concha.*(cedis|plutarco)/i },
  // Fallback genérico Doña Concha → sucursal principal (Plaza Monarka).
  { sid: 5676,  rfcEmisor: 'ADC2404103S2', re: /do[ñn]a\s*concha/i },

  // TODO EMPANADAS — 33 sucursales bajo el MISMO RFC TIE2204058E0. Primera
  // prueba real de desambiguación por dirección (regex específico ANTES del
  // fallback). Por ahora solo SAN AGUSTÍN (sid 9912) capturada en vivo;
  // el resto cae al fallback → 9912 (potencial mismatch, ver pendiente E).
  { sid: 9912,  rfcEmisor: 'TIE2204058E0', re: /todo\s*empanadas.*san\s*agust[íi]n/i },
  { sid: 9912,  rfcEmisor: 'TIE2204058E0', re: /todo\s*empanadas/i }
];

// ── Utils de matching (inline, sin deps nuevos) ───────────────────────────
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // sin acentos
    .replace(/[^a-z0-9\s]/g, ' ')                      // sin puntuación
    .replace(/\s+/g, ' ')
    .trim();
}

// Jaccard simple sobre tokens (palabras): |A∩B| / |A∪B|.
function jaccardScore(a, b) {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union ? inter / union : 0;
}

// Fallback regex hardcoded (CI/test, o Reino A sin crawl). Devuelve el
// mismo shape { sid, rfcEmisor }.
function resolveSidLegacy(establecimiento) {
  const n = (establecimiento || '').trim();
  if (!n) return null;
  for (const entry of SID_CATALOG) {
    if (entry.re.test(n)) return entry;
  }
  return null;
}

// Cuántas filas activas hay en wansoft_sid_map. Si la tabla no existe
// (p.ej. Reino A todavía sin crawl) → 0, y se cae al legacy.
function sidMapActiveCount() {
  try {
    return db.prepare('SELECT COUNT(*) c FROM wansoft_sid_map WHERE activo=1').get().c || 0;
  } catch {
    return 0;
  }
}

// Cobertura: fracción de tokens del establecimiento presentes en el texto
// del candidato. DESVIACIÓN JUSTIFICADA de la spec (que pedía jaccard) SOLO
// para desambiguar candidatos del mismo RFC: al concatenar
// sucursal+direccion+marca el denominador de Jaccard se infla con tokens de
// la dirección y nunca supera 0.4 aunque el match sea perfecto (causa raíz
// de las 2 fallas previas del E2E). Cobertura mide "¿están los tokens del
// ticket en el candidato?", que es justo lo que se quiere acá.
function coverageScore(text, target) {
  const tt = new Set(normalizeText(target).split(' ').filter(Boolean));
  const ct = new Set(normalizeText(text).split(' ').filter(Boolean));
  if (!tt.size || !ct.size) return 0;
  let inter = 0;
  for (const t of tt) if (ct.has(t)) inter++;
  return inter / tt.size;
}

// Fuzzy general por marca_nombre / razon_social (Jaccard + gap, tal cual spec).
function fuzzyByName(all, target) {
  const scored = all.map(c => ({
    c,
    score: Math.max(
      jaccardScore(c.marca_nombre, target),
      jaccardScore(c.razon_social || '', target)
    )
  })).filter(x => x.score > 0.4);
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 1) return scored[0].c;
  if (scored.length > 1 && scored[0].score > scored[1].score * 1.3) return scored[0].c;
  return null;
}

// resolveSid HÍBRIDO v2 (opción B). Consulta wansoft_sid_map:
//  1) match por RFC del emisor; si >1 candidato, scorea contra
//     sucursal_nombre + direccion + marca_nombre COMBINADOS (cobertura).
//     - max > 0.4 y sin empate → ese.
//     - empate o todos <= 0.4 → cae al fuzzy general.
//  2) fuzzy general por marca_nombre / razon_social.
//  3) todo falla → null (+ alert_reino_b lo pone el handler).
//  4) tabla vacía/inexistente → SID_CATALOG hardcoded.
// Síncrono: better-sqlite3 es síncrono.
function resolveSid(establecimiento, rfcEmisor) {
  if (sidMapActiveCount() === 0) {
    return resolveSidLegacy(establecimiento);
  }
  const target = normalizeText(establecimiento);

  let all = [];
  try {
    all = db.prepare('SELECT * FROM wansoft_sid_map WHERE activo = 1').all();
  } catch { all = []; }

  // 1. Match por RFC del emisor (lo más confiable).
  if (rfcEmisor) {
    const candidatos = all.filter(c => c.rfc_emisor === rfcEmisor);
    if (candidatos.length === 1) return candidatos[0];
    if (candidatos.length > 1) {
      const scored = candidatos.map(c => ({
        c,
        score: coverageScore(
          `${c.sucursal_nombre || ''} ${c.direccion || ''} ${c.marca_nombre || ''}`,
          target
        )
      }));
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0];
      const tie = scored.length > 1 && scored[1].score === top.score;
      if (top.score > 0.4 && !tie) return top.c;
      // empate o todos <= 0.4 → cae al fuzzy general
    }
  }

  // 2. Fallback fuzzy general por marca_nombre / razon_social.
  const fuzzy = fuzzyByName(all, target);
  if (fuzzy) return fuzzy;

  // 3. Red de seguridad: marcas multi-sucursal sin rfc_emisor disponible
  // hacen que fuzzyByName devuelva null por ambigüedad. Caer al SID_CATALOG
  // hardcoded como último recurso antes de declarar "no reconocida".
  return resolveSidLegacy(establecimiento);
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

// Wansoft espera montos como string con punto y 2 decimales: "75.00",
// "0.00". Acepta number, "75", "75,00", "$75.00" y normaliza.
function formatMoney(v) {
  if (v == null) return '0.00';
  let s = String(v).trim().replace(/[^\d.,-]/g, '');
  // "1.234,56" (es-MX con miles) → "1234.56"
  if (/,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const num = parseFloat(s);
  return Number.isFinite(num) ? num.toFixed(2) : '0.00';
}

// El bundle de algunos perfiles guarda "G03 - Gastos en general"; el portal
// espera solo el código SAT limpio.
function soloCodigo(value) {
  if (value == null) return '';
  return String(value).trim().split('-')[0].trim();
}

// __RequestVerificationToken del <input type="hidden">. Tolerante al orden
// de atributos (value antes o después de name).
function extractToken(html) {
  if (!html || typeof html !== 'string') return null;
  let m = html.match(/name="__RequestVerificationToken"[^>]*\bvalue="([^"]+)"/i);
  if (m) return m[1];
  m = html.match(/\bvalue="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
  return m ? m[1] : null;
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('wansoft');

  const code = String(ticketData.numero_ticket || ticketData.folio || '').trim();
  if (!code) return { success: false, mensaje: 'Error Wansoft: código de facturación requerido' };

  // FIX 2 — validación client-side de plazo (Wansoft no discrimina en su
  // respuesta). Threshold conservador de 60 días; corta antes de cualquier
  // request si el ticket es viejo.
  if (ticketData.fecha) {
    const ticketDate = new Date(ticketData.fecha);
    const now = new Date();
    const diasTranscurridos = (now - ticketDate) / (1000 * 60 * 60 * 24);
    if (diasTranscurridos > 60) {
      return { success: false, mensaje: 'Ticket con más de 60 días — probablemente fuera de plazo' };
    }
  }

  const sucursal = resolveSid(
    ticketData.establecimiento,
    ticketData.rfc_emisor || ticketData.rfcEmisor || null
  );
  if (!sucursal) {
    // alert_reino_b: el dispatcher solo lee success/mensaje, pero el flag
    // queda para que Reino B sepa que falta mapear esta sucursal al catálogo.
    return {
      success: false,
      mensaje: 'Sucursal Wansoft no reconocida en catálogo',
      alert_reino_b: true
    };
  }
  const sid = sucursal.sid;
  console.log(`[Wansoft] establecimiento="${ticketData.establecimiento}" → sid=${sid} code=${code}`);

  // ── Cookie jar manual (mismo enfoque que benavidesHandler) ────────────
  const jar = {};
  const parseCookies = (h) => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => k + '=' + v).join('; ');

  // ── PASO 1: GET ElectronicInvoice → 302 → autoInvoicing40 ─────────────
  // Seguimos los redirects a mano (maxRedirects:0) para no perder ningún
  // Set-Cookie intermedio y para quedarnos con la URL final exacta del
  // autoInvoicing40 (la necesitamos como Referer en los pasos 2-4).
  let referer;
  let token;
  try {
    let url = `${PUB}/ElectronicInvoice?sid=${sid}`;
    let html = '';
    for (let hop = 0; hop < 5; hop++) {
      const r = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Cookie': cookieHeader() },
        timeout: 30000,
        maxRedirects: 0,
        validateStatus: () => true
      });
      parseCookies(r.headers);
      console.log(`[Wansoft] PASO1 hop=${hop} GET ${url} → status=${r.status}`);
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        url = r.headers.location.startsWith('http')
          ? r.headers.location
          : ORIGIN + r.headers.location;
        continue;
      }
      if (r.status >= 400) {
        // FIX 1 — 404 con status real (vs. el 404 servido como 200 que
        // captura el check referer.includes('/404') más abajo).
        if (r.status === 404) {
          return { success: false, mensaje: 'Marca Wansoft no disponible (HTTP 404)', alert_reino_b: true };
        }
        return { success: false, mensaje: `Error Wansoft: PASO1 HTTP ${r.status}` };
      }
      html = typeof r.data === 'string' ? r.data : '';
      referer = url;
      break;
    }
    if (!referer) {
      return { success: false, mensaje: 'Error Wansoft: PASO1 sin página de facturación' };
    }
    // FIX 1 — detectar sid roto: 200 OK pero sin formulario válido.
    if (referer.includes('/404')) {
      return { success: false, mensaje: 'Marca Wansoft no disponible (404)', alert_reino_b: true };
    }
    if (!referer.includes('autoInvoicing')) {
      return { success: false, mensaje: 'Sucursal Wansoft deshabilitada (sid roto)', alert_reino_b: true };
    }
    token = extractToken(html);
    console.log(`[Wansoft] PASO1 referer=${referer} cookies=[${Object.keys(jar).join(',')}] token=${token ? token.length + ' chars' : 'NO ENCONTRADO'}`);
    if (!token) {
      return { success: false, mensaje: 'Sucursal Wansoft devolvió formulario inválido', alert_reino_b: true };
    }
  } catch (e) {
    reportApi(`${PUB}/ElectronicInvoice?sid=${sid}`, null, e);
    return { success: false, mensaje: 'Error Wansoft: PASO1 excepción — ' + e.message };
  }

  // Headers comunes de los POST AJAX (pasos 2-4).
  const ajaxOpts = () => ({
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': referer,
      'Origin': ORIGIN,
      'User-Agent': UA,
      'Cookie': cookieHeader()
    },
    timeout: 30000,
    validateStatus: () => true
  });

  // ── PASO 2: GetBillingInformation ─────────────────────────────────────
  let info;
  try {
    const body = new URLSearchParams({ code, subsidiaryId: String(sid) }).toString();
    const r = await axios.post(`${PUB}/GetBillingInformation`, body, ajaxOpts());
    parseCookies(r.headers);
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[Wansoft] PASO2 GetBillingInformation status=${r.status} body=${bodyStr.substring(0, 400)}`);
    if (r.status >= 400) {
      return { success: false, mensaje: `Error Wansoft: PASO2 HTTP ${r.status}` };
    }

    const data = r.data || {};
    const billing = data.billingCodeInfo;
    const msg = String(data.Message || '').trim();

    if (!billing) {
      // Wansoft NO devuelve billingCodeInfo en estos casos (scout addendum
      // HALLAZGO 3) — discriminar por el texto de Message, no por MessageType.
      if (/ya\s+se\s+encuentra\s+facturad/i.test(msg)) {
        return { success: false, mensaje: 'Ticket ya facturado previamente' };
      }
      if (/no\s+est[áa]\s+disponible|no\s+existe/i.test(msg)) {
        return { success: false, mensaje: 'Código de facturación inválido o ticket no disponible' };
      }
      // FIX 2 — regex de "plazo vencido" eliminada: capturado en vivo que
      // Wansoft NUNCA devuelve ese mensaje. La detección de plazo es
      // client-side al inicio de ejecutar() (threshold 60 días).
      // FIX 3 — código con formato inválido (Wansoft sí devuelve este texto).
      if (/c[óo]digo\s+de\s+factura\s+es\s+invalido/i.test(msg)) {
        return { success: false, mensaje: 'Código de facturación con formato inválido (debe ser de 18 dígitos numéricos)' };
      }
      return { success: false, mensaje: `Error Wansoft: ${msg || 'respuesta sin datos del ticket'}` };
    }

    // billingCodeInfo presente — validar estados específicos del POS:
    if (billing.isCanceled === true) {
      return { success: false, mensaje: 'Ticket cancelado en POS' };
    }
    // Defensa por edge case (en teoría Wansoft corta antes y no manda
    // billingCodeInfo si ya está facturado, pero por si acaso):
    if (billing.Invoiced === true) {
      return { success: false, mensaje: 'Ticket ya facturado previamente' };
    }

    info = billing;
    console.log(`[Wansoft] PASO2 Total=${info.Total} Tip=${info.Tip} Order=${info.Order} Date=${info.FormattedTicketDate}`);
  } catch (e) {
    reportApi(`${PUB}/GetBillingInformation`, { code, subsidiaryId: sid }, e);
    return { success: false, mensaje: 'Error Wansoft: PASO2 excepción — ' + e.message };
  }

  // Montos autoritativos = los que reporta el POS (no ticketData.total).
  const totalStr = formatMoney(info.Total);
  const tipStr = formatMoney(info.Tip);

  // ── PASO 3: GetBillingInformationWithTotalAndTip ──────────────────────
  // El server usa esta llamada para precargar hidden fields en sesión.
  try {
    const body = new URLSearchParams({
      code,
      subsidiaryId: String(sid),
      totalInvoice: totalStr,
      tip: tipStr
    }).toString();
    const r = await axios.post(`${PUB}/GetBillingInformationWithTotalAndTip`, body, ajaxOpts());
    parseCookies(r.headers);
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[Wansoft] PASO3 GetBillingInformationWithTotalAndTip status=${r.status} body=${bodyStr.substring(0, 300)}`);
    if (r.status >= 400) {
      return { success: false, mensaje: `Error Wansoft: PASO3 HTTP ${r.status}` };
    }
    // FIX 4 — Wansoft también valida en PASO 3: si no devuelve
    // billingCodeInfo pero sí un Message, es un rechazo, no avanzar a PASO 4.
    const data3 = r.data || {};
    if (!data3.billingCodeInfo && data3.Message) {
      return { success: false, mensaje: `Error Wansoft PASO 3: ${data3.Message}` };
    }
  } catch (e) {
    reportApi(`${PUB}/GetBillingInformationWithTotalAndTip`, { code, subsidiaryId: sid }, e);
    return { success: false, mensaje: 'Error Wansoft: PASO3 excepción — ' + e.message };
  }

  // ── PASO 4: IssueDocument40 (TIMBRADO REAL — doble slash literal) ──────
  // Orden de campos = orden de aparición observado en la captura.
  const issueBody = new URLSearchParams();
  issueBody.append('subsidiaryId', String(sid));
  issueBody.append('BillingCode', code);
  issueBody.append('Date', String(info.FormattedTicketDate || ''));
  issueBody.append('OrderNumber', String(info.Order || ''));
  issueBody.append('TotalInvoice', totalStr);
  issueBody.append('TipInvoice', tipStr);
  issueBody.append('Total', totalStr);
  issueBody.append('Tip', tipStr);
  issueBody.append('rfc', perfil.rfc || '');
  issueBody.append('legalName', perfil.razon_social || perfil.nombre_sat || perfil.nombre || '');
  issueBody.append('email', perfil.email || '');
  issueBody.append('CP', perfil.cp || '');
  issueBody.append('receiverFiscalRegime', soloCodigo(perfil.regimen_fiscal || perfil.regimen) || '612');
  issueBody.append('ReceiverCfdiUse', soloCodigo(perfil.uso_cfdi) || 'G03');
  // DetailedOrGroupedInvoiceSelection: SELECT de 2 opciones (scout addendum
  // HALLAZGO 1). value="1" = "CONSUMO DE ALIMENTOS Y BEBIDAS" (agrupado,
  // DEFAULT); value="2" = todos los conceptos (detallado).
  issueBody.append('DetailedOrGroupedInvoiceSelection', '1');
  issueBody.append('__RequestVerificationToken', token);
  issueBody.append('countBillingCodes', '1');

  try {
    const r = await axios.post(ISSUE_URL, issueBody.toString(), ajaxOpts());
    parseCookies(r.headers);
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[Wansoft] PASO4 IssueDocument40 status=${r.status} body=${bodyStr.substring(0, 600)}`);

    if (r.status !== 200) {
      return { success: false, mensaje: `Error Wansoft: PASO4 HTTP ${r.status}` };
    }
    const doc = r.data?.Document;
    const uuid = doc?.UUID;
    // Éxito real (scout 4.1): NO confiar en MessageType. Exigir UUID válido
    // + status Vigente.
    if (!uuid || uuid === UUID_ZERO || doc?.status !== 'Vigente') {
      const detalle = r.data?.Message || bodyStr.substring(0, 200);
      // FIX 2 — regex de "plazo vencido" eliminada también acá (código
      // muerto: Wansoft nunca devuelve ese texto; plazo es client-side).
      return { success: false, mensaje: `Error Wansoft: ${detalle || 'timbrado no confirmado'}` };
    }

    const pdf_url = `${PUB}/DownloadPdf?UUID=${encodeURIComponent(uuid)}&SubsidiaryId=${sid}`;
    const xml_url = `${PUB}/DownloadXml?UUID=${encodeURIComponent(uuid)}&SubsidiaryId=${sid}`;
    console.log(`[Wansoft] PASO4 OK uuid=${uuid} reference=${r.data?.Reference} status=${doc.status}`);
    return {
      success: true,
      mensaje: 'Factura emitida',
      uuid,
      pdf_url,
      xml_url
    };
  } catch (e) {
    reportApi(ISSUE_URL, '[body omitido: contiene token/RFC]', e);
    return { success: false, mensaje: 'Error Wansoft: PASO4 excepción — ' + e.message };
  }
}

module.exports = { ejecutar };
