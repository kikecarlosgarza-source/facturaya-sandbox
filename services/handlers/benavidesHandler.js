// Handler HTTP-only para e-facturate.com/benavides/ (Farmacias Benavides).
//
// Flujo descubierto en el inline JS de la página (no API docs):
//   1. ValidarTicket   — input: {NumeroTicket, RFC, Total, ...} + Sucursal:0
//                        output: data.d.sal.Tck_Id (ticket id interno)
//   2. ObtieneDatosTicket — input: {ticketId}
//                           output: data.d.{Items, Subtotal, ImpTot, Tua, ...}
//   3. GeneraFacturaTicket — input: jsonObject completo (datos cliente +
//                            ticket data + defaults). SUBMIT real.
//
// Wrapper de body para 1 y 3:  {json: encodeURIComponent(JSON.stringify(jsonObject))}
// Wrapper de body para 2:      {ticketId: "..."} (JSON estricto, ASP.NET acepta)
// Discriminador de error:      data.d.mensaje === "Error" → data.d.correo es el msg

const axios = require('axios');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://e-facturate.com';
const PATH = '/benavides';

// Catálogo SAT abreviado para concatenar "código-descripción" como espera
// Benavides en RegimenFiscal y UsoCFDI (el bundle hace .split('-')[0] pero
// otras validaciones del server probablemente esperan formato completo).
const REGIMEN_FISCAL = {
  '601': 'General de Ley Personas Morales',
  '603': 'Personas Morales con Fines no Lucrativos',
  '605': 'Sueldos y Salarios e Ingresos Asimilados a Salarios',
  '606': 'Arrendamiento',
  '607': 'Régimen de Enajenación o Adquisición de Bienes',
  '608': 'Demás ingresos',
  '610': 'Residentes en el Extranjero sin Establecimiento Permanente en México',
  '611': 'Ingresos por Dividendos (socios y accionistas)',
  '612': 'Personas Físicas con Actividades Empresariales y Profesionales',
  '614': 'Ingresos por intereses',
  '615': 'Régimen de los ingresos por obtención de premios',
  '616': 'Sin obligaciones fiscales',
  '620': 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos',
  '621': 'Incorporación Fiscal',
  '622': 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras',
  '623': 'Opcional para Grupos de Sociedades',
  '624': 'Coordinados',
  '625': 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas',
  '626': 'Régimen Simplificado de Confianza',
  '628': 'Hidrocarburos'
};

const USO_CFDI = {
  'G01':  'Adquisición de mercancías',
  'G02':  'Devoluciones, descuentos o bonificaciones',
  'G03':  'Gastos en general',
  'I01':  'Construcciones',
  'I02':  'Mobiliario y equipo de oficina por inversiones',
  'I03':  'Equipo de transporte',
  'I04':  'Equipo de cómputo y accesorios',
  'I05':  'Dados, troqueles, moldes, matrices y herramental',
  'I06':  'Comunicaciones telefónicas',
  'I07':  'Comunicaciones satelitales',
  'I08':  'Otra maquinaria y equipo',
  'D01':  'Honorarios médicos, dentales y gastos hospitalarios',
  'D02':  'Gastos médicos por incapacidad o discapacidad',
  'D03':  'Gastos funerales',
  'D04':  'Donativos',
  'D05':  'Intereses reales efectivamente pagados por créditos hipotecarios (casa habitación)',
  'D06':  'Aportaciones voluntarias al SAR',
  'D07':  'Primas por seguros de gastos médicos',
  'D08':  'Gastos de transportación escolar obligatoria',
  'D09':  'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones',
  'D10':  'Pagos por servicios educativos (colegiaturas)',
  'P01':  'Por definir',
  'S01':  'Sin efectos fiscales',
  'CP01': 'Pagos',
  'CN01': 'Nómina'
};

// Si ya viene en formato "612-...", déjalo. Si es solo código, concatena.
function toCodigoGuionDesc(value, catalog) {
  if (!value) return '';
  const v = String(value).trim();
  if (v.includes('-')) return v;
  const desc = catalog[v];
  return desc ? `${v}-${desc}` : v;
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

// Body wrapper exacto que usa el bundle de Benavides para
// ValidarTicket y GeneraFacturaTicket.
function wrapJson(jsonObject) {
  return { json: encodeURIComponent(JSON.stringify(jsonObject)) };
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('benavides');

  const folio = ticketData.folio || ticketData.numero_ticket || '';
  const total = ticketData.total;
  if (!folio) return { success: false, mensaje: 'Benavides: folio (txt_ticket) requerido' };
  if (total == null) return { success: false, mensaje: 'Benavides: total requerido' };

  // Cookie jar manual para mantener sesión ASP.NET (.AspNet.ApplicationCookie etc.)
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

  // 0. GET / para sembrar cookies + llamadas init (best-effort, no bloquean)
  try {
    const r = await axios.get(BASE + PATH + '/', opts());
    parseCookies(r.headers);
    console.log(`[Benavides] init GET / status=${r.status} cookies=${Object.keys(jar).join(',')}`);
  } catch (e) {
    reportApi(BASE + PATH + '/', null, e);
    return { success: false, mensaje: 'Benavides: GET inicial falló — ' + e.message };
  }
  for (const m of ['PoliticasCliente', 'CustomLabelsCliente', 'GetPaymentMethods', 'GetCountries']) {
    try {
      const r = await axios.post(BASE + PATH + '/DataProcessor.aspx/' + m, {}, opts());
      parseCookies(r.headers);
    } catch {}
  }

  // ── 1. ValidarTicket ─────────────────────────────────────────────────
  // Body shape extraído de inline JS. Sucursal=0 porque Benavides no
  // muestra select de sucursal (campos del form: ticket+total+RFC).
  const validarBody = {
    Fecha: '',
    IdentificadorGlobal: '',
    Moneda: '',
    Noreferencia: '',
    NumeroTicket: String(folio),
    RFC: perfil.rfc,
    Sucursal: 0,
    SucursalName: '',
    Tipo: 2,
    TipoCambio: '',
    Total: String(total)
  };

  let tckId = null;
  try {
    const url = BASE + PATH + '/DataProcessor.aspx/ValidarTicket';
    const r = await axios.post(url, wrapJson(validarBody), opts());
    parseCookies(r.headers);
    console.log(`[Benavides] ValidarTicket status=${r.status}`);
    if (r.status >= 400) {
      return { success: false, mensaje: `Benavides ValidarTicket HTTP ${r.status} — ${JSON.stringify(r.data).substring(0, 200)}` };
    }
    const d = r.data?.d;
    if (!d) {
      return { success: false, mensaje: 'Benavides ValidarTicket: response sin .d' };
    }
    if (d.mensaje === 'Error') {
      console.error('[Benavides] ValidarTicket rechazado:', JSON.stringify(d));
      return { success: false, mensaje: `Benavides ValidarTicket rechazado — ${d.correo || JSON.stringify(d).substring(0, 200)}` };
    }
    tckId = d.sal?.Tck_Id;
    if (!tckId) {
      console.error('[Benavides] ValidarTicket sin Tck_Id:', JSON.stringify(d).substring(0, 400));
      return { success: false, mensaje: 'Benavides ValidarTicket: sin Tck_Id en response (revisar shape)' };
    }
    console.log(`[Benavides] ValidarTicket OK Tck_Id=${tckId}`);
  } catch (e) {
    reportApi(BASE + PATH + '/DataProcessor.aspx/ValidarTicket', validarBody, e);
    return { success: false, mensaje: 'Benavides ValidarTicket excepción — ' + e.message };
  }

  // ── 2. ObtieneDatosTicket ────────────────────────────────────────────
  // Body en JSON estricto (ASP.NET deserializer permisivo acepta), no el
  // string con single quotes que usa el bundle.
  let ticketDetalle;
  try {
    const url = BASE + PATH + '/DataProcessor.aspx/ObtieneDatosTicket';
    const r = await axios.post(url, { ticketId: String(tckId) }, opts());
    parseCookies(r.headers);
    console.log(`[Benavides] ObtieneDatosTicket status=${r.status}`);
    if (r.status >= 400) {
      return { success: false, mensaje: `Benavides ObtieneDatosTicket HTTP ${r.status} — ${JSON.stringify(r.data).substring(0, 200)}` };
    }
    const d = r.data?.d;
    if (!d) {
      return { success: false, mensaje: 'Benavides ObtieneDatosTicket: response sin .d' };
    }
    if (d.mensaje === 'Error') {
      console.error('[Benavides] ObtieneDatosTicket rechazado:', JSON.stringify(d));
      return { success: false, mensaje: `Benavides ObtieneDatosTicket rechazado — ${d.correo || JSON.stringify(d).substring(0, 200)}` };
    }
    ticketDetalle = d;
    console.log(`[Benavides] ObtieneDatosTicket OK keys=${Object.keys(d).join(',')}`);
  } catch (e) {
    reportApi(BASE + PATH + '/DataProcessor.aspx/ObtieneDatosTicket', { ticketId: String(tckId) }, e);
    return { success: false, mensaje: 'Benavides ObtieneDatosTicket excepción — ' + e.message };
  }

  // ── 3. GeneraFacturaTicket ──────────────────────────────────────────
  // FormaDePago: intentar inferir del ticketDetalle. Bundle no muestra
  // qué key usa la response, así que probamos variantes comunes.
  let formaDePago = ticketDetalle.FormaPago
    || ticketDetalle.formaPago
    || ticketDetalle.forma_pago
    || ticketDetalle.FormaDePago
    || (ticketDetalle.sal && (ticketDetalle.sal.FormaPago || ticketDetalle.sal.formaPago));
  if (!formaDePago) {
    formaDePago = '01';
    console.warn('[Benavides] FormaDePago hardcoded a 01 - revisar si ticket fue tarjeta');
  } else {
    console.log(`[Benavides] FormaDePago inferido del ticket: ${formaDePago}`);
  }

  const facturaBody = {
    // Cliente / fiscal — del perfil
    RFC: perfil.rfc,
    Nombre: perfil.nombre_sat || perfil.nombre || '',
    CodPost: perfil.cp || '',
    EmailCFDI: perfil.email || '',
    RegimenFiscal: toCodigoGuionDesc(perfil.regimen, REGIMEN_FISCAL),
    UsoCFDI:       toCodigoGuionDesc(perfil.uso_cfdi, USO_CFDI),
    NumRegIdTrib: '',

    // Dirección — primer intento todo vacío. Si Benavides los infiere del CP
    // perfecto; si no, el catch detectará el error y reintenta con GetZipCodes.
    Calle: '',
    NoExt: '',
    NoInt: '',
    Colonia: '',
    Localidad: '',
    Municipio: '',
    Estado: '',
    Pais: 'MEX',

    // Ticket — tomar del ObtieneDatosTicket response (keys comunes ASP.NET)
    TckNum:               String(folio),
    Total:                ticketDetalle.Total                ?? Number(total),
    Subtotal:             ticketDetalle.Subtotal             ?? 0,
    Descuento:            ticketDetalle.Descuento            ?? 0,
    ImpTot:               ticketDetalle.ImpTot               ?? 0,
    Tua:                  ticketDetalle.Tua                  ?? 0,
    OtrosCargos:          ticketDetalle.OtrosCargos          ?? 0,
    Items:                ticketDetalle.Items                ?? '',
    ImpuestosCalculados:  ticketDetalle.ImpuestosCalculados  ?? '',
    IdentificadorGlobal:  ticketDetalle.IdentificadorGlobal  ?? '',

    // Defaults / constantes del bundle
    TipoDocumento: '01',
    MetodoPago:    'PUE',
    FormaDePago:   formaDePago,
    Propina:       'false',
    selectItems:   'false',
    Observaciones: ''
  };

  let result = await postFactura(facturaBody, opts, reportApi);
  if (result.success) return result;

  // Fallback dirección: si el error menciona dirección/CP/colonia/calle,
  // intentar enriquecer con GetZipCodes y reintentar UNA vez.
  if (esErrorDireccion(result.errorMsg) && perfil.cp) {
    console.warn(`[Benavides] error parece de dirección, reintentando con GetZipCodes(filter=${perfil.cp})`);
    const zips = await fetchZipCodes(perfil.cp, opts, reportApi);
    if (zips && zips.length) {
      // GetInformationCatalog devuelve array de Key strings. Sin documentación
      // del shape exacto, asumimos primer item es la colonia/CP correspondiente.
      // Best-effort: rellenamos Colonia con el primer zip; resto vacío.
      facturaBody.Colonia = String(zips[0]);
      console.log(`[Benavides] retry con Colonia="${facturaBody.Colonia}" (de GetZipCodes[0])`);
      result = await postFactura(facturaBody, opts, reportApi);
      if (result.success) return result;
    } else {
      console.warn('[Benavides] GetZipCodes vacío o falló — sin más fallback');
    }
  }
  return result;
}

async function postFactura(facturaBody, opts, reportApi) {
  const url = BASE + PATH + '/DataProcessor.aspx/GeneraFacturaTicket';
  try {
    const r = await axios.post(url, wrapJson(facturaBody), opts());
    console.log(`[Benavides] GeneraFacturaTicket status=${r.status}`);
    if (r.status >= 400) {
      const errBody = JSON.stringify(r.data).substring(0, 300);
      console.error(`[Benavides] GeneraFacturaTicket HTTP ${r.status} body=${errBody}`);
      return { success: false, errorMsg: errBody, mensaje: `Benavides GeneraFacturaTicket HTTP ${r.status} — ${errBody}` };
    }
    const d = r.data?.d;
    if (!d) {
      return { success: false, errorMsg: 'sin .d', mensaje: 'Benavides GeneraFacturaTicket: response sin .d' };
    }
    if (d.mensaje === 'Error') {
      // Loggear objeto completo para feedback accionable
      console.error('[Benavides] GeneraFacturaTicket RECHAZADO:', JSON.stringify(d));
      const detalle = d.correo || d.html || JSON.stringify(d).substring(0, 300);
      return { success: false, errorMsg: detalle, mensaje: `Benavides GeneraFacturaTicket rechazado — ${detalle}` };
    }
    // Éxito: response trae sus_id, total, fecha, rfc, mensaje, etc.
    const cfdi = d.sus_id || d.uuid || d.id || '';
    return { success: true, mensaje: `Factura Benavides generada — ${cfdi || 'CFDI sin uuid en response'} (${d.mensaje || 'OK'})` };
  } catch (e) {
    reportApi(url, facturaBody, e);
    return { success: false, errorMsg: e.message, mensaje: 'Benavides GeneraFacturaTicket excepción — ' + e.message };
  }
}

function esErrorDireccion(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  return /direcci[óo]n|calle|colonia|c[óo]digo postal|cp |c\.p\.|municipio|localidad|estado/.test(m);
}

async function fetchZipCodes(cp, opts, reportApi) {
  const url = BASE + PATH + '/DataProcessor.aspx/GetZipCodes';
  try {
    // El bundle pasa el estado como filter; probamos con CP por si el WebMethod
    // lo acepta. Si no devuelve nada, retornamos array vacío.
    const r = await axios.post(url, { filter: String(cp) }, opts());
    if (r.status >= 400) {
      console.warn(`[Benavides] GetZipCodes HTTP ${r.status}`);
      return [];
    }
    const d = r.data?.d;
    if (!Array.isArray(d)) return [];
    return d.map(item => item?.Key || item?.Value || item).filter(Boolean);
  } catch (e) {
    reportApi(url, { filter: String(cp) }, e);
    return [];
  }
}

module.exports = { ejecutar };
