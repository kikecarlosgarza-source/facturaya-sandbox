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

// Helper: cerrar cualquier md-dialog (Angular Material modal) abierto en el momento.
// Los modales md-dialog NO los captura page.on('dialog', ...) — ese listener solo
// intercepta window.alert/confirm/prompt nativos, no los modales del DOM Angular Material.
// El "Aviso de Privacidad" típico bloquea clicks porque es un overlay con z-index alto.
async function dismissMdDialogIfPresent(page, contextLabel) {
  try {
    const dismissed = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('md-dialog-container, md-dialog'))
        .filter(d => d.offsetParent);

      if (dialogs.length === 0) return { dismissed: false, count: 0 };

      let closedCount = 0;
      dialogs.forEach(d => {
        const buttons = Array.from(d.querySelectorAll('button'));
        // Priorizar botones de aceptar/ok/continuar/cerrar/sí/no.
        // Fallback: el último botón (típicamente el primary action).
        const acceptBtn = buttons.find(b =>
          /aceptar|ok|continuar|cerrar|confirmar|s[ií]|no/i.test((b.textContent || '').trim())
        ) || buttons[buttons.length - 1];

        if (acceptBtn) {
          acceptBtn.click();
          closedCount++;
        }
      });

      return {
        dismissed: closedCount > 0,
        count: dialogs.length,
        closed: closedCount,
        dialogTexts: dialogs.map(d => (d.textContent || '').trim().substring(0, 100))
      };
    });

    if (dismissed.dismissed) {
      console.log(`[AUTO] 7-Eleven - ${contextLabel}: cerrado md-dialog (${dismissed.closed}/${dismissed.count}) — texts=${JSON.stringify(dismissed.dialogTexts)}`);
      // Esperar a que el dialog se vaya del DOM (animación de cierre)
      await page.waitForFunction(() => {
        return !Array.from(document.querySelectorAll('md-dialog-container, md-dialog'))
          .some(d => d.offsetParent);
      }, null, { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  } catch (e) {
    console.log(`[AUTO] 7-Eleven - ${contextLabel}: error en dismissMdDialog: ${e.message}`);
  }
}

async function triggerPostSuccessEffects(page, uuid, perfil) {
  let emailEnviado = false;
  let pdfBase64 = null;

  try {
    const baseUrl = 'https://www.e7-eleven.com.mx';
    const apiCtx = page.context().request;

    // 1. descargaCfdiXml — comparte cookies de la sesión Playwright
    try {
      const xmlUrl = `${baseUrl}/KJServices/webapi/FacturaExpressService/descargaCfdiXml?uuid=${encodeURIComponent(uuid)}&email=${encodeURIComponent(perfil.email)}`;
      const xmlResp = await apiCtx.get(xmlUrl, { timeout: 15000 });
      const status = xmlResp.status();
      console.log(`[AUTO] 7-Eleven - descargaCfdiXml (apiCtx): status=${status}`);
      emailEnviado = xmlResp.ok();
    } catch (xmlErr) {
      console.log(`[AUTO] 7-Eleven - descargaCfdiXml error: ${xmlErr.message}`);
    }

    // 2. descargaCfdiPdf — descarga el binario
    try {
      const pdfUrl = `${baseUrl}/KJServices/webapi/FacturaExpressService/descargaCfdiPdf?uuid=${encodeURIComponent(uuid)}&rfc=${encodeURIComponent(perfil.rfc)}`;
      const pdfResp = await apiCtx.get(pdfUrl, { timeout: 15000 });
      if (pdfResp.ok()) {
        const buf = await pdfResp.body();
        if (buf && buf.length > 0) {
          pdfBase64 = buf.toString('base64');
          console.log(`[AUTO] 7-Eleven - descargaCfdiPdf OK: ${buf.length} bytes`);
        } else {
          console.log(`[AUTO] 7-Eleven - descargaCfdiPdf vacío`);
        }
      } else {
        console.log(`[AUTO] 7-Eleven - descargaCfdiPdf failed: status=${pdfResp.status()}`);
      }
    } catch (pdfErr) {
      console.log(`[AUTO] 7-Eleven - descargaCfdiPdf error: ${pdfErr.message}`);
    }
  } catch (err) {
    console.log(`[AUTO] 7-Eleven - error post-success (no crítico): ${err.message}`);
  }

  return { emailEnviado, pdfBase64 };
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

    // Auto-aceptar dialogs nativos (window.confirm del FACTURAR + window.alert del
    // "Captcha incorrecto"). Guardamos message/type/timestamp en variables del scope
    // para que el retry loop pueda diferenciar dialogs entre attempts vía timestamp.
    // Patrón unificado: NO usar page.once para captcha — race condition con este global.
    let lastDialogMessage = null;
    let lastDialogType = null;
    let lastDialogTimestamp = 0;
    page.on('dialog', d => {
      lastDialogMessage = d.message();
      lastDialogType = d.type();
      lastDialogTimestamp = Date.now();
      console.log(`[AUTO] 7-Eleven - dialog interceptado: type=${d.type()} message="${d.message()}"`);
      d.accept().catch(() => {}); // catch para evitar throw si ya fue handled
    });

    // Interceptor de network — Promises que resuelven cuando los responses esperados llegan
    let resolveVerifica;
    const verificaP = new Promise(resolve => { resolveVerifica = resolve; });
    let resolveExpress;
    const expressP = new Promise(resolve => { resolveExpress = resolve; });
    // Snapshot del último response de FacturaExpressService capturado por el listener
    // global. Sirve como fallback al respPromise por intento que puede no capturar
    // si el listener global consume primero. El polling loop checa este valor al
    // inicio de cada iteración para early-return con UUID antes de cualquier click.
    let capturedExpressResponse = null;

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
          capturedExpressResponse = { status: resp.status(), body };
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

    // Cerrar Aviso de Privacidad u otro md-dialog que aparezca al entrar al form Express
    await dismissMdDialogIfPresent(page, 'post-step4');

    // Step 5: esperar que aparezca el form de ticket
    console.log('[AUTO] 7-Eleven - step 5: esperando form de ticket');
    await page.waitForSelector(SELECTORS.noTicket, { timeout: 15000 });

    // Segundo intento de cierre de md-dialog — algunos portales muestran el aviso
    // DESPUÉS de que el form ya está renderizado en el DOM
    await dismissMdDialogIfPresent(page, 'post-step5');

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

    // Step 8c: leer el estado de validación del form Angular para detectar si
    // los page.fill registraron correctamente como ng-dirty + ng-valid. Si el
    // form sigue ng-invalid, el submit no dispara aunque hagamos click realista.
    const formValidState = await page.evaluate(() => {
      const form = document.forms['basicForm'];
      if (!form) return 'no form';
      const ngScope = window.angular?.element(form).scope();
      const ngForm = ngScope?.basicForm || ngScope?.[form.name];
      return {
        formInvalid: form.classList.contains('ng-invalid'),
        angularInvalid: ngForm?.$invalid,
        angularValid: ngForm?.$valid,
        firstInvalid: Array.from(form.querySelectorAll('.ng-invalid')).slice(0, 3).map(el => el.id || el.name)
      };
    });
    console.log(`[AUTO] 7-Eleven - step 8c: form state ${JSON.stringify(formValidState)}`);

    // Step 9-11: captcha download + CapSolver + click FACTURAR con retry loop.
    // Los Kaptcha de Konesh son notoriamente difíciles. CapSolver puede devolver
    // texto con confianza alta (0.99) pero incorrecto. Retry hasta 3 veces:
    // refrescar Kaptcha → CapSolver → fill → click → detectar dialog "Captcha incorrecto".
    const MAX_CAPTCHA_RETRIES = 3;
    let captchaSuccess = false;
    let lastCaptchaError = null;
    // Response del POST capturado por intento. Evita el staleness del expressP global
    // (que se resuelve solo en el primer POST y no se actualiza en los retries).
    let finalExpressResp = null;

    for (let attempt = 1; attempt <= MAX_CAPTCHA_RETRIES; attempt++) {
      console.log(`[AUTO] 7-Eleven - step 9 (intento ${attempt}/${MAX_CAPTCHA_RETRIES}): descargando Kaptcha`);

      // Si no es el primer intento, recargar captcha clickeando el botón de reload
      if (attempt > 1) {
        // El portal tiene un botón con reload2.png al lado del captcha — refrescar
        await page.evaluate(() => {
          const reloadBtn = document.querySelector('img[src*="reload2"], [ng-click*="captcha"]');
          if (reloadBtn) reloadBtn.click();
          else {
            // Fallback: forzar recarga del src del Kaptcha
            const img = document.getElementById('Kaptcha');
            if (img) img.src = img.src.split('?')[0] + '?t=' + Date.now();
          }
        });
        // Esperar a que la nueva imagen cargue
        await page.waitForTimeout(1500);
      }

      // Esperar imagen lista
      await page.waitForFunction(() => {
        const img = document.getElementById('Kaptcha');
        return img && img.complete && img.naturalWidth > 50;
      }, null, { timeout: 15000 });

      // Descargar via page.request
      const kaptchaUrl = await page.evaluate(() => {
        const img = document.getElementById('Kaptcha');
        return img ? img.src : null;
      });
      const kaptchaResp = await page.request.get(kaptchaUrl);
      const captchaBuffer = await kaptchaResp.body();
      console.log(`[AUTO] 7-Eleven - step 9b (intento ${attempt}): Kaptcha bytes=${captchaBuffer.length}`);
      if (captchaBuffer.length < 2000) {
        lastCaptchaError = `Kaptcha image sospechosamente pequeña (${captchaBuffer.length} bytes)`;
        continue;
      }

      // Resolver con CapSolver
      const captchaText = await resolverKaptchaConCapSolver(captchaBuffer.toString('base64'));
      console.log(`[AUTO] 7-Eleven - step 9c (intento ${attempt}): CapSolver resolvió "${captchaText}"`);

      if (!captchaText || captchaText.length < 4) {
        lastCaptchaError = `CapSolver returned empty or too short text: "${captchaText}"`;
        continue;
      }

      // Llenar input captcha via evaluate Angular bypass (mismo patrón que formaPagoAux).
      // page.fill no dispara los $watch de Angular cuando el form está validado
      // client-side agresivamente — el form queda $invalid y el submit es silencioso
      // aunque hagamos click realista. Confirmado empíricamente: step 8c logueó
      // firstInvalid:["captcha"] tras page.fill, lo que bloqueaba el submit.
      await page.evaluate((value) => {
        const el = document.getElementById('captcha');
        if (!el) return;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
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
              scope.captcha = value;
              if (scope.$apply) scope.$apply();
            }
          }
        } catch (e) {}
      }, captchaText);

      // Verificar que el form ahora está válido antes del click. Si sigue $invalid,
      // el submit no se va a disparar y caemos a "timeout sin dialog ni POST".
      const formValidPreClick = await page.evaluate(() => {
        const form = document.forms['basicForm'];
        if (!form) return 'no form';
        const ngScope = window.angular?.element(form).scope();
        const ngForm = ngScope?.basicForm;
        return {
          angularInvalid: ngForm?.$invalid,
          angularValid: ngForm?.$valid,
          firstInvalid: Array.from(form.querySelectorAll('.ng-invalid')).slice(0, 3).map(el => el.id || el.name)
        };
      });
      console.log(`[AUTO] 7-Eleven - step 10b (intento ${attempt}): form state pre-click ${JSON.stringify(formValidPreClick)}`);

      // Capturar timestamp del último dialog conocido. El portal NO llama
      // captchaValidator en el flow Express (sólo se invoca si reCAPTCHA v2 está
      // renderizado, y aquí no lo está). Por eso el signal real es:
      // dialog (= error) OR POST FacturaExpressService (= success).
      const dialogTimestampBefore = lastDialogTimestamp;

      // respPromise por intento (one-shot, no comparte estado con expressP global)
      const respPromise = page.waitForResponse(
        resp => resp.url().includes('FacturaExpressService') && resp.request().method() === 'POST',
        { timeout: 15000 }
      ).catch(() => null);

      // Click FACTURAR — usar page.click() de Playwright (no page.evaluate(.click))
      // para disparar el submit del <form name="basicForm"> correctamente. El botón
      // es <button type="submit"> sin ng-click; un .click() sintético via evaluate
      // puede ser silencioso bajo Angular/headless. page.click() simula
      // mousedown+mouseup+click como un usuario real.
      const facturarBtnHandle = await page.evaluateHandle(() => {
        return Array.from(document.querySelectorAll('button')).find(b =>
          /^FACTURAR$/i.test((b.textContent || '').trim()) && b.offsetParent
        );
      });
      const facturarBtn = facturarBtnHandle.asElement();
      if (!facturarBtn) {
        throw new Error('7-Eleven: botón FACTURAR no encontrado');
      }

      // Tercer punto de control: cerrar cualquier md-dialog que pudo haber aparecido
      // entre el click "Agregar Ticket" y el click FACTURAR (ej. modal de confirmación
      // del ticket o aviso adicional). El que tapaba el botón en el log anterior.
      await dismissMdDialogIfPresent(page, `pre-step11-attempt-${attempt}`);

      // DEBUG instrumentation: log valores reales del scope de Angular para cada
      // campo del receptor. Diagnóstico de falso positivo UUID con rfc vacío:
      // queremos saber si los valores realmente llegan al $modelValue de Angular o
      // si page.fill solo afectó el DOM sin commitear al model.
      const formValues = await page.evaluate(() => {
        const ids = ['rfcCliente', 'razon', 'regimenFiscalReceptor', 'formaPagoAux', 'usoCfdi', 'cp', 'emailInput', 'captcha'];
        const result = {};
        ids.forEach(id => {
          const el = document.getElementById(id);
          if (!el) { result[id] = '(no exists)'; return; }
          const ngEl = window.angular?.element(el);
          const ngScope = ngEl?.scope?.();
          const ngModelCtrl = ngEl?.controller?.('ngModel');
          result[id] = {
            domValue: el.value,
            ngModelValue: ngModelCtrl?.$modelValue,
            ngViewValue: ngModelCtrl?.$viewValue,
            scopeValue: ngScope?.[el.getAttribute('ng-model')?.split('.').pop()]
          };
        });
        return result;
      });
      console.log(`[AUTO] 7-Eleven - DEBUG values pre-click: ${JSON.stringify(formValues)}`);

      // Scroll defensivo: aunque el viewport sea suficiente, asegurar que el botón
      // esté centrado verticalmente. Importante para formularios con scroll virtual
      // o headers fijos que tapan parte del viewport. behavior:'instant' (no smooth)
      // para evitar race con el click siguiente.
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b =>
          /^FACTURAR$/i.test((b.textContent || '').trim()) && b.offsetParent
        );
        if (btn) btn.scrollIntoView({ block: 'center', behavior: 'instant' });
      });
      await page.waitForTimeout(300);

      try {
        await facturarBtn.click();
        console.log(`[AUTO] 7-Eleven - step 11 (intento ${attempt}): page.click() del botón FACTURAR ejecutado`);
      } catch (clickErr) {
        console.log(`[AUTO] 7-Eleven - step 11 (intento ${attempt}): click error: ${clickErr.message}`);

        // Click trono — pero el listener global PUEDE haber capturado el response del POST
        // antes del throw. Check directo de capturedExpressResponse: si ya tiene UUID,
        // la factura YA fue timbrada exitosamente y el click timeout es solo un artefacto
        // (form submitted por dismiss-dialog, button defunct), no una falla real.
        if (capturedExpressResponse !== null) {
          const body = capturedExpressResponse.body;
          let earlyUuid = null;
          if (Array.isArray(body) && body[0]?.uuid) earlyUuid = body[0].uuid;
          else if (body?.uuid) earlyUuid = body.uuid;
          else if (body?.cfdis?.[0]?.uuid) earlyUuid = body.cfdis[0].uuid;

          if (earlyUuid) {
            console.log(`[AUTO] 7-Eleven - SUCCESS uuid=${earlyUuid} (early return tras click error — listener global ya tenía el response)`);
            const { emailEnviado, pdfBase64 } = await triggerPostSuccessEffects(page, earlyUuid, perfil);
            closeBrowser(browser).catch(() => {});
            return { success: true, uuid: earlyUuid, mensaje: 'CFDI generado exitosamente', emailEnviado, pdfBase64 };
          }
        }

        // Si no había response previo, propagar el error como antes
        throw clickErr;
      }

      // Polling: cada 200ms verificar (a) dialog nuevo, (b) si respPromise resolvió
      let postResp = null;
      let newDialog = false;
      let dialogMsg = null;

      const startTime = Date.now();
      const TIMEOUT_MS = 12000;

      while (Date.now() - startTime < TIMEOUT_MS) {
        // Check 0: el listener global ya capturó el response de FacturaExpressService.
        // Más rápido y confiable que respPromise por intento (que puede no capturar
        // si el listener global consume primero, según diagnóstico del 7/may/2026).
        if (capturedExpressResponse !== null) {
          const body = capturedExpressResponse.body;
          let earlyUuid = null;
          if (Array.isArray(body) && body[0]?.uuid) earlyUuid = body[0].uuid;
          else if (body?.uuid) earlyUuid = body.uuid;
          else if (body?.cfdis?.[0]?.uuid) earlyUuid = body.cfdis[0].uuid;
          if (earlyUuid) {
            console.log(`[AUTO] 7-Eleven - SUCCESS uuid=${earlyUuid} (early return via listener global)`);
            const { emailEnviado, pdfBase64 } = await triggerPostSuccessEffects(page, earlyUuid, perfil);
            closeBrowser(browser).catch(() => {});
            return { success: true, uuid: earlyUuid, mensaje: 'CFDI generado exitosamente', emailEnviado, pdfBase64 };
          }
        }

        // Check dialog
        if (lastDialogTimestamp > dialogTimestampBefore) {
          newDialog = true;
          dialogMsg = lastDialogMessage;
          break;
        }

        // Check respPromise (race con timeout corto, no bloquea siguiente iteración)
        postResp = await Promise.race([
          respPromise,
          new Promise(r => setTimeout(() => r('still waiting'), 200))
        ]);
        if (postResp && postResp !== 'still waiting') {
          break;
        }
        postResp = null;
      }

      if (newDialog) {
        console.log(`[AUTO] 7-Eleven - intento ${attempt}: dialog "${dialogMsg}"`);
        if (/captcha/i.test(dialogMsg)) {
          lastCaptchaError = `Captcha rechazado: "${dialogMsg}"`;
          continue;
        } else {
          // Otro error (ya facturado, ticket inválido, etc.) — abort sin retry
          return { success: false, mensaje: `7-Eleven: ${dialogMsg}` };
        }
      }

      if (postResp) {
        const body = await postResp.json().catch(async () => await postResp.text());
        finalExpressResp = { status: postResp.status(), body };
        console.log(`[AUTO] 7-Eleven - intento ${attempt}: POST FacturaExpressService capturado status=${postResp.status()}`);

        // Extraer UUID INMEDIATAMENTE — si existe, return temprano sin más interacción
        // con browser. Esto evita que un elementHandle.click pendiente o cualquier
        // re-render post-submit haga timeout y mate la ejecución después de que
        // la factura YA fue timbrada exitosamente.
        let earlyUuid = null;
        if (Array.isArray(body) && body[0]?.uuid) earlyUuid = body[0].uuid;
        else if (body?.uuid) earlyUuid = body.uuid;
        else if (body?.cfdis?.[0]?.uuid) earlyUuid = body.cfdis[0].uuid;

        if (earlyUuid) {
          console.log(`[AUTO] 7-Eleven - SUCCESS uuid=${earlyUuid} (early return, sin más interacción con DOM)`);
          const { emailEnviado, pdfBase64 } = await triggerPostSuccessEffects(page, earlyUuid, perfil);
          closeBrowser(browser).catch(() => {});
          return {
            success: true,
            uuid: earlyUuid,
            mensaje: 'CFDI generado exitosamente',
            emailEnviado,
            pdfBase64
          };
        }

        captchaSuccess = true;
        break;
      }

      console.log(`[AUTO] 7-Eleven - intento ${attempt}: timeout sin dialog ni POST en ${TIMEOUT_MS}ms`);
      lastCaptchaError = 'Timeout sin dialog ni POST tras click FACTURAR';
      continue;
    }

    if (!captchaSuccess) {
      return {
        success: false,
        mensaje: `7-Eleven: captcha falló después de ${MAX_CAPTCHA_RETRIES} intentos. Último error: ${lastCaptchaError}`
      };
    }

    // Step 12: usar response capturado durante el retry loop. Si por algún motivo
    // el waitForResponse del intento exitoso no atrapó (validación client-side,
    // race condition), caer al expressP global como fallback.
    console.log('[AUTO] 7-Eleven - step 12: response final del POST FacturaExpressService');
    let expressResp = finalExpressResp;
    if (!expressResp) {
      console.log('[AUTO] 7-Eleven - step 12: finalExpressResp vacío, usando expressP global');
      expressResp = await Promise.race([
        expressP,
        new Promise((_, reject) => setTimeout(() => reject(new Error('FacturaExpressService timeout 60s')), 60000))
      ]).catch(e => ({ error: e.message }));
    }

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
