// Handler para portal de facturación de Walmart México
// (facturacion.walmartmexico.com.mx).
//
// Flujo: 5 pantallas ASPX clásicas con __VIEWSTATE/__EVENTVALIDATION —
//   1. Default.aspx       → aceptar disclaimer + click "Obtener factura"
//   2. frmDatos.aspx      → RFC, CP, TC#, TR#  → btnAceptar
//   3. frmRFCEdita.aspx   → razón social, email, régimen, uso CFDI  → btnAceptar
//      → modal "¿Están correctos sus datos?" → click ctl00_btnContinuar
//   4. frmPaymentType.aspx → forma de pago    → btnContinuar
//   5. frmReportAdmin.aspx → radio (correo/PDF) → btnFacturar (timbra)
//
// Autocompletado: el ImageButton1 al lado del CP llena Estado y Municipio
// desde el catálogo SAT (postback ASPX).
//
// El select ddlusoCFDI se popula via postback al cambiar ddlregimenFiscal,
// hay que esperar response antes de seleccionar el uso.
//
// Sin API HTTP directa: ASPX rota __VIEWSTATE entre pasos, por eso UI con
// Playwright (igual que sevenelevenHandler / benavidesHandler).

const { launchStealthBrowser, closeBrowser } = require('../koneshBrowser');
const claudeAgent = require('../claudeAgent');
const fs = require('fs');
const path = require('path');

const PORTAL_URL = 'https://facturacion.walmartmexico.com.mx/';
const TIMEOUT_NAV = 30000;
const TIMEOUT_EL = 15000;

// Fase 2 (descarga PDF best-effort tras timbrado exitoso).
// Misma convención de path que routes/constancia.js → en sandbox queda
// /tmp/reino-c-e2e/facturas/<id>.pdf; en prod /data/facturas/<id>.pdf.
const FACTURAS_DIR = process.env.FACTURAS_DIR
  || path.join(process.env.DB_DIR || '/data', 'facturas');
const FASE2_TIMEOUT_MS = 60000;

function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal, endpoint, request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

// Walmart pide forma de pago como código SAT — mapear lo más común.
// Si no se infiere del ticket, default crédito (04) que es lo más común.
function mapPaymentType(ticketData) {
  const raw = String(ticketData.forma_pago || ticketData.metodo_pago || ticketData.tipo_pago || '').toLowerCase();
  if (/efectivo|cash/.test(raw)) return null; // efectivo no aparece en el dropdown — fallback a default
  if (/d[ée]bito|debit/.test(raw)) return '28';
  if (/cr[ée]dito|credit/.test(raw)) return '04';
  if (/monedero|electr[oó]nico|gift/.test(raw)) return '05';
  // AID puede venir del ticket — A0000000041010 es Mastercard típicamente crédito
  if (/A00000000[0-9]+/.test(ticketData.aid || '')) return '04';
  // Si tarjeta sin tipo — default crédito (caso más común en tickets impresos)
  if (/tarjeta|mastercard|visa|amex/i.test(raw)) return '04';
  return '04';
}

// Fase 2 best-effort: tras un timbrado exitoso (Fase 1, email enviado),
// reusa la misma sesión Playwright (mismas cookies ASP.NET_SessionId) para
// recorrer el flujo de Consulta y descargar el PDF binario desde el iframe
// /frmReportPDF2.aspx. Walmart identifica qué CFDI servir por session +
// txtTCFact (no por query params).
//
// Si algo falla, NO afecta el éxito de Fase 1: devuelve
// { pdf_descargado:false, pdf_error:'<razón>' } y el caller decide.
// Timeout overall hard-cap en FASE2_TIMEOUT_MS para no bloquear el handler.
async function descargarPdfWalmart({ context, page, ticketData, solicitudId }) {
  const t0 = Date.now();
  const tc = String(ticketData.numero_ticket || ticketData.tc || ticketData.ticket_code || '').trim();
  if (!solicitudId) return { pdf_descargado: false, pdf_error: 'Fase 2 skip: solicitudId vacío' };
  if (!tc)          return { pdf_descargado: false, pdf_error: 'Fase 2 skip: TC# vacío' };

  const pdfPath = path.join(FACTURAS_DIR, `${solicitudId}.pdf`);

  const work = (async () => {
    console.log('[AUTO] Walmart - Fase 2: navegando a portal para descarga PDF');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
    try {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /aceptar/i.test(b.textContent || ''));
        if (btn) btn.click();
      });
      await page.waitForTimeout(500);
    } catch (_) {}
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.evaluate(() => {
        const link = document.querySelector('a[href="frmDatos.aspx"]');
        if (link) link.click();
      })
    ]);

    // radConsultar: postback parcial; reemplaza el form a un único input txtTCFact
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => null),
      page.click('#ctl00_ContentPlaceHolder1_radConsultar')
    ]);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => null);

    await page.waitForSelector('#ctl00_ContentPlaceHolder1_txtTCFact', { state: 'visible', timeout: 15000 });
    await page.fill('#ctl00_ContentPlaceHolder1_txtTCFact', tc);
    console.log('[AUTO] Walmart - Fase 2: txtTCFact relleno, click btnAceptar');

    // btnAceptar → nav real a /frmConsultaFactura.aspx
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }),
      page.click('#ctl00_ContentPlaceHolder1_btnAceptar')
    ]);
    if (!/frmConsultaFactura\.aspx/i.test(page.url())) {
      throw new Error(`URL inesperada tras btnAceptar — ${page.url()}`);
    }

    // rdDescargar viene checked por default; reafirmamos por defensa
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_rdDescargar', { state: 'visible', timeout: 15000 });
    await page.check('#ctl00_ContentPlaceHolder1_rdDescargar');

    // btnAceptar (Aceptar) → postback parcial que carga el iframe del PDF
    await page.click('#ctl00_ContentPlaceHolder1_btnAceptar');
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
    await page.waitForTimeout(2000);

    await page.waitForSelector('#ctl00_ContentPlaceHolder1_Iframe1', { state: 'attached', timeout: 15000 });
    const iframeSrc = await page.evaluate(() => {
      const f = document.querySelector('#ctl00_ContentPlaceHolder1_Iframe1');
      return f ? f.src : null;
    });
    if (!iframeSrc) throw new Error('iframe sin src tras click Aceptar');
    console.log(`[AUTO] Walmart - Fase 2: iframe detectado src=${iframeSrc}`);

    // GET con cookies de la sesión (context.request hereda cookies del browser)
    const res = await context.request.get(iframeSrc, { timeout: 30000 });
    if (res.status() !== 200) throw new Error(`GET iframe status=${res.status()}`);
    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (!/application\/pdf/i.test(ct)) throw new Error(`Content-Type inesperado "${ct}"`);
    const body = await res.body();
    const head5 = body.slice(0, 5).toString('ascii');
    if (head5 !== '%PDF-') throw new Error(`header "${head5}" no es %PDF-`);

    if (!fs.existsSync(FACTURAS_DIR)) fs.mkdirSync(FACTURAS_DIR, { recursive: true });
    fs.writeFileSync(pdfPath, body);
    console.log(`[AUTO] Walmart - Fase 2: PDF descargado ${body.length} bytes, %PDF válido → ${pdfPath} (${Date.now() - t0}ms)`);
    return { pdf_descargado: true, pdf_path: pdfPath, pdf_size_bytes: body.length };
  })();

  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        const id = setTimeout(
          () => reject(new Error(`timeout overall ${FASE2_TIMEOUT_MS}ms`)),
          FASE2_TIMEOUT_MS
        );
        if (id.unref) id.unref();
      })
    ]);
  } catch (err) {
    const msg = (err && err.message || String(err)).split('\n')[0];
    console.log(`[AUTO] Walmart - Fase 2 FALLÓ (best-effort): ${msg}`);
    return { pdf_descargado: false, pdf_error: msg };
  }
}

async function ejecutar(perfil, ticketData, solicitudId) {
  const reportApi = makeReportApi('walmart');

  // ─── Validación de campos del ticket ───
  // Walmart requiere TC# (Ticket Code, 20 dígitos) y TR# (Transaction).
  // El barcode TS# (070526164019) NO sirve directamente — son el TC y TR
  // impresos cerca del total los que entran en el form.
  const tc = String(ticketData.numero_ticket || ticketData.tc || ticketData.ticket_code || '').trim();
  const tr = String(ticketData.numero_transaccion || ticketData.tr || ticketData.transaccion || '').trim();
  const total = ticketData.total;

  if (!tc) return { success: false, mensaje: 'Walmart: numero_ticket (TC# del ticket, ~20 dígitos) requerido' };
  if (!tr) return { success: false, mensaje: 'Walmart: numero_transaccion (TR# del ticket, ~5 dígitos) requerido' };

  // ─── Validación de perfil fiscal ───
  if (!perfil.rfc) return { success: false, mensaje: 'Walmart: RFC del perfil requerido' };
  if (!perfil.cp) return { success: false, mensaje: 'Walmart: CP del perfil requerido' };
  if (!perfil.regimen) return { success: false, mensaje: 'Walmart: régimen fiscal del perfil requerido' };
  if (!perfil.uso_cfdi) return { success: false, mensaje: 'Walmart: uso CFDI del perfil requerido' };
  if (!perfil.nombre) return { success: false, mensaje: 'Walmart: razón social (nombre) del perfil requerido' };

  console.log(`[AUTO] Walmart - rfc=${perfil.rfc} cp=${perfil.cp} tc=${tc.substring(0,8)}... tr=${tr} total=${total}`);

  let browser;
  try {
    const launched = await launchStealthBrowser({ viewport: { width: 1280, height: 800 } });
    browser = launched.browser;
    const { context, page } = launched;
    context.setDefaultTimeout(TIMEOUT_EL);
    context.setDefaultNavigationTimeout(TIMEOUT_NAV);

    // ─────────────────────────────────────────────────────────
    // PASO 1 — Default.aspx: aceptar disclaimer + click "Obtener factura"
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 1: navegando a portal');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });

    // Modal de aviso de privacidad — botón "Aceptar"
    try {
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => /aceptar/i.test(b.textContent || ''));
        if (btn) btn.click();
      });
      await page.waitForTimeout(500);
    } catch (e) {
      console.log('[AUTO] Walmart - step 1: disclaimer no apareció (ok, continuamos)');
    }

    // Click en "Obtener factura" → frmDatos.aspx
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT_NAV }),
      page.evaluate(() => {
        const link = document.querySelector('a[href="frmDatos.aspx"]');
        if (link) link.click();
      })
    ]);

    // ─────────────────────────────────────────────────────────
    // PASO 2 — frmDatos.aspx: RFC, CP, TC#, TR#
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 2: llenando datos del ticket');
    if (!/frmDatos\.aspx/i.test(page.url())) {
      return { success: false, mensaje: `Walmart: navegación a frmDatos falló — URL actual ${page.url()}` };
    }

    await page.fill('#ctl00_ContentPlaceHolder1_txtMemRFC', perfil.rfc);
    await page.fill('#ctl00_ContentPlaceHolder1_txtCP', perfil.cp);
    await page.fill('#ctl00_ContentPlaceHolder1_txtTC', tc);
    await page.fill('#ctl00_ContentPlaceHolder1_txtTR', tr);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT_NAV }),
      page.click('#ctl00_ContentPlaceHolder1_btnAceptar')
    ]);

    // Si el server rechaza ticket/RFC inválido — vuelve a Default.aspx
    if (/Default\.aspx/i.test(page.url())) {
      const alertText = await page.evaluate(() => {
        const alerts = Array.from(document.querySelectorAll('[id*=divMsg], .modal-body'))
          .filter(d => d.offsetParent !== null)
          .map(d => (d.textContent || '').trim())
          .filter(t => t.length > 0);
        return alerts.join(' | ');
      }).catch(() => '');
      return {
        success: false,
        mensaje: `Walmart: rechazado en frmDatos (datos del ticket inválidos o ya facturado)${alertText ? ' — ' + alertText.substring(0, 200) : ''}`
      };
    }

    if (!/frmRFCEdita\.aspx/i.test(page.url())) {
      return { success: false, mensaje: `Walmart: navegación a frmRFCEdita inesperada — URL ${page.url()}` };
    }

    // ─────────────────────────────────────────────────────────
    // PASO 3 — frmRFCEdita.aspx: razón social, régimen, uso CFDI, email
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 3: llenando datos fiscales');

    // Razón social (obligatorio*)
    await page.fill('#ctl00_ContentPlaceHolder1_txtRazon', perfil.nombre);

    // CP — re-confirmar (a veces ya viene del paso anterior, pero por si acaso)
    // y disparar ImageButton1 para autocompletar Estado/Municipio
    await page.fill('#ctl00_ContentPlaceHolder1_txtCP', perfil.cp);
    await Promise.all([
      page.waitForResponse(r => /frmRFCEdita\.aspx/i.test(r.url()) && r.status() === 200, { timeout: TIMEOUT_EL }).catch(() => null),
      page.click('#ctl00_ContentPlaceHolder1_ImageButton1')
    ]);
    await page.waitForTimeout(800); // dejar que el postback termine y popule Estado/Municipio

    // Email (no es obligatorio* pero Walmart lo necesita para enviar CFDI)
    if (perfil.email) {
      await page.fill('#ctl00_ContentPlaceHolder1_txtEmail', perfil.email);
    }

    // Régimen fiscal (obligatorio*) — disparar postback para popular ddlusoCFDI
    await Promise.all([
      page.waitForResponse(r => /frmRFCEdita\.aspx/i.test(r.url()) && r.status() === 200, { timeout: TIMEOUT_EL }).catch(() => null),
      page.selectOption('#ctl00_ContentPlaceHolder1_ddlregimenFiscal', String(perfil.regimen))
    ]);
    await page.waitForTimeout(800);

    // Uso CFDI (obligatorio*) — sólo disponible después del postback del régimen
    const usoOptions = await page.$$eval('#ctl00_ContentPlaceHolder1_ddlusoCFDI option', opts => opts.map(o => o.value));
    if (!usoOptions.includes(String(perfil.uso_cfdi))) {
      return {
        success: false,
        mensaje: `Walmart: uso CFDI '${perfil.uso_cfdi}' no disponible para régimen ${perfil.regimen}. Disponibles: ${usoOptions.filter(o => o !== '0').join(', ')}`
      };
    }
    await page.selectOption('#ctl00_ContentPlaceHolder1_ddlusoCFDI', String(perfil.uso_cfdi));

    // Submit del paso 3 — abre modal "¿Están correctos sus datos?"
    await page.click('#ctl00_ContentPlaceHolder1_btnAceptar');

    // ─────────────────────────────────────────────────────────
    // PASO 3b — Modal de confirmación: "¿Están correctos todos sus datos?"
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 3b: confirmando modal');
    // Esperar a que aparezca el modal
    await page.waitForSelector('#divMsgPregunta', { state: 'visible', timeout: TIMEOUT_EL }).catch(() => null);
    await page.waitForTimeout(500);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT_NAV }),
      page.click('#ctl00_btnContinuar')
    ]);

    if (!/frmPaymentType\.aspx/i.test(page.url())) {
      // Buscar mensaje de error visible
      const errorMsg = await page.evaluate(() => {
        const visibles = Array.from(document.querySelectorAll('.modal'))
          .filter(m => m.offsetParent !== null)
          .map(m => (m.textContent || '').trim().substring(0, 200));
        return visibles.join(' | ');
      }).catch(() => '');
      return {
        success: false,
        mensaje: `Walmart: confirmación rechazada en step 3b — URL ${page.url()}${errorMsg ? ' — ' + errorMsg : ''}`
      };
    }

    // ─────────────────────────────────────────────────────────
    // PASO 4 — frmPaymentType.aspx: forma de pago
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 4: forma de pago');
    const paymentType = mapPaymentType(ticketData);

    await page.selectOption('#ctl00_ContentPlaceHolder1_ddlPaymentType', paymentType);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT_NAV }),
      page.click('#ctl00_ContentPlaceHolder1_btnContinuar')
    ]);

    if (!/frmReportAdmin\.aspx/i.test(page.url())) {
      const errorMsg = await page.evaluate(() => {
        const visibles = Array.from(document.querySelectorAll('.modal, .alert'))
          .filter(m => m.offsetParent !== null)
          .map(m => (m.textContent || '').trim().substring(0, 200));
        return visibles.join(' | ');
      }).catch(() => '');
      return {
        success: false,
        mensaje: `Walmart: forma de pago '${paymentType}' rechazada — URL ${page.url()}${errorMsg ? ' — ' + errorMsg : ''}`
      };
    }

    // ─────────────────────────────────────────────────────────
    // PASO 5 — frmReportAdmin.aspx: dual-mode detection
    // ─────────────────────────────────────────────────────────
    // Esta pantalla tiene DOS modos posibles:
    //   (a) "factura nueva"  → radio rdCorreo + btnFacturar (flujo legacy)
    //   (b) "refactura"      → solo btnRefacturar visible (CFDI YA emitido,
    //       el timbrado real ocurrió en algún paso previo —
    //       probablemente al cruzar el modal del paso 3b).
    // El portal NO expone UUID/folio en modo refactura, por eso ahí
    // devolvemos success:false sin clickear btnRefacturar (clickearlo
    // re-envía el CFDI existente al correo del receptor, lo que duplicaría
    // emails en escenarios de retry).
    console.log('[AUTO] Walmart - step 5: detectando modo de frmReportAdmin');
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(1500);

    const refacturaBtn = page.locator('#ctl00_ContentPlaceHolder1_btnRefacturar');
    const rdCorreoLoc  = page.locator('#ctl00_ContentPlaceHolder1_rdCorreo');
    const isRefactura  = await refacturaBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const isFacturaNueva = !isRefactura && await rdCorreoLoc.isVisible({ timeout: 2000 }).catch(() => false);

    if (isRefactura) {
      // Ticket ya facturado previamente (o timbrado backend implícito en paso
      // 3b). El handler NO clickea btnRefacturar para evitar enviar email
      // duplicado al receptor. Verificación vía email/XML es responsabilidad
      // del caller.
      console.log('[AUTO] Walmart - step 5: modo REFACTURA detectado (CFDI ya existe)');
      const refState = await page.evaluate(() => ({
        url: window.location.href,
        preview: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 400)
      }));
      return {
        success: false,
        refactura: true,
        mensaje: 'Walmart: ticket ya estaba facturado previamente (modo refactura). El CFDI ya existe — verificar email del receptor para UUID.',
        facturaData: { url: refState.url, preview: refState.preview }
      };
    }

    if (!isFacturaNueva) {
      // Estado inesperado — ni refactura ni form clásico. Dump para diagnóstico.
      console.log('[AUTO] Walmart - step 5: estado DESCONOCIDO (sin btnRefacturar ni rdCorreo)');
      try {
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        require('fs').writeFileSync('/tmp/walmart-step5-unknown.html', html);
        await page.screenshot({ path: '/tmp/walmart-step5-unknown.png', fullPage: true }).catch(() => null);
      } catch (_) {}
      const unkState = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        preview: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 400)
      }));
      return {
        success: false,
        mensaje: `Walmart: estado desconocido en paso 5 — url ${unkState.url}, título "${unkState.title}". DOM dumpeado a /tmp/walmart-step5-unknown.{html,png}. Preview: ${unkState.preview.substring(0, 200)}`
      };
    }

    // Modo factura nueva: flujo clásico con radio rdCorreo + btnFacturar.
    console.log('[AUTO] Walmart - step 5: modo factura nueva (rdCorreo + btnFacturar)');
    await page.check('#ctl00_ContentPlaceHolder1_rdCorreo');
    if (perfil.email) {
      await page.fill('#ctl00_ContentPlaceHolder1_txtEmail', perfil.email);
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      page.click('#ctl00_ContentPlaceHolder1_btnFacturar')
    ]);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2000);

    // ─────────────────────────────────────────────────────────
    // POST-TIMBRADO — extraer UUID/folio y/o confirmar envío por email
    // ─────────────────────────────────────────────────────────
    const finalState = await page.evaluate(() => {
      const text = document.body.innerText;
      const uuidMatch = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      const folioMatch = text.match(/folio[:\s]+([A-Z0-9-]{6,})/i);
      const successKeyword = /factura.{0,50}(generad|enviad|emitid|timbrad|exitos)/i.test(text);
      return {
        uuid: uuidMatch ? uuidMatch[0] : null,
        folio: folioMatch ? folioMatch[1] : null,
        successKeyword,
        url: window.location.href,
        bodyPreview: text.substring(0, 800)
      };
    });

    // Logging detallado del estado post-submit para diagnosticar futuros bumps.
    console.log(`[AUTO] Walmart - step 5 post-submit: url=${finalState.url} uuid=${finalState.uuid || '∅'} folio=${finalState.folio || '∅'} successKw=${finalState.successKeyword}`);
    console.log(`[AUTO] Walmart - step 5 body preview (300): ${finalState.bodyPreview.substring(0, 300)}`);

    if (finalState.uuid || finalState.folio || finalState.successKeyword) {
      const successResult = {
        success: true,
        uuid: finalState.uuid,
        folio: finalState.folio,
        mensaje: `Walmart: factura solicitada${finalState.uuid ? ' UUID ' + finalState.uuid : ''}, será enviada por email a ${perfil.email}`,
        emailEnviado: !!perfil.email,
        facturaData: { url: finalState.url, preview: finalState.bodyPreview.substring(0, 300) }
      };
      // Fase 2 (best-effort): descarga del PDF en la misma sesión Playwright.
      // No afecta el éxito del timbrado: si falla, agrega pdf_descargado:false.
      const pdfResult = await descargarPdfWalmart({ context, page, ticketData, solicitudId });
      return { ...successResult, ...pdfResult };
    }

    // Sin UUID ni keyword pero llegamos a post-submit. Dump diagnóstico.
    try {
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      require('fs').writeFileSync('/tmp/walmart-step5-post-submit-ambiguous.html', html);
      await page.screenshot({ path: '/tmp/walmart-step5-post-submit-ambiguous.png', fullPage: true }).catch(() => null);
    } catch (_) {}
    return {
      success: false,
      mensaje: `Walmart: estado post-timbrado ambiguo en URL ${finalState.url} (sin UUID/folio/keyword). DOM dumpeado a /tmp/walmart-step5-post-submit-ambiguous.{html,png}. Preview: ${finalState.bodyPreview.substring(0, 200)}`
    };

  } catch (e) {
    reportApi('walmart-flow', { rfc: perfil.rfc, tc, tr }, e);
    return { success: false, mensaje: `Walmart: excepción en flujo — ${e.message}` };
  } finally {
    await closeBrowser(browser);
  }
}

module.exports = { ejecutar };
