// Handler aislado para 7-Eleven México (e7-eleven.com.mx).
// Stack: Konesh KPortalExterno (mismo que Petro 7), distinto BASE.
//
// Flujo: sesión → verificaTicketWS2 → Kaptcha (CapSolver image-to-text)
//        → captchaValidator → POST FacturaExpressService (urlencoded).

const axios = require('axios');
const https = require('https');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://www.e7-eleven.com.mx';

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
  const reportApi = makeReportApi('seveneleven');
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  // Cookie jar manual
  const jar = {};
  const parseCookies = h => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieStr = () => Object.entries(jar).map(([k,v]) => k+'='+v).join('; ');

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Origin': BASE,
    'Referer': BASE + '/facturacion/KPortalExterno/'
  };
  const opts = (extra = {}) => ({
    headers: { ...baseHeaders, Cookie: cookieStr(), ...extra },
    httpsAgent, validateStatus: () => true, timeout: 30000
  });

  // Validación entrada
  const noTicket = String(ticketData?.numero_ticket || ticketData?.folio || '');
  if (!noTicket) return { success: false, mensaje: '7-Eleven: numero_ticket (barcode 35 chars) requerido' };
  if (!perfil?.rfc) return { success: false, mensaje: '7-Eleven: RFC del perfil requerido' };

  console.log(`[AUTO] 7-Eleven - noTicket=${noTicket} (len=${noTicket.length}) rfc=${perfil.rfc}`);

  // 1. Establecer sesión (semilla de cookies)
  try {
    const r = await axios.get(BASE + '/facturacion/KPortalExterno/', opts());
    parseCookies(r.headers);
    console.log('[AUTO] 7-Eleven - sesión:', Object.keys(jar).join(','));
  } catch (e) {
    reportApi(BASE + '/facturacion/KPortalExterno/', null, e);
    return { success: false, mensaje: '7-Eleven: error sesión - ' + e.message };
  }

  // 2. verificaTicketWS2 — el server devuelve estacion, formaPago, totalTicket, webid, fecha automáticamente
  let estacion, formaPago, monto;
  try {
    const v = await axios.get(BASE + '/KJServices/webapi/FacturacionService/verificaTicketWS2', {
      ...opts(),
      params: { noTicket }
    });
    console.log(`[AUTO] 7-Eleven - verificaTicketWS2 status=${v.status} body=${JSON.stringify(v.data).substring(0,400)}`);
    if (v.data?.status !== '0' && v.data?.status !== 0) {
      const msg = v.data?.mensajeValidacion || v.data?.respuesta || 'sin detalle';
      return { success: false, mensaje: `7-Eleven: ticket rechazado por verificaTicketWS2 — ${msg} (noTicket=${noTicket})` };
    }
    estacion = String(v.data?.estacion || '');
    formaPago = String(v.data?.formaPago || '');
    // Campo en POST se llama "monto", se toma de "totalTicket" del response
    monto = String(v.data?.totalTicket ?? '');
  } catch (e) {
    reportApi(BASE + '/KJServices/webapi/FacturacionService/verificaTicketWS2', { noTicket }, e);
    return { success: false, mensaje: '7-Eleven: error verificaTicketWS2 - ' + e.message };
  }

  if (!estacion || !formaPago || !monto) {
    return { success: false, mensaje: `7-Eleven: verificaTicketWS2 devolvió campos vacíos (estacion=${estacion}, formaPago=${formaPago}, monto=${monto})` };
  }

  // 3. Resolver Kaptcha (imagen JPG) — requiere CapSolver ImageToText
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) return { success: false, mensaje: '7-Eleven: CAPSOLVER_API_KEY no configurada' };

  let captchaText;
  try {
    const img = await axios.get(BASE + '/KPortalExterno/Kaptcha.jpg', { ...opts(), responseType: 'arraybuffer' });
    parseCookies(img.headers);
    const captchaB64 = Buffer.from(img.data).toString('base64');
    const contentType = img.headers['content-type'] || 'unknown';
    console.log(`[AUTO] 7-Eleven - Kaptcha image: ${img.data.length} bytes, content-type=${contentType}, b64.length=${captchaB64.length}`);
    if (img.data.length < 500) {
      return { success: false, mensaje: '7-Eleven: Kaptcha image demasiado pequeña (' + img.data.length + ' bytes), revisa cookies' };
    }

    // Resolver con CapSolver — intentar varios módulos si falla.
    // ImageToTextTask normalmente resuelve sincrónicamente: createTask retorna status=ready
    // con solution.text en la misma respuesta. Si no, hacer polling.
    const modulosACobrar = ['common', 'queueit'];
    let createData;
    let createErr;
    for (const mod of modulosACobrar) {
      try {
        const create = await axios.post('https://api.capsolver.com/createTask', {
          clientKey: capKey,
          task: { type: 'ImageToTextTask', body: captchaB64, module: mod }
        }, { timeout: 15000, validateStatus: () => true });
        console.log(`[AUTO] 7-Eleven - CapSolver createTask(module=${mod}) status=${create.status} body=${JSON.stringify(create.data).substring(0,500)}`);
        if (create.data.errorId) {
          createErr = create.data.errorDescription || create.data.errorCode || ('HTTP ' + create.status);
          continue;
        }
        if (create.data.status === 'ready' || create.data.solution?.text || create.data.taskId) {
          createData = { ...create.data, _module: mod };
          break;
        }
        createErr = 'createTask sin solution ni taskId: ' + JSON.stringify(create.data).substring(0, 200);
      } catch (e) {
        createErr = e.message;
        console.log(`[AUTO] 7-Eleven - CapSolver createTask(module=${mod}) EXCEPCIÓN: ${e.message} response=${JSON.stringify(e.response?.data).substring(0,300)}`);
      }
    }
    if (!createData) return { success: false, mensaje: '7-Eleven: CapSolver createTask falló - ' + createErr };

    if (createData.status === 'ready' || createData.solution?.text) {
      captchaText = createData.solution?.text || '';
      if (!captchaText) return { success: false, mensaje: '7-Eleven: CapSolver status=ready sin texto' };
      console.log(`[AUTO] 7-Eleven - captcha resuelto sincrónicamente (module=${createData._module}): "${captchaText}"`);
    } else {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const res = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capKey, taskId: createData.taskId }, { timeout: 15000, validateStatus: () => true });
        console.log(`[AUTO] 7-Eleven - CapSolver getTaskResult[${i}] status=${res.data.status} errorId=${res.data.errorId || 0} body=${JSON.stringify(res.data).substring(0,400)}`);
        if (res.data.status === 'ready') {
          captchaText = res.data.solution?.text || '';
          break;
        }
        if (res.data.errorId) {
          return { success: false, mensaje: `7-Eleven: CapSolver error - ${res.data.errorCode}: ${res.data.errorDescription}` };
        }
      }
      if (!captchaText) return { success: false, mensaje: '7-Eleven: CapSolver timeout sin solución' };
      console.log(`[AUTO] 7-Eleven - captcha resuelto via polling (module=${createData._module}): "${captchaText}"`);
    }
  } catch (e) {
    console.log(`[AUTO] 7-Eleven - excepción captcha: ${e.message} status=${e.response?.status} data=${JSON.stringify(e.response?.data).substring(0,300)}`);
    return { success: false, mensaje: '7-Eleven: error captcha - ' + e.message };
  }

  // 4. Validar captcha contra captchaValidator (path distinto a Petro 7)
  try {
    const r = await axios.get(BASE + '/KJServices/webapi/captchaValidator/', { ...opts(), params: { kaptcha: captchaText } });
    parseCookies(r.headers);
    console.log('[AUTO] 7-Eleven - captchaValidator:', JSON.stringify(r.data));
    if (!r.data?.esValido) {
      return { success: false, mensaje: '7-Eleven: captcha rechazado - ' + (r.data?.mensaje || captchaText) };
    }
  } catch (e) {
    reportApi(BASE + '/KJServices/webapi/captchaValidator/', { kaptcha: captchaText }, e);
    return { success: false, mensaje: '7-Eleven: error validando captcha - ' + e.message };
  }

  // 5. Construir tickets array (shape exacto del scope Angular del portal)
  const ticket = {
    noEstacion: estacion,
    noTicket,
    monto,
    formaPago,
    id: null
  };
  console.log('[AUTO] 7-Eleven - ticket:', JSON.stringify(ticket));

  // 6. POST FacturaExpressService (urlencoded)
  // Orden y nombres de campos espejean el bundle JS del portal
  // (kportalexterno.js, ExpressFormController). 20 campos exactos.
  const params = new URLSearchParams({
    tickets: JSON.stringify([ticket]),
    idCliente: '',
    rfc: String(perfil.rfc).toUpperCase(),
    razon: String(perfil.nombre_sat || perfil.nombre || '').toUpperCase(),
    usoCFDI: perfil.uso_cfdi || 'G03',
    calle: '',
    noExterior: '',
    noInterior: '',
    colonia: '',
    delegacion: '',
    ciudad: '',
    cp: String(perfil.cp || ''),
    pais: '',
    email: String(perfil.email || '').toLowerCase(),
    facturaExpress: 'true',
    facturaRegistrado: 'true',
    selectedFormaPago: formaPago,
    formaPagoAux: formaPago,
    medioEmision: 'FEXPRESS',
    regimenFiscalReceptor: perfil.regimen || '612'
  });

  const paramsStr = params.toString();
  console.log(`[AUTO] 7-Eleven - FacturaExpress payload size=${paramsStr.length} bytes`);
  for (let i = 0; i < paramsStr.length; i += 1500) {
    console.log(`[AUTO] 7-Eleven - FacturaExpress payload[${i}-${Math.min(i+1500, paramsStr.length)}]: ${paramsStr.substring(i, i+1500)}`);
  }

  try {
    const r = await axios.post(
      BASE + '/KJServices/webapi/FacturaExpressService',
      paramsStr,
      opts({ 'Content-Type': 'application/x-www-form-urlencoded' })
    );
    parseCookies(r.headers);
    const bodyStr = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data ?? '');
    console.log(`[AUTO] 7-Eleven - FacturaExpress RESPONSE status=${r.status} headers=${JSON.stringify(r.headers).substring(0,400)}`);
    for (let i = 0; i < bodyStr.length && i < 4500; i += 1500) {
      console.log(`[AUTO] 7-Eleven - FacturaExpress body[${i}-${Math.min(i+1500, bodyStr.length)}]: ${bodyStr.substring(i, i+1500)}`);
    }

    if (r.status >= 400) {
      reportApi(BASE + '/KJServices/webapi/FacturaExpressService', { tickets: [ticket] }, { response: r, message: 'HTTP ' + r.status });
      return { success: false, mensaje: '7-Eleven: HTTP ' + r.status + ' - ' + bodyStr.substring(0, 200) };
    }

    const data = r.data || {};
    const uuid = data.uuid || data.cfdis?.[0]?.uuid || (Array.isArray(data) ? data[0]?.uuid : null);
    if (uuid) {
      console.log(`[AUTO] 7-Eleven - CFDI timbrado uuid=${uuid}`);
      return { success: true, uuid, mensaje: '7-Eleven: factura emitida' };
    }

    if (data.status === '0' || data.status === 0 || data.status === 'OK') {
      return { success: true, mensaje: '7-Eleven: factura solicitada (sin UUID directo) - ' + bodyStr.substring(0, 200) };
    }

    const msg = data.mensaje || data.mensajeValidacion || bodyStr.substring(0, 200);
    return { success: false, mensaje: '7-Eleven: respuesta sin UUID - ' + msg };
  } catch (e) {
    reportApi(BASE + '/KJServices/webapi/FacturaExpressService', { tickets: [ticket] }, e);
    return { success: false, mensaje: '7-Eleven: error FacturaExpress - ' + e.message };
  }
}

module.exports = { ejecutar };
