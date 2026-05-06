// Handler HTTP-only para e-facturate.com/benavides/ (Farmacias Benavides).
//
// Verificado por grabación (expansion/apis/benavides_full.json):
//   POST /benavides/DataProcessor.aspx/GetCFDI
//   POST /benavides/DataProcessor.aspx/GetPaymentMethods
//   POST /benavides/DataProcessor.aspx/GetCountries
//   POST /benavides/DataProcessor.aspx/PoliticasCliente
//   POST /benavides/DataProcessor.aspx/CustomLabelsCliente
//
// Form fields visibles capturados: txt_ticket, txt_total, txt_rfccliente,
// chk_extranjero. NO tiene campo tienda ni fecha en el form principal.
//
// TODO: el endpoint de SUBMIT no fue capturado (driver crashed por
// CSS.escape antes de llegar al click final). Probable:
// /benavides/DataProcessor.aspx/{InsertCFDI,GenerateCFDI,EmiteCFDI,GuardaCFDI}.
// Hasta confirmarlo el handler hace setup HTTP y se rinde con manual.

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://e-facturate.com';
const PATH = '/benavides';

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
  const reportApi = makeReportApi('benavides');

  const folio = ticketData.folio || ticketData.numero_ticket || '';
  const total = ticketData.total;
  if (!folio) return { success: false, mensaje: 'Benavides: folio (txt_ticket) requerido' };
  if (total == null) return { success: false, mensaje: 'Benavides: total requerido' };

  // ASP.NET WebMethod: Content-Type application/json, body es JSON con
  // los args del método. Cookie jar manual para mantener sesión ASP.NET.
  const jar = {};
  const parseCookies = (h) => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieStr = () => Object.entries(jar).map(([k,v]) => k+'='+v).join('; ');
  const baseHeaders = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': BASE,
    'Referer': BASE + PATH + '/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
  const opts = (extra = {}) => ({
    headers: { ...baseHeaders, Cookie: cookieStr(), ...extra },
    timeout: 30000, validateStatus: () => true
  });

  // 1. GET / para sembrar cookies ASP.NET
  try {
    const r = await axios.get(BASE + PATH + '/', opts());
    parseCookies(r.headers);
    console.log(`[AUTO] Benavides GET / status=${r.status} cookies=${Object.keys(jar).join(',')}`);
  } catch (e) {
    reportApi(BASE + PATH + '/', null, e);
    return { success: false, mensaje: 'Benavides: GET inicial falló — ' + e.message };
  }

  // 2. Llamadas init verificadas. Body {} es lo que captura mostró.
  for (const method of ['PoliticasCliente', 'CustomLabelsCliente', 'GetPaymentMethods', 'GetCountries']) {
    const url = BASE + PATH + '/DataProcessor.aspx/' + method;
    try {
      const r = await axios.post(url, {}, opts());
      parseCookies(r.headers);
      if (r.status >= 400) {
        console.log(`[AUTO] Benavides ${method} HTTP ${r.status} body=${JSON.stringify(r.data).substring(0,150)}`);
      }
    } catch (e) {
      reportApi(url, {}, e);
      // No abortamos — los inits son best-effort para emular el cliente
    }
  }

  // 3. GetCFDI — verificada en captura. Body shape no observado (capturé
  // call sin body en mi grabación). Probablemente recibe {ticket, total, rfc}
  // o algo similar. Inferencia conservadora:
  const cfdiBody = {
    ticket: folio,
    total: Number(total),
    rfc: perfil.rfc,
    extranjero: false
  };
  try {
    const r = await axios.post(BASE + PATH + '/DataProcessor.aspx/GetCFDI', cfdiBody, opts());
    parseCookies(r.headers);
    console.log(`[AUTO] Benavides GetCFDI status=${r.status} body=${JSON.stringify(r.data).substring(0,250)}`);
    if (r.status >= 400) {
      return {
        success: false,
        mensaje: `Benavides GetCFDI HTTP ${r.status} — ${JSON.stringify(r.data).substring(0,200)}. ` +
                 `TODO: confirmar shape del body (probado: ${JSON.stringify(cfdiBody)}).`
      };
    }
    // ASP.NET WebMethod: response viene en {d: <data>}
    const d = r.data?.d || r.data;
    if (!d) {
      return { success: false, mensaje: 'Benavides: GetCFDI sin data en response' };
    }
    // El shape esperado de d es desconocido sin captura runtime. Si tiene
    // success/error explícito, respetarlo.
    if (d.success === false || d.error) {
      return { success: false, mensaje: `Benavides GetCFDI rechazado — ${d.error || JSON.stringify(d).substring(0,150)}` };
    }
  } catch (e) {
    reportApi(BASE + PATH + '/DataProcessor.aspx/GetCFDI', cfdiBody, e);
    return { success: false, mensaje: 'Benavides GetCFDI excepción — ' + e.message };
  }

  // TODO: endpoint de submit (probable EmiteCFDI/InsertCFDI/SaveCFDI) no
  // capturado. Sin él no podemos generar el CFDI. Marcar como manual con
  // diagnóstico.
  return {
    success: false,
    mensaje: 'Benavides: setup OK + GetCFDI llamado, pero endpoint de submit ' +
             'no está capturado todavía. Necesita grabar runtime con form completo.',
    needs_manual_capture: true
  };
}

module.exports = { ejecutar };
