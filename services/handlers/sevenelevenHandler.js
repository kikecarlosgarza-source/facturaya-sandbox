// Handler para 7-Eleven México (e7-eleven.com.mx).
// Stack: Konesh KPortalExterno protegido por DataDome (Pattern C).
//
// Pattern C — Browser stealth + network interception:
//   1. launchStealthBrowser (playwright-extra + stealth, JA3 consistente con Chrome)
//   2. page.goto SPA → DataDome ejecuta su challenge JS, setea cookie datadome
//   3. Detección de bloqueo DataDome post-goto
//   4. Interceptor de network captura verificaTicketWS2 (formaPago) y
//      FacturaExpressService (UUID) — más robusto que DOM-scraping
//   5. Form fill estilo Angular (page.fill / selectOption)
//   6. Kaptcha resuelto via screenshot del <img id="Kaptcha"> + CapSolver
//   7. Click "FACTURAR" dispara window.confirm (auto-aceptado por dialog handler)
//   8. UUID extraído del response interceptado, no del DOM

const axios = require('axios');
const { launchStealthBrowser, closeBrowser } = require('../koneshBrowser');
const claudeAgent = require('../claudeAgent');

const BASE = 'https://www.e7-eleven.com.mx';

const SELECTORS = {
  noTicket: 'input[name="noTicket"]',
  agregarTicketBtn: 'button[ng-click="addRow()"]',
  rfcCliente: '#rfcCliente',
  razon: '#razon',
  regimenFiscal: '#regimenFiscalReceptor',
  formaPago: '#formaPagoAux',
  usoCfdi: '#usoCfdi',
  calle: '#calle',
  noExterior: '#noExterior',
  noInterior: '#noInterior',
  ciudad: '#ciudad',
  colonia: '#colonia',
  delegacion: '#delegacion',
  cp: '#cp',
  pais: '#pais',
  emailInput: '#emailInput',
  kaptchaImg: '#Kaptcha',
  captcha: '#captcha'
};

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

// CapSolver ImageToText con loop de módulos (clonado del handler axios anterior)
async function resolverKaptchaConCapSolver(captchaB64) {
  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) throw new Error('CAPSOLVER_API_KEY no configurada');

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
      console.log(`[AUTO] 7-Eleven - CapSolver createTask(module=${mod}) EXCEPCIÓN: ${e.message}`);
    }
  }
  if (!createData) throw new Error('CapSolver createTask falló - ' + createErr);

  if (createData.status === 'ready' || createData.solution?.text) {
    const text = createData.solution?.text || '';
    if (!text) throw new Error('CapSolver status=ready sin texto');
    console.log(`[AUTO] 7-Eleven - captcha resuelto sincrónicamente (module=${createData._module}): "${text}"`);
    return text;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capKey, taskId: createData.taskId }, { timeout: 15000, validateStatus: () => true });
    console.log(`[AUTO] 7-Eleven - CapSolver getTaskResult[${i}] status=${res.data.status} errorId=${res.data.errorId || 0}`);
    if (res.data.status === 'ready') {
      const text = res.data.solution?.text || '';
      if (!text) throw new Error('CapSolver ready sin texto en polling');
      console.log(`[AUTO] 7-Eleven - captcha resuelto via polling (module=${createData._module}): "${text}"`);
      return text;
    }
    if (res.data.errorId) {
      throw new Error(`CapSolver error - ${res.data.errorCode}: ${res.data.errorDescription}`);
    }
  }
  throw new Error('CapSolver timeout sin solución');
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('seveneleven');

  let noTicket = String(ticketData?.numero_ticket || ticketData?.folio || '');
  // Code128-C padea con "0" inicial cuando el ticket-id tiene longitud impar (35).
  // zbar/native scanner decodifican el padded value (36) literal, pero el portal valida
  // contra el texto impreso (35). Confirmado empíricamente con ticket 7-Eleven 2026-05-07.
  if (noTicket.length === 36 && noTicket.startsWith('0')) {
    console.log(`[AUTO] 7-Eleven - removiendo padding Code128-C: ${noTicket} → ${noTicket.substring(1)}`);
    noTicket = noTicket.substring(1);
  }
  if (!noTicket) return { success: false, mensaje: '7-Eleven: numero_ticket (barcode 35 chars) requerido' };
  if (!perfil?.rfc) return { success: false, mensaje: '7-Eleven: RFC del perfil requerido' };

  console.log(`[AUTO] 7-Eleven - step 0: inicio noTicket=${noTicket} (len=${noTicket.length}) rfc=${perfil.rfc}`);

  let browser;
  try {
    const launched = await launchStealthBrowser();
    browser = launched.browser;
    const { context, page } = launched;
    context.setDefaultTimeout(30000);
    context.setDefaultNavigationTimeout(60000);

    // Auto-aceptar window.confirm que dispara el botón "FACTURAR"
    page.on('dialog', async d => {
      console.log(`[AUTO] 7-Eleven - dialog interceptado: type=${d.type()} message="${d.message()}"`);
      try { await d.accept(); } catch (e) { console.warn('[AUTO] 7-Eleven - dialog.accept() falló:', e.message); }
    });

    // Interceptor de network — Promises que resuelven cuando los responses esperados llegan
    let resolveVerifica;
    const verificaP = new Promise(resolve => { resolveVerifica = resolve; });
    let resolveExpress;
    const expressP = new Promise(resolve => { resolveExpress = resolve; });

    page.on('response', async (resp) => {
      const url = resp.url();
      try {
        if (url.includes('/verificaTicketWS2') && resp.request().method() === 'GET') {
          let body = null;
          try { body = await resp.json(); } catch { body = null; }
          console.log(`[AUTO] 7-Eleven - intercepted verificaTicketWS2 status=${resp.status()} body=${JSON.stringify(body).substring(0,400)}`);
          resolveVerifica({ status: resp.status(), body });
        } else if (resp.request().method() === 'POST' && url.includes('/FacturaExpressService')) {
          let body = null;
          try { body = await resp.json(); } catch {
            try { body = await resp.text(); } catch { body = null; }
          }
          const bodyStr = typeof body === 'object' ? JSON.stringify(body) : String(body ?? '');
          console.log(`[AUTO] 7-Eleven - intercepted FacturaExpressService status=${resp.status()}`);
          for (let i = 0; i < bodyStr.length && i < 4500; i += 1500) {
            console.log(`[AUTO] 7-Eleven - FacturaExpress body[${i}-${Math.min(i+1500, bodyStr.length)}]: ${bodyStr.substring(i, i+1500)}`);
          }
          resolveExpress({ status: resp.status(), body });
        }
      } catch (e) {
        console.warn('[AUTO] 7-Eleven - response listener error:', e.message);
      }
    });

    // Step 1: navegar al SPA — DataDome ejecuta su challenge JS aquí
    console.log('[AUTO] 7-Eleven - step 1: page.goto SPA');
    await page.goto(BASE + '/facturacion/KPortalExterno/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Step 2: detectar bloqueo DataDome
    const currentUrl = page.url();
    const title = await page.title().catch(() => '');
    console.log(`[AUTO] 7-Eleven - step 2: post-goto url="${currentUrl}" title="${title}"`);
    if (/datadome|captcha-delivery|access\s*denied/i.test(currentUrl) || /blocked|access\s*denied|datadome/i.test(title)) {
      return { success: false, mensaje: `7-Eleven: DataDome bloqueó la sesión (url="${currentUrl}", title="${title}")` };
    }

    // Step 3: esperar que Angular renderice el link "FACTURA EXPRESS"
    console.log('[AUTO] 7-Eleven - step 3: esperando link "FACTURA EXPRESS"');
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('a')).some(a => /FACTURA\s*EXPRESS/i.test(a.textContent || ''))
    , null, { timeout: 15000 });

    // Step 4: click "FACTURA EXPRESS" via evaluate (más robusto que has-text)
    console.log('[AUTO] 7-Eleven - step 4: click "FACTURA EXPRESS"');
    await page.evaluate(() => {
      const link = Array.from(document.querySelectorAll('a')).find(a => /FACTURA\s*EXPRESS/i.test(a.textContent || ''));
      if (link) link.click();
    });

    // Step 5: esperar que aparezca el form de ticket
    console.log('[AUTO] 7-Eleven - step 5: esperando form de ticket');
    await page.waitForSelector(SELECTORS.noTicket, { timeout: 15000 });

    // Step 6: llenar noTicket y disparar verificaTicketWS2
    console.log(`[AUTO] 7-Eleven - step 6: fill noTicket=${noTicket} y click "Agregar Ticket"`);
    await page.fill(SELECTORS.noTicket, noTicket);
    await page.click(SELECTORS.agregarTicketBtn);

    // Esperar response interceptado de verificaTicketWS2
    const verificaResp = await Promise.race([
      verificaP,
      new Promise((_, reject) => setTimeout(() => reject(new Error('verificaTicketWS2 timeout 30s')), 30000))
    ]).catch(e => ({ error: e.message }));

    if (verificaResp?.error) {
      return { success: false, mensaje: '7-Eleven: ' + verificaResp.error };
    }
    if (!verificaResp?.body || (verificaResp.body.status !== '0' && verificaResp.body.status !== 0)) {
      const msg = verificaResp?.body?.mensajeValidacion || verificaResp?.body?.respuesta || 'sin detalle';
      return { success: false, mensaje: `7-Eleven: ticket rechazado por verificaTicketWS2 — ${msg} (noTicket=${noTicket})` };
    }
    const capturedFormaPago = String(verificaResp.body.formaPago || '');
    if (!capturedFormaPago) {
      return { success: false, mensaje: '7-Eleven: verificaTicketWS2 OK pero formaPago vacío' };
    }
    console.log(`[AUTO] 7-Eleven - step 6b: formaPago capturado="${capturedFormaPago}"`);

    // Step 7: esperar form de receptor
    console.log('[AUTO] 7-Eleven - step 7: esperando form de receptor (#rfcCliente)');
    await page.waitForSelector(SELECTORS.rfcCliente, { timeout: 15000 });

    // Step 8: llenar campos de receptor
    console.log('[AUTO] 7-Eleven - step 8: fill receptor');
    const razon = String(perfil.nombre_sat || perfil.nombre || '').toUpperCase();
    await page.fill(SELECTORS.rfcCliente, String(perfil.rfc).toUpperCase());
    await page.fill(SELECTORS.razon, razon);
    await page.selectOption(SELECTORS.regimenFiscal, perfil.regimen || '612');
    await page.selectOption(SELECTORS.usoCfdi, perfil.uso_cfdi || 'G03');
    await page.fill(SELECTORS.calle, '');
    await page.fill(SELECTORS.noExterior, '');
    await page.fill(SELECTORS.noInterior, '');
    await page.fill(SELECTORS.ciudad, '');
    await page.fill(SELECTORS.colonia, '');
    await page.fill(SELECTORS.delegacion, '');
    await page.fill(SELECTORS.pais, '');
    await page.fill(SELECTORS.cp, String(perfil.cp || ''));
    await page.fill(SELECTORS.emailInput, String(perfil.email || '').toLowerCase());
    // #formaPagoAux es readonly — page.fill timeout. Setear via evaluate AL FINAL
    // del receptor (el $apply digest puede invalidar transitorias si otros campos
    // están vacíos cuando se ejecuta).
    // 1) DOM defensive (value + dispatch input/change para que ng-model capture)
    // 2) ngModelController.$setViewValue + $setDirty para que validación pase
    // 3) scope.$apply para forzar digest cycle
    await page.evaluate((value) => {
      const el = document.getElementById('formaPagoAux');
      if (!el) return;
      // Defensive: bypass readonly DOM-side
      el.removeAttribute('readonly');
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // Angular: setear scope + ngModelController
      try {
        const ngEl = window.angular?.element(el);
        if (ngEl) {
          const ngModelCtrl = ngEl.controller && ngEl.controller('ngModel');
          if (ngModelCtrl) {
            ngModelCtrl.$setViewValue(value);
            ngModelCtrl.$setDirty();
            ngModelCtrl.$render();
          }
          const scope = ngEl.scope && ngEl.scope();
          if (scope) {
            scope.formaPagoAux = value;
            if (scope.$apply) scope.$apply();
          }
        }
      } catch (e) {}
    }, capturedFormaPago);
    console.log(`[AUTO] 7-Eleven - step 8b: formaPagoAux seteado via evaluate (readonly bypass) value=${capturedFormaPago}`);

    // Step 9: capturar imagen del Kaptcha y resolver con CapSolver
    // Esperar a que la imagen del Kaptcha se haya cargado completamente en el DOM.
    // page.locator(...).screenshot() puede capturar antes de que <img> termine de cargar
    // el bitmap, especialmente con DataDome challenge que retrasa requests.
    await page.waitForSelector(SELECTORS.kaptchaImg, { timeout: 10000 });
    await page.waitForFunction(() => {
      const img = document.getElementById('Kaptcha');
      return img && img.complete && img.naturalWidth > 50;
    }, null, { timeout: 15000 });

    // Descargar la imagen via page.request — reusa las cookies del browser context
    // (datadome=, JSESSIONID, etc.) y obtiene los bytes reales del JPG, no un screenshot.
    const kaptchaUrl = await page.evaluate(() => {
      const img = document.getElementById('Kaptcha');
      return img ? img.src : null;
    });
    if (!kaptchaUrl) {
      throw new Error('7-Eleven: no se pudo encontrar src del Kaptcha img');
    }
    console.log(`[AUTO] 7-Eleven - step 9: descargando Kaptcha desde ${kaptchaUrl}`);
    const kaptchaResp = await page.request.get(kaptchaUrl);
    if (kaptchaResp.status() !== 200) {
      throw new Error(`7-Eleven: Kaptcha image fetch failed status=${kaptchaResp.status()}`);
    }
    const captchaBuffer = await kaptchaResp.body();
    console.log(`[AUTO] 7-Eleven - step 9b: Kaptcha bytes=${captchaBuffer.length}`);
    if (captchaBuffer.length < 2000) {
      throw new Error(`7-Eleven: Kaptcha image sospechosamente pequeña (${captchaBuffer.length} bytes), abortando`);
    }
    const captchaB64 = captchaBuffer.toString('base64');

    let captchaText;
    try {
      captchaText = await resolverKaptchaConCapSolver(captchaB64);
    } catch (e) {
      return { success: false, mensaje: '7-Eleven: ' + e.message };
    }

    // Step 10: llenar input del captcha
    console.log(`[AUTO] 7-Eleven - step 10: fill captcha="${captchaText}"`);
    await page.fill(SELECTORS.captcha, captchaText);

    // Step 11: click "FACTURAR" → dispara window.confirm (auto-aceptado) y POST FacturaExpressService
    console.log('[AUTO] 7-Eleven - step 11: click "FACTURAR"');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => /FACTURAR/i.test(b.textContent || ''));
      if (btn) btn.click();
    });

    // Step 12: esperar response interceptado de FacturaExpressService
    console.log('[AUTO] 7-Eleven - step 12: esperando response de FacturaExpressService');
    const expressResp = await Promise.race([
      expressP,
      new Promise((_, reject) => setTimeout(() => reject(new Error('FacturaExpressService timeout 60s')), 60000))
    ]).catch(e => ({ error: e.message }));

    if (expressResp?.error) {
      return { success: false, mensaje: '7-Eleven: ' + expressResp.error };
    }
    if (expressResp.status >= 400) {
      const bodyStr = typeof expressResp.body === 'object' ? JSON.stringify(expressResp.body) : String(expressResp.body ?? '');
      reportApi(BASE + '/KJServices/webapi/FacturaExpressService', { noTicket }, { response: { status: expressResp.status, data: expressResp.body }, message: 'HTTP ' + expressResp.status });
      return { success: false, mensaje: '7-Eleven: HTTP ' + expressResp.status + ' - ' + bodyStr.substring(0, 200) };
    }

    // Step 13: parsear UUID del response
    console.log('[AUTO] 7-Eleven - step 13: parsear UUID');
    const data = expressResp.body || {};
    const uuid = data.uuid || data.cfdis?.[0]?.uuid || (Array.isArray(data) ? data[0]?.uuid : null);
    if (uuid) {
      console.log(`[AUTO] 7-Eleven - CFDI timbrado uuid=${uuid}`);
      return { success: true, uuid, mensaje: '7-Eleven: factura emitida' };
    }
    if (data.status === '0' || data.status === 0 || data.status === 'OK') {
      const bodyStr = typeof data === 'object' ? JSON.stringify(data) : String(data ?? '');
      return { success: true, mensaje: '7-Eleven: factura solicitada (sin UUID directo) - ' + bodyStr.substring(0, 200) };
    }
    const msg = data.mensaje || data.mensajeValidacion ||
      (typeof data === 'object' ? JSON.stringify(data).substring(0, 200) : String(data ?? '').substring(0, 200));
    return { success: false, mensaje: '7-Eleven: respuesta sin UUID - ' + msg };

  } catch (e) {
    console.warn('[AUTO] 7-Eleven - excepción no capturada:', e.message);
    return { success: false, mensaje: '7-Eleven: error inesperado - ' + e.message };
  } finally {
    await closeBrowser(browser);
  }
}

module.exports = { ejecutar };
