// Handler HTTP-only para facturacion.heb.com.mx.
//
// Verificado por grabación (expansion/apis/heb_full.json):
//   GET  /cli/api/configuration/initializer
//   GET  /cli/api/usersession/login_authenticate?login=generico&password=&guid=
//   GET  /cli/api/usersession/data_sel?force_from_db=false
//   GET  /cli/api/facturacion/int_store_sel
//
// Conocido del bundle JS (no capturados request body en runtime — el
// datepicker Material bloqueó el flujo de UI):
//   POST /cli/api/facturacion/buscar_ticket
//   POST /cli/api/facturacion/int_ticket_sel
//   POST /cli/api/facturacion/int_ticket_valida_rfc
//   POST /cli/api/facturacion/datos_fiscales_factura
//   POST /cli/api/facturacion/timbrar
//
// Auth: header `acce-id: <accE_ID>` además del Bearer JWT del login.
// El accE_ID viene de data_sel.list_perfil_acceso[].accE_ID; necesitamos
// el de "Facturación de tickets" que NO está en la captura (solo vimos
// "Consulta de facturas de tickets" accE_ID=5). El bundle hace
// timbrar(payload, accessGenerateButton.accE_ID, isFacturaIndividual).
//
// TODO antes de ser confiable:
//   1. Capturar accE_ID correcto del flujo de creación (no de consulta).
//   2. Capturar request body de buscar_ticket / timbrar con un ticket real.
// Por ahora el handler hace login + busca tienda + intenta buscar_ticket
// con shape inferida del nombre de columnas observadas en int_store_sel
// (storE_ID, etc.). Si falla en buscar_ticket, devuelve mensaje claro.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://facturacion.heb.com.mx';

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

// Convierte fecha a ISO 8601 (YYYY-MM-DDT00:00:00). HEB acepta varios formatos
// pero el datepicker Material genera ISO local. Lo enviamos como ISO local
// sin offset; si el server lo rechaza, ajustar.
function fechaIsoLocal(s) {
  if (!s) return null;
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[0]}T00:00:00`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2,'0'), mm = m[2].padStart(2,'0');
    return `${m[3]}-${mm}-${dd}T00:00:00`;
  }
  return null;
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('heb');

  const tienda = ticketData.numero_tienda || '';
  const folio  = ticketData.folio || ticketData.numero_ticket || '';
  const fecha  = fechaIsoLocal(ticketData.fecha_compra || ticketData.fecha_formateada);
  const total  = ticketData.total;

  if (!tienda) return { success: false, mensaje: 'HEB: numero_tienda requerido' };
  if (!folio)  return { success: false, mensaje: 'HEB: folio (número de ticket) requerido' };
  if (!fecha)  return { success: false, mensaje: 'HEB: fecha requerida' };
  if (total == null) return { success: false, mensaje: 'HEB: total requerido' };

  const baseHeaders = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Origin': BASE,
    'Referer': BASE + '/cli/invoice-create/'
  };
  const opts = (extra = {}) => ({
    headers: { ...baseHeaders, ...extra },
    timeout: 30000, validateStatus: () => true
  });

  // 1. Login anónimo (login=generico). Verified — devuelve JWT.
  let token, guid;
  try {
    const r = await axios.get(BASE + '/cli/api/usersession/login_authenticate', {
      ...opts(), params: { login: 'generico', password: '', guid: '' }
    });
    if (r.status >= 400 || !r.data?.token) {
      return { success: false, mensaje: `HEB login_authenticate falló — ${r.status} ${JSON.stringify(r.data).substring(0,150)}` };
    }
    token = r.data.token;
    guid = r.data.guid;
    console.log(`[AUTO] HEB login OK guid=${guid}`);
  } catch (e) {
    reportApi(BASE + '/cli/api/usersession/login_authenticate', { login: 'generico' }, e);
    return { success: false, mensaje: 'HEB login excepción — ' + e.message };
  }
  const auth = { 'Authorization': `Bearer ${token}` };

  // 2. data_sel. Verified — devuelve user_info + list_perfil_acceso.
  let acceFacturacionId = null;
  try {
    const r = await axios.get(BASE + '/cli/api/usersession/data_sel?force_from_db=false', opts(auth));
    if (r.status >= 400) {
      return { success: false, mensaje: `HEB data_sel HTTP ${r.status}` };
    }
    const accesos = r.data?.list_perfil_acceso || [];
    // Buscar el acceso para CREAR factura (no solo consultar)
    const facturar = accesos.find(a => /facturaci[óo]n/i.test(a.accE_NOMBRE || '') && !/consulta/i.test(a.accE_NOMBRE || ''));
    if (facturar) acceFacturacionId = facturar.accE_ID;
    console.log(`[AUTO] HEB data_sel OK accesos=${accesos.length} acceFacturacionId=${acceFacturacionId}`);
  } catch (e) {
    reportApi(BASE + '/cli/api/usersession/data_sel', null, e);
    return { success: false, mensaje: 'HEB data_sel excepción — ' + e.message };
  }
  if (!acceFacturacionId) {
    // Fallback: probar accE_ID=5 (que vimos en captura como "Consulta") por
    // si el endpoint también lo acepta. Si no, devolvemos manual con diagnóstico.
    console.log('[AUTO] HEB no encontró acceso "Facturación", probando accE_ID=5');
    acceFacturacionId = 5;
  }
  const acceHeader = { 'acce-id': String(acceFacturacionId) };

  // 3. buscar_ticket — body shape INFERIDA. Confirmar con captura real.
  // Inferencia basada en columnas de int_store_sel (storE_ID) y nombres
  // estándar HEB (nO_TICKET, fechA_TICKET, montO_TICKET).
  const buscarBody = {
    storE_ID: parseInt(tienda, 10),
    nO_TICKET: folio,
    fechA_TICKET: fecha,
    montO_TICKET: Number(total)
  };
  try {
    const r = await axios.post(BASE + '/cli/api/facturacion/buscar_ticket', buscarBody, opts({ ...auth, ...acceHeader }));
    console.log(`[AUTO] HEB buscar_ticket status=${r.status} body=${JSON.stringify(r.data).substring(0,250)}`);
    if (r.status >= 400) {
      return {
        success: false,
        mensaje: `HEB buscar_ticket HTTP ${r.status} — ${JSON.stringify(r.data).substring(0,200)}. ` +
                 `TODO: confirmar shape del body (probado: ${JSON.stringify(buscarBody)}).`
      };
    }
    if (r.data?.result?.success === false) {
      return { success: false, mensaje: `HEB buscar_ticket rechazado — ${r.data?.result?.result_message_user || JSON.stringify(r.data).substring(0,150)}` };
    }
  } catch (e) {
    reportApi(BASE + '/cli/api/facturacion/buscar_ticket', buscarBody, e);
    return { success: false, mensaje: 'HEB buscar_ticket excepción — ' + e.message };
  }

  // TODO: el resto del flujo (int_ticket_sel → int_ticket_valida_rfc →
  // datos_fiscales_factura → timbrar) requiere capturar request body y
  // response shape con un ticket real. El bundle JS muestra que timbrar
  // recibe (payload, accE_ID, isFacturaIndividual) pero no puedo derivar
  // el shape de payload sin runtime data.
  return {
    success: false,
    mensaje: 'HEB: buscar_ticket pasó (login + sesión OK), pero el flujo siguiente ' +
             '(int_ticket_sel → int_ticket_valida_rfc → datos_fiscales_factura → timbrar) ' +
             'requiere captura runtime con ticket real para conocer shapes. Marca como manual.',
    needs_manual_capture: true
  };
}

module.exports = { ejecutar };
