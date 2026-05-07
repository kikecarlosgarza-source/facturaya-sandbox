// Handler 100% backend HTTP para portal de Costco México
// (services3.costco.com.mx/portales/invoice).
//
// Flujo: 2 POSTs — validateCheck (devuelve id_transaccion) +
// generaCFDiXTransaccion (timbra y envía el CFDI por email). Sin fallback a
// WebView. Si el portal exige sesión autenticada, validateCheck fallará y se
// añadirá login en un LOTE-2.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://services3.costco.com.mx/portales/invoice';

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

  const opts = {
    timeout: 30000,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    validateStatus: () => true
  };

  // Paso 1: validateCheck — devuelve id_transaccion en caso de éxito.
  let id_transaccion;
  const body1 = { COMPROBANTE: ticket, RFC: rfc, MONTO: total };
  try {
    const r = await axios.post(`${BASE}/validateCheck`, body1, opts);
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
    reportApi(`${BASE}/validateCheck`, body1, e);
    return { success: false, mensaje: `Costco validateCheck excepción — ${e.message}` };
  }

  // Paso 2: generaCFDiXTransaccion — timbra y envía CFDI por email.
  const body2 = { ID_TRANSACCION: id_transaccion };
  try {
    const r = await axios.post(`${BASE}/generaCFDiXTransaccion`, body2, opts);
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
    reportApi(`${BASE}/generaCFDiXTransaccion`, body2, e);
    return { success: false, mensaje: `Costco timbrado excepción — ${e.message}` };
  }
}

module.exports = { ejecutar };
