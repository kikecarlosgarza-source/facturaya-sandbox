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

const PORTAL_URL = 'https://facturacion.walmartmexico.com.mx/';
const TIMEOUT_NAV = 30000;
const TIMEOUT_EL = 15000;

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
    browser = await launchStealthBrowser();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'es-MX'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_EL);
    page.setDefaultNavigationTimeout(TIMEOUT_NAV);

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
    // PASO 5 — frmReportAdmin.aspx: timbrado final
    // ─────────────────────────────────────────────────────────
    console.log('[AUTO] Walmart - step 5: timbrado final');

    // Por default: enviar a correo (rdCorreo) — viene auto-llenado de step 3
    await page.check('#ctl00_ContentPlaceHolder1_rdCorreo');

    // Confirmar email — Walmart pre-rellena con el del paso 3 pero por si acaso
    if (perfil.email) {
      await page.fill('#ctl00_ContentPlaceHolder1_txtEmail', perfil.email);
    }

    // Click final → timbra
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => null),
      page.click('#ctl00_ContentPlaceHolder1_btnFacturar')
    ]);

    await page.waitForTimeout(2000);

    // ─────────────────────────────────────────────────────────
    // POST-TIMBRADO — extraer UUID/folio y/o confirmar envío por email
    // ─────────────────────────────────────────────────────────
    const finalState = await page.evaluate(() => {
      const text = document.body.innerText;
      // Buscar UUID típico CFDI (8-4-4-4-12 hex)
      const uuidMatch = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
      // Buscar folio fiscal o número de factura
      const folioMatch = text.match(/folio[:\s]+([A-Z0-9-]{6,})/i);
      // Buscar mensaje de éxito
      const successKeyword = /factura.{0,50}(generad|enviad|emitid|timbrad|exitos)/i.test(text);
      return {
        uuid: uuidMatch ? uuidMatch[0] : null,
        folio: folioMatch ? folioMatch[1] : null,
        successKeyword,
        url: window.location.href,
        bodyPreview: text.substring(0, 800)
      };
    });

    if (finalState.uuid || finalState.folio || finalState.successKeyword) {
      return {
        success: true,
        uuid: finalState.uuid,
        folio: finalState.folio,
        mensaje: `Walmart: factura solicitada${finalState.uuid ? ' UUID ' + finalState.uuid : ''}, será enviada por email a ${perfil.email}`,
        emailEnviado: !!perfil.email,
        facturaData: { url: finalState.url, preview: finalState.bodyPreview.substring(0, 300) }
      };
    }

    // Si no detectamos éxito claro, devolver diagnóstico
    return {
      success: false,
      mensaje: `Walmart: estado post-timbrado ambiguo en URL ${finalState.url} — preview: ${finalState.bodyPreview.substring(0, 200)}`
    };

  } catch (e) {
    reportApi('walmart-flow', { rfc: perfil.rfc, tc, tr }, e);
    return { success: false, mensaje: `Walmart: excepción en flujo — ${e.message}` };
  } finally {
    await closeBrowser(browser);
  }
}

module.exports = { ejecutar };
