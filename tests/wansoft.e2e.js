// E2E Wansoft handler — corre contra el portal real (www.wansoft.net).
// Valida el camino "ticket ya facturado" usando ticket Doña Concha #158074
// (UUID 64a2c095-..., code 260510158074016848, sid 5676).
//
// Camino feliz (timbrado nuevo) pendiente: requiere ticket Wansoft sin
// facturar (ver project_wansoft_handler_pendings.md punto A).
//
// Ejecutar: npm run e2e:wansoft

/**
 * E2E Wansoft — Reino C (sandbox). Golpea el portal REAL www.wansoft.net.
 *
 * Caso: ticket Doña Concha YA FACTURADO (UUID 64a2c095-..., código
 * 260510158074016848, sid 5676). Contrato esperado:
 *   - PASO 1 y 2 se ejecutan (cookies + token, GetBillingInformation)
 *   - PASO 2 responde { Message: "Su ticket ya se encuentra facturado.",
 *     MessageType: 2 } SIN billingCodeInfo
 *   - retorno: { success: false, mensaje: 'Ticket ya facturado previamente' }
 *   - NO se alcanza PASO 3 ni PASO 4
 *
 * Uso:  npm run e2e:wansoft   (= DB_DIR=/tmp/reino-c-e2e node tests/wansoft.e2e.js)
 * Exit: 0 = PASS, 1 = FAIL
 */

const wansoftHandler = require('../services/handlers/wansoftHandler');

const ticketData = {
  numero_ticket: '260510158074016848',
  establecimiento: 'DOÑA CONCHA PLAZA MONARKA', // lo que trae el OCR de un ticket real
  rfc_emisor: 'ADC2404103S2',       // RFC real del emisor (lo trae el OCR/QR)
  total: '75.00'
};

// perfil dummy: solo se usaría en PASO 4, que NO debe alcanzarse.
const perfil = {
  rfc: 'XAXX010101000',
  razon_social: 'PUBLICO EN GENERAL',
  email: 'noreply@example.com',
  cp: '66220',
  regimen: '616',
  uso_cfdi: 'S01'
};

// Capturar console.log para verificar qué pasos se ejecutaron.
const logged = [];
const origLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); origLog(...a); };

function reached(paso) {
  return logged.some(l => l.includes(`[Wansoft] ${paso}`));
}

(async () => {
  let result;
  try {
    result = await wansoftHandler.ejecutar(perfil, ticketData, 'e2e-wansoft-already-invoiced');
  } catch (e) {
    console.log = origLog;
    console.error('\n[E2E] EXCEPCIÓN no controlada:', e.stack || e.message);
    process.exit(1);
  }
  console.log = origLog;

  const checks = [
    ['PASO 1 ejecutado',            reached('PASO1')],
    ['PASO 2 ejecutado',            reached('PASO2 GetBillingInformation')],
    ['PASO 3 NO ejecutado',         !reached('PASO3')],
    ['PASO 4 NO ejecutado',         !reached('PASO4')],
    ['success === false',           result && result.success === false],
    ["mensaje === 'Ticket ya facturado previamente'",
                                    result && result.mensaje === 'Ticket ya facturado previamente']
  ];

  console.log('\n──────── RESULTADO E2E WANSOFT (ticket ya facturado) ────────');
  console.log('Retorno del handler:', JSON.stringify(result));
  console.log('-------------------------------------------------------------');
  let allPass = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) allPass = false;
  }
  console.log('-------------------------------------------------------------');
  console.log(allPass ? 'E2E PASS ✅' : 'E2E FAIL ❌');
  process.exit(allPass ? 0 : 1);
})();
