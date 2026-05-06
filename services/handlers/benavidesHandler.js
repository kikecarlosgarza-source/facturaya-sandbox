// Handler HTTP-only para e-facturate.com/benavides/ (Farmacias Benavides).
//
// Reescrito desde cero usando blueprint de ingeniería inversa del JS de
// producción del portal:
//
//   GET  /benavides/                                    — sembrar cookies
//   POST /benavides/DataProcessor.aspx/ValidarTicket    — devuelve sal.Tck_Id
//   POST /benavides/DataProcessor.aspx/ObtieneDatosTicket — Items, totales
//   POST /benavides/DataProcessor.aspx/GetZipCodes      — Estado, Municipio, Colonia
//   POST /benavides/DataProcessor.aspx/GeneraFacturaTicket — TIMBRADO REAL
//
// Body wrapper para TODO POST:
//   { json: encodeURIComponent(JSON.stringify(jsonObject)) }
//
// Bug conocido del portal: campo Pais se resetea a "AFG" tras GetZipCodes.
// Workaround: hardcodear Pais="MEX" siempre.
//
// Discriminadores de error (en orden):
//   1. result.mensaje === "Error"  → result.correo es el motivo
//   2. !sal.Tck_Id || sal.MensajeBlock no vacío → TICKET_NO_FACTURABLE

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const ORIGIN = 'https://e-facturate.com';
const PATH   = '/benavides';
const BASE_DP = ORIGIN + PATH + '/DataProcessor.aspx';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

// Body wrapper EXACTO que espera el portal (todos los POST).
function wrapJson(jsonObject) {
  return { json: encodeURIComponent(JSON.stringify(jsonObject)) };
}

// Parser de response ASP.NET ScriptService. response.data.d puede venir
// como string serializado o ya como objeto — manejamos ambos.
function parseResponse(res) {
  const d = res.data?.d;
  if (typeof d === 'string') {
    try { return JSON.parse(d); } catch { return d; }
  }
  return d;
}

// El portal espera fecha en dd/mm/yyyy. Convertir de YYYY-MM-DD si aplica.
function toDDMMYYYY(s) {
  if (!s) return '';
  s = String(s).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[1].padStart(2,'0')}/${m[2].padStart(2,'0')}/${m[3]}`;
  return s;
}

// Solo código SAT, sin descripción. El bundle hace .split('-')[0] al leer
// del select; el server espera string limpio "G03" / "612".
function soloCodigo(value) {
  if (value == null) return '';
  return String(value).trim().split('-')[0].trim();
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('benavides');

  const folio  = ticketData.folio || ticketData.numero_ticket || '';
  const total  = ticketData.total;
  const fecha  = toDDMMYYYY(ticketData.fecha_compra || ticketData.fecha || ticketData.fecha_formateada);
  const tienda = ticketData.numero_tienda || '';

  if (!folio)        return { success: false, mensaje: 'Benavides: folio requerido' };
  if (total == null) return { success: false, mensaje: 'Benavides: total requerido' };
  if (!fecha)        return { success: false, mensaje: 'Benavides: fecha requerida' };

  // Cookie jar manual
  const jar = {};
  const parseCookies = (h) => {
    const sc = h?.['set-cookie']; if (!sc) return;
    (Array.isArray(sc) ? sc : [sc]).forEach(c => {
      const [nv] = c.split(';'); const [n, v] = nv.split('=');
      if (n) jar[n.trim()] = v ? v.trim() : '';
    });
  };
  const cookieHeader = () => Object.entries(jar).map(([k,v]) => k+'='+v).join('; ');

  function postOpts() {
    return {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': ORIGIN + PATH + '/',
        'Origin': ORIGIN,
        'User-Agent': UA,
        'Cookie': cookieHeader()
      },
      timeout: 30000,
      validateStatus: () => true
    };
  }

  // STEP 0: GET inicial para sembrar cookies
  try {
    const r = await axios.get(ORIGIN + PATH + '/', {
      headers: { 'User-Agent': UA },
      timeout: 30000,
      validateStatus: () => true
    });
    parseCookies(r.headers);
    console.log('[Benavides] init GET status:', r.status);
    console.log('[Benavides] init cookies set:', Object.keys(jar).join(','));
  } catch (e) {
    reportApi(ORIGIN + PATH + '/', null, e);
    return { success: false, mensaje: 'Benavides: GET inicial falló — ' + e.message };
  }

  // STEP 1: ValidarTicket
  // Payload exacto del blueprint: Folio + Total + Fecha + Sucursal + RFC
  const validarPayload = {
    Folio: String(folio),
    Total: total,
    Fecha: fecha,
    Sucursal: tienda || '0',
    RFC: perfil.rfc
  };
  let tckId, sal1;
  try {
    const r = await axios.post(BASE_DP + '/ValidarTicket', wrapJson(validarPayload), postOpts());
    parseCookies(r.headers);
    console.log('[Benavides] ValidarTicket status:', r.status);
    if (r.status >= 400) {
      console.error('[Benavides] ValidarTicket HTTP error body keys:', Object.keys(r.data || {}).join(','));
      return { success: false, mensaje: `Benavides ValidarTicket HTTP ${r.status}` };
    }
    const validarData = parseResponse(r);
    if (!validarData) {
      return { success: false, mensaje: 'Benavides ValidarTicket: response.data.d vacío' };
    }
    sal1 = validarData.sal || validarData;
    console.log('[Benavides] ValidarTicket mensaje:', validarData.mensaje);
    console.log('[Benavides] ValidarTicket correo:', validarData.correo);
    console.log('[Benavides] sal.Tck_Id:', sal1.Tck_Id);
    console.log('[Benavides] sal.MensajeBlock:', sal1.MensajeBlock);

    if (validarData.mensaje === 'Error' || validarData.Mensaje === 'Error') {
      return {
        success: false,
        error: validarData.correo || validarData.Correo,
        mensaje: `Benavides ValidarTicket rechazado — ${validarData.correo || validarData.Correo || 'sin detalle'}`
      };
    }
    // Bug observado: CodErr=0, Mensaje="Validación exitosa", PERO Tck_Id=null
    // y MensajeBlock contiene el motivo del bloqueo del ticket.
    if (!sal1.Tck_Id || (sal1.MensajeBlock && String(sal1.MensajeBlock).trim().length > 0)) {
      const motivo = sal1.MensajeBlock || 'Benavides no permite facturar este ticket';
      console.log('[Benavides] Ticket no facturable — motivo:', motivo);
      return {
        success: false,
        error: 'TICKET_NO_FACTURABLE',
        mensaje: `Benavides: ${motivo}`,
        fallbackToManual: true
      };
    }
    tckId = sal1.Tck_Id;
  } catch (e) {
    reportApi(BASE_DP + '/ValidarTicket', validarPayload, e);
    return { success: false, mensaje: 'Benavides ValidarTicket excepción — ' + e.message };
  }

  // STEP 2: ObtieneDatosTicket
  let datosTicket;
  try {
    const r = await axios.post(BASE_DP + '/ObtieneDatosTicket', wrapJson({ ticketId: tckId }), postOpts());
    parseCookies(r.headers);
    console.log('[Benavides] ObtieneDatosTicket status:', r.status);
    if (r.status >= 400) {
      return { success: false, mensaje: `Benavides ObtieneDatosTicket HTTP ${r.status}` };
    }
    const datosData = parseResponse(r);
    if (!datosData) {
      return { success: false, mensaje: 'Benavides ObtieneDatosTicket: response.data.d vacío' };
    }
    if (datosData.mensaje === 'Error' || datosData.Mensaje === 'Error') {
      console.error('[Benavides] ObtieneDatosTicket correo:', datosData.correo || datosData.Correo);
      return { success: false, mensaje: `Benavides ObtieneDatosTicket rechazado — ${datosData.correo || datosData.Correo}` };
    }
    datosTicket = datosData.sal || datosData;
    console.log('[Benavides] datosTicket TipoDocumento:', datosTicket.TipoDocumento);
    console.log('[Benavides] datosTicket Subtotal:', datosTicket.Subtotal);
    console.log('[Benavides] datosTicket ImpTot:', datosTicket.ImpTot);
    console.log('[Benavides] datosTicket Total:', datosTicket.Total);
    console.log('[Benavides] datosTicket Items.length:', Array.isArray(datosTicket.Items) ? datosTicket.Items.length : 'no-array');
    console.log('[Benavides] datosTicket Tua:', datosTicket.Tua);
    console.log('[Benavides] datosTicket OtrosCargos:', datosTicket.OtrosCargos);
  } catch (e) {
    reportApi(BASE_DP + '/ObtieneDatosTicket', { ticketId: tckId }, e);
    return { success: false, mensaje: 'Benavides ObtieneDatosTicket excepción — ' + e.message };
  }

  // STEP 3: GetZipCodes — lookup por CP devuelve Estado/Municipio/Colonia/Localidad
  let zipData = {};
  try {
    const r = await axios.post(BASE_DP + '/GetZipCodes', wrapJson({ cp: perfil.cp }), postOpts());
    parseCookies(r.headers);
    console.log('[Benavides] GetZipCodes status:', r.status);
    if (r.status < 400) {
      const zd = parseResponse(r);
      if (zd) {
        zipData = zd.sal || zd;
        console.log('[Benavides] zipData Estado:', zipData.Estado);
        console.log('[Benavides] zipData Municipio:', zipData.Municipio);
        console.log('[Benavides] zipData Colonia:', zipData.Colonia);
        console.log('[Benavides] zipData Localidad:', zipData.Localidad);
      }
    }
  } catch (e) {
    // Best-effort: no abortamos; armamos jsonObject con lo que tengamos
    reportApi(BASE_DP + '/GetZipCodes', { cp: perfil.cp }, e);
    console.warn('[Benavides] GetZipCodes excepción (no crítico):', e.message);
  }

  // STEP 4: GeneraFacturaTicket — TIMBRADO REAL
  // FormaDePago: intentar inferir, fallback "01" con log explícito.
  let formaDePago = datosTicket.FormaPago
    || datosTicket.formaPago
    || datosTicket.FormaDePago
    || datosTicket.forma_pago;
  if (!formaDePago) {
    formaDePago = '01';
    console.warn('[Benavides] FormaDePago hardcoded a 01');
  } else {
    console.log('[Benavides] FormaDePago inferido del ticket:', formaDePago);
  }

  const jsonObject = {
    // Datos del cliente (perfil)
    RFC:       perfil.rfc,
    Nombre:    perfil.razon_social || perfil.nombre_sat || perfil.nombre || '',
    Calle:     perfil.calle || '',
    NoInt:     perfil.no_int || '',
    NoExt:     perfil.no_ext || '',
    Pais:      'MEX',  // HARDCODE — bug del portal lo resetea a AFG si no
    Estado:    zipData.Estado    || 'NLE',
    Municipio: zipData.Municipio || '',
    Colonia:   zipData.Colonia   || '',
    CodPost:   perfil.cp,
    Localidad: zipData.Localidad || '',
    EmailCFDI: perfil.email      || '',

    // Datos del ticket (de ObtieneDatosTicket — pasar verbatim)
    suc:                  tienda,
    TckNum:               String(folio),
    Id:                   tckId,
    TipoDocumento:        datosTicket.TipoDocumento,
    Subtotal:             datosTicket.Subtotal,
    Descuento:            datosTicket.Descuento || 0,
    ImpTot:               datosTicket.ImpTot,
    Total:                datosTicket.Total,
    Items:                datosTicket.Items,
    ImpuestosCalculados:  datosTicket.ImpuestosCalculados,
    Tua:                  datosTicket.Tua || 0,
    OtrosCargos:          datosTicket.OtrosCargos || 0,

    // CFDI 4.0 — solo código, NO "código-descripción"
    UsoCFDI:       soloCodigo(perfil.uso_cfdi)       || 'G03',
    RegimenFiscal: soloCodigo(perfil.regimen_fiscal || perfil.regimen) || '612',
    NumRegIdTrib:  '',

    // Constantes
    Propina:       false,
    selectItems:   false,
    Observaciones: '',
    MetodoPago:    'PUE',
    FormaDePago:   formaDePago,
    version:       '4.0'
  };

  try {
    const r = await axios.post(BASE_DP + '/GeneraFacturaTicket', wrapJson(jsonObject), postOpts());
    parseCookies(r.headers);
    console.log('[Benavides] GeneraFacturaTicket status:', r.status);
    if (r.status >= 400) {
      console.error('[Benavides] GeneraFacturaTicket HTTP error keys:', Object.keys(r.data || {}).join(','));
      return { success: false, mensaje: `Benavides GeneraFacturaTicket HTTP ${r.status}` };
    }
    const facturaData = parseResponse(r);
    if (!facturaData) {
      return { success: false, mensaje: 'Benavides GeneraFacturaTicket: response.data.d vacío' };
    }
    const sal2 = facturaData.sal || facturaData;
    console.log('[Benavides] facturaData.mensaje:', facturaData.mensaje);
    console.log('[Benavides] facturaData.correo:', facturaData.correo);
    console.log('[Benavides] sal.UUID:', sal2.UUID);
    console.log('[Benavides] sal.PdfUrl:', sal2.PdfUrl);
    console.log('[Benavides] sal.UrlPdf:', sal2.UrlPdf);
    console.log('[Benavides] sal.XmlUrl:', sal2.XmlUrl);
    console.log('[Benavides] sal.UrlXml:', sal2.UrlXml);

    if (facturaData.mensaje === 'Error' || facturaData.Mensaje === 'Error') {
      const detalle = facturaData.correo || facturaData.Correo || facturaData.html || '';
      return {
        success: false,
        error: detalle,
        mensaje: `Benavides GeneraFacturaTicket rechazado — ${detalle || 'sin detalle'}`
      };
    }

    const uuid = sal2.UUID || sal2.uuid || '';
    const pdfUrl = sal2.PdfUrl || sal2.UrlPdf || '';
    const xmlUrl = sal2.XmlUrl || sal2.UrlXml || '';
    return {
      success: true,
      uuid,
      pdf_url: pdfUrl,
      xml_url: xmlUrl,
      mensaje: `Factura Benavides generada${uuid ? ' UUID ' + uuid : ''}`
    };
  } catch (e) {
    reportApi(BASE_DP + '/GeneraFacturaTicket', jsonObject, e);
    return { success: false, mensaje: 'Benavides GeneraFacturaTicket excepción — ' + e.message };
  }
}

module.exports = { ejecutar };
