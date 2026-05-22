// E2E Walmart handler — CAMINO REAL. Corre contra el portal real
// (facturacion.walmartmexico.com.mx) y EMITE UNA FACTURA REAL si pasa
// los 5 pasos ASPX. Primera prueba viva del walmartHandler.
//
// Ticket #3 Walmart Valle Oriente NL — 07/may/2026, total $14.00 (último virgen).
// TC# "70977371901625659765" (20 dígitos, sin espacios).
// TR# 07892.
// Receptor: perfil fiscal de Enrique (GAME860412CY6 / CP 66230 /
// régimen 612 / uso G03).
//
// Ejecutar: npm run e2e:walmart
// Exit: 0 = PASS (timbrado exitoso), 1 = FAIL

const walmartHandler = require('../services/handlers/walmartHandler');

const ticketData = {
  numero_ticket: '70977371901625659765',  // TC# sin espacios, 20 dígitos
  numero_transaccion: '07892',            // TR#
  total: 14.00,
  fecha: '2026-05-07',
  establecimiento: 'WALMART VALLE ORIENTE NL',
  rfc_emisor: 'NWM9709244W4'              // NUEVA WAL MART DE MEXICO S DE RL DE CV
  // forma_pago: omitido a propósito → handler default '04' (crédito).
};

const perfil = {
  rfc: 'GAME860412CY6',
  nombre: 'ENRIQUE CARLOS GARZA MONTEMAYOR',
  email: 'kikecarlosgarza@gmail.com',
  cp: '66230',
  regimen: '612',
  uso_cfdi: 'G03'
};

// Capturar console.log para reconstruir la traza de pasos del handler.
const logged = [];
const origLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); origLog(...a); };
const has = (s) => logged.some(l => l.includes(s));

(async () => {
  console.log('────── E2E WALMART REAL ──────');
  console.log('Portal: https://facturacion.walmartmexico.com.mx/');
  console.log(`Ticket: TC=${ticketData.numero_ticket} (${ticketData.numero_ticket.length} dígitos) TR=${ticketData.numero_transaccion} total=$${ticketData.total}`);
  console.log(`Perfil: ${perfil.rfc} / CP ${perfil.cp} / régimen ${perfil.regimen} / uso ${perfil.uso_cfdi}`);
  console.log('--------------------------------');

  let result;
  const t0 = Date.now();
  try {
    result = await walmartHandler.ejecutar(perfil, ticketData, 'e2e-walmart-real-001');
  } catch (e) {
    console.log = origLog;
    console.error('\n[E2E] EXCEPCIÓN no controlada:', e.stack || e.message);
    process.exit(1);
  }
  console.log = origLog;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n────── TRAZA DE PASOS DEL HANDLER ──────');
  for (const line of logged) {
    if (/\[AUTO\] Walmart/.test(line)) console.log('  ' + line);
  }

  const reached = {
    'PASO 1 (Default.aspx — disclaimer + obtener factura)': has('Walmart - step 1: navegando'),
    'PASO 2 (frmDatos.aspx — RFC/CP/TC/TR)':                has('Walmart - step 2: llenando datos'),
    'PASO 3 (frmRFCEdita.aspx — razón social/régimen/uso)': has('Walmart - step 3: llenando datos fiscales'),
    'PASO 3b (modal ¿están correctos?)':                    has('Walmart - step 3b: confirmando modal'),
    'PASO 4 (frmPaymentType.aspx — forma de pago)':         has('Walmart - step 4: forma de pago'),
    'PASO 5 (frmReportAdmin.aspx — timbrado)':              has('Walmart - step 5: timbrado final')
  };

  console.log('\n────── PASOS ALCANZADOS ──────');
  for (const [name, ok] of Object.entries(reached)) {
    console.log(`  ${ok ? 'YES' : ' no'}  ${name}`);
  }

  const okSuccess = !!(result && result.success === true);
  const uuid = result && result.uuid;
  const uuidValido = !!uuid && uuid !== '00000000-0000-0000-0000-000000000000';

  console.log('\n────── RESULTADO COMPLETO ──────');
  console.log('Duración:', elapsed, 's');
  console.log('Retorno del handler:');
  console.log(JSON.stringify(result, null, 2));

  console.log('\n────── VEREDICTO ──────');
  if (okSuccess) {
    console.log('TIMBRADO EXITOSO ✅');
    if (uuidValido) console.log('UUID:', uuid);
    if (result.folio) console.log('Folio:', result.folio);
    if (result.emailEnviado) console.log(`Email enviado a: ${perfil.email}`);
    process.exit(0);
  } else {
    console.log('TIMBRADO NO EXITOSO ❌');
    console.log('mensaje:', result && result.mensaje);
    if (result && result.facturaData) {
      console.log('URL final:', result.facturaData.url);
      console.log('Preview body:', result.facturaData.preview);
    }
    process.exit(1);
  }
})();
