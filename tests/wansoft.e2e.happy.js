// E2E Wansoft handler — CAMINO FELIZ. Corre contra el portal real
// (www.wansoft.net) y EMITE UNA FACTURA REAL (CFDI timbrado).
//
// Ticket TODO EMPANADAS SAN AGUSTÍN — sid 9912, RFC emisor TIE2204058E0,
// code 260510023149019602, total $560.00, facturable (Invoiced:false).
// Receptor: perfil fiscal de Enrique (GAME860412CY6).
//
// Primera prueba real de desambiguación por dirección: TODO EMPANADAS
// tiene 33 sucursales bajo el mismo RFC (ver SID_CATALOG / pendiente E).
//
// Contrato verificado = el REAL del handler (decisión de diseño previa):
//   { success: true, mensaje: 'Factura emitida', uuid, pdf_url, xml_url }
//   (NO { factura: {...} } — eso era wording del brief, no el contrato).
//
// Ejecutar: npm run e2e:wansoft:happy
// Exit: 0 = PASS, 1 = FAIL

const wansoftHandler = require('../services/handlers/wansoftHandler');

const ticketData = {
  numero_ticket: '260510023149019602',
  establecimiento: 'TODO EMPANADAS SAN AGUSTIN',
  rfc_emisor: 'TIE2204058E0',       // RFC real del emisor (lo trae el OCR/QR)
  total: '560.00'
};

const perfil = {
  rfc: 'GAME860412CY6',
  razon_social: 'ENRIQUE CARLOS GARZA MONTEMAYOR',
  email: 'kikecarlosgarza@gmail.com',
  cp: '66230',
  regimen_fiscal: '612',
  uso_cfdi: 'G03'
};

const logged = [];
const origLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); origLog(...a); };
const has = (s) => logged.some(l => l.includes(s));

(async () => {
  let result;
  try {
    result = await wansoftHandler.ejecutar(perfil, ticketData, 'e2e-wansoft-happy');
  } catch (e) {
    console.log = origLog;
    console.error('\n[E2E] EXCEPCIÓN no controlada:', e.stack || e.message);
    process.exit(1);
  }
  console.log = origLog;

  const uuid = result && result.uuid;
  const uuidValido = !!uuid && uuid !== '00000000-0000-0000-0000-000000000000';

  // El ticket TODO EMPANADAS YA fue facturado en el timbrado real previo
  // (UUID 49bf64c4-...). A partir de ahora Wansoft lo reporta como ya
  // facturado en PASO 2. Por eso este test acepta DOS resultados como PASS:
  //   (a) success:true + UUID válido          → timbrado nuevo (1ra vez)
  //   (b) success:false + 'Ticket ya facturado previamente'
  //       → flujo robusto PASO1+PASO2, corto-circuito correcto (ESPERADO hoy)
  const okSuccess = !!(result && result.success === true && uuidValido &&
    result.mensaje === 'Factura emitida' && result.pdf_url && result.xml_url);
  const okAlreadyInvoiced = !!(result && result.success === false &&
    result.mensaje === 'Ticket ya facturado previamente' &&
    has('[Wansoft] PASO2 GetBillingInformation') &&
    !has('[Wansoft] PASO4 IssueDocument40'));

  const modo = okSuccess ? 'TIMBRADO NUEVO'
             : okAlreadyInvoiced ? 'YA FACTURADO (esperado — ticket consumido en run previo)'
             : 'INDETERMINADO';

  const checks = [
    ['PASO 1 cookies+token (3 hops 302)',
      has('[Wansoft] PASO1 hop=2') && has('[Wansoft] PASO1 referer=') && !has('token=NO ENCONTRADO')],
    ['resolveSid por RFC resolvió sid (no "no reconocida")',
      !(result && result.mensaje === 'Sucursal Wansoft no reconocida en catálogo')],
    ['PASO 2 ejecutado',
      has('[Wansoft] PASO2 GetBillingInformation')],
    ['Resultado aceptable (timbrado nuevo OR ya facturado)',
      okSuccess || okAlreadyInvoiced]
  ];

  console.log('\n──────── E2E WANSOFT HAPPY PATH (TODO EMPANADAS) ────────');
  console.log('Modo detectado:', modo);
  console.log('Retorno del handler:', JSON.stringify(result));
  console.log('---------------------------------------------------------');
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log('---------------------------------------------------------');
  console.log(allPass ? 'E2E HAPPY PASS ✅' : 'E2E HAPPY FAIL ❌');
  process.exit(allPass ? 0 : 1);
})();
