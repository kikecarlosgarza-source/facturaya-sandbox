// Handler 100% backend HTTP para portal de Costco México
// (services3.costco.com.mx/portales).
//
// Flujo: 3 POSTs en cadena —
//   Paso 0: oauth/estilos — endpoint público, devuelve accessToken válido ~1h.
//   Paso 1: invoice/validateCheck con X-oauth_token — devuelve id_transaccion.
//   Paso 2: invoice/generaCFDiXTransaccion — timbra y envía CFDI por email.
// Sin fallback a WebView.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://services3.costco.com.mx/portales';

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
  const reportApi = makeReportApi('costco');

  const ticket = ticketData.numero_ticket || ticketData.folio || '';
  const total = String(ticketData.total ?? '');
  const rfc = perfil.rfc;

  if (!ticket) return { success: false, mensaje: 'Costco: numero_ticket (código de barras) requerido' };
  if (!total)  return { success: false, mensaje: 'Costco: total del ticket requerido' };
  if (!rfc)    return { success: false, mensaje: 'Costco: RFC del perfil requerido' };

  console.log(`[AUTO] Costco - ticket=${ticket} rfc=${rfc} total=${total}`);

  const baseHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
  const opts = { timeout: 30000, validateStatus: () => true };

  // Paso 0: obtener accessToken (sin auth previa). Sin este token los demás
  // endpoints responden 401.
  let accessToken;
  const url0 = `${BASE}/oauth/estilos`;
  try {
    const r = await axios.post(url0, {}, { ...opts, headers: baseHeaders });
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[AUTO] Costco oauth/estilos status=${r.status} body=${bodyStr.substring(0, 200)}`);
    if (r.status >= 400) {
      return { success: false, mensaje: `Costco oauth/estilos HTTP ${r.status} — ${bodyStr.substring(0, 200)}` };
    }
    accessToken = r.data?.accessToken;
    if (!accessToken) {
      return { success: false, mensaje: `Costco oauth/estilos sin accessToken — ${bodyStr.substring(0, 200)}` };
    }
  } catch (e) {
    reportApi(url0, {}, e);
    return { success: false, mensaje: `Costco oauth/estilos excepción — ${e.message}` };
  }

  const authHeaders = { ...baseHeaders, 'X-oauth_token': accessToken, 'x-vt': '0' };

  // Paso 1: validateCheck — devuelve id_transaccion en caso de éxito.
  let id_transaccion;
  const url1 = `${BASE}/invoice/validateCheck`;
  const body1 = { COMPROBANTE: ticket, RFC: rfc, MONTO: total };
  try {
    const r = await axios.post(url1, body1, { ...opts, headers: authHeaders });
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[AUTO] Costco validateCheck status=${r.status} body=${bodyStr.substring(0, 500)}`);

    if (r.status >= 400 || r.data?.success === false) {
      const err = r.data?.data?.error_code_description || bodyStr.substring(0, 200);
      return { success: false, mensaje: `Costco validateCheck rechazado — ${err}` };
    }
    id_transaccion = r.data?.response?.id_transaccion;
    if (!id_transaccion) {
      return { success: false, mensaje: `Costco validateCheck sin id_transaccion — ${bodyStr.substring(0, 200)}` };
    }
  } catch (e) {
    reportApi(url1, body1, e);
    return { success: false, mensaje: `Costco validateCheck excepción — ${e.message}` };
  }

  // Paso 2: generaCFDiXTransaccion — timbra y envía CFDI por email.
  const url2 = `${BASE}/invoice/generaCFDiXTransaccion`;
  const body2 = { ID_TRANSACCION: id_transaccion };
  try {
    const r = await axios.post(url2, body2, { ...opts, headers: authHeaders });
    const bodyStr = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    console.log(`[AUTO] Costco generaCFDiXTransaccion status=${r.status} body=${bodyStr.substring(0, 500)}`);

    if (r.status >= 400 || r.data?.success === false) {
      return { success: false, mensaje: `Costco timbrado rechazado — ${bodyStr.substring(0, 300)}` };
    }
    return {
      success: true,
      mensaje: 'Costco: factura solicitada, será enviada por email',
      facturaData: r.data
    };
  } catch (e) {
    reportApi(url2, body2, e);
    return { success: false, mensaje: `Costco timbrado excepción — ${e.message}` };
  }
}

module.exports = { ejecutar };
