// Handler bespoke para alsea.interfactura.com (multi-marca: VIPS, Starbucks,
// Domino's, Burger King, Chili's, P.F. Chang's, Italianni's).
// Patrón estructural de Petro7: numerado por fases, try/catch por fase,
// reportApi/reportDom para diagnóstico cuando algo falla.
//
// Diferencia clave vs Petro7: este NO es httpOnly. La app es un SPA Angular
// y los endpoints internos no están documentados; usamos Playwright con
// selectores estables (id, name) en vez de mat-input-N.

const claudeAgent = require('../claudeAgent');

function makeReportDom(portal) {
  return (page, step, error) =>
    page.content()
      .then(html => claudeAgent.analyzeAndFix({ portal, step, error, html }))
      .then(fix => console.log(`[OTA ${portal}] sugerencia (${JSON.stringify(step)}):`, fix.descripcion))
      .catch(err => console.warn(`[OTA ${portal}] analyzeAndFix falló:`, err.message));
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

// Mapeo de establecimiento → archivo de logo en el DOM. Solo las 7 marcas
// que confirmé en inspección. Si llega una marca distinta dentro del
// dominio Alsea, retornamos failure claro en vez de adivinar.
const BRAND_LOGOS = [
  { keys: ['starbucks'],                       logo: 'logo_starbucks.svg' },
  { keys: ['vips'],                            logo: 'logo_vips.svg' },
  { keys: ['dominos','domino'],                logo: 'logo_dominos.svg' },
  { keys: ['burger king','bk'],                logo: 'logo_burgerking.svg' },
  { keys: ['chilis','chili'],                  logo: 'logo_chilis.svg' },
  { keys: ['p.f. chang','pf chang','pfchang'], logo: 'logo_pfchangs.svg' },
  { keys: ['italianni'],                       logo: 'logo_italiannis.svg' }
];

function logoForEstablecimiento(est) {
  const n = (est || '').toLowerCase();
  for (const b of BRAND_LOGOS) {
    if (b.keys.some(k => n.includes(k))) return b.logo;
  }
  return null;
}

// Angular con formControlName / ngModel necesita que el cambio dispare 'input'
// y 'change'. Playwright.fill solo produce 'input'; sin 'change' el FormGroup
// no marca dirty y la validación no se reactiva.
async function fillAngular(page, selector, value) {
  await page.fill(selector, value);
  await page.dispatchEvent(selector, 'input');
  await page.dispatchEvent(selector, 'change');
}

// Setea un campo del FormGroup por su formControlName. Detecta tag (input vs
// select) y elige fill+events o selectOption+change. Dispara input y change
// siempre para que ngModel marque dirty/touched y reactive validación.
async function setAngularField(page, formControlName, value) {
  const sel = `[formcontrolname="${formControlName}"]`;
  const tag = await page.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.tagName.toLowerCase() : null;
  }, sel);
  if (!tag) throw new Error(`Alsea: campo formControlName="${formControlName}" no encontrado en DOM`);
  if (tag === 'select') {
    await page.selectOption(sel, String(value));
    await page.dispatchEvent(sel, 'change');
  } else {
    await page.fill(sel, String(value));
    await page.dispatchEvent(sel, 'input');
    await page.dispatchEvent(sel, 'change');
  }
}

// Splitea "JUAN PEREZ LOPEZ" → { nombres: "JUAN", apellidos: "PEREZ LOPEZ" }.
// Para 4+ tokens, los últimos 2 son apellidos. Para Persona Moral devuelve
// el nombre completo en nombres y apellidos vacío.
function splitNombre(fullName, esPersonaMoral) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (esPersonaMoral) return { nombres: tokens.join(' '), apellidos: '' };
  if (tokens.length === 0) return { nombres: '', apellidos: '' };
  if (tokens.length === 1) return { nombres: tokens[0], apellidos: '' };
  if (tokens.length === 2) return { nombres: tokens[0], apellidos: tokens[1] };
  return { nombres: tokens.slice(0, -2).join(' '), apellidos: tokens.slice(-2).join(' ') };
}

// El form pide dd/mm/aaaa. La solicitud puede traer YYYY-MM-DD o DD/MM/YYYY.
function formatFechaDDMMYYYY(s) {
  if (!s) return '';
  s = String(s).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[1].padStart(2,'0') + '/' + m[2].padStart(2,'0') + '/' + m[3];
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return s;
}

async function ejecutar(page, perfil, ticketData, solicitudId) {
  const reportDom = makeReportDom('alsea');
  const reportApi = makeReportApi('alsea');

  // Capturar errores de XHR de Angular en background — los reporta a Claude
  // sin bloquear el flujo. Filtra solo /api/ del propio dominio (no GA).
  page.on('response', async (resp) => {
    try {
      const url = resp.url();
      if (url.includes('alsea.interfactura.com/api/') && resp.status() >= 400) {
        const body = await resp.text().catch(() => '');
        reportApi(url, null, {
          response: { status: resp.status(), data: body.substring(0, 1000) },
          message: 'XHR ' + resp.status()
        });
      }
    } catch {}
  });

  // 1. Seleccionar marca
  const logo = logoForEstablecimiento(ticketData.establecimiento);
  if (!logo) {
    return { success: false, mensaje: `Alsea: marca no soportada — establecimiento="${ticketData.establecimiento}" no matchea ninguna marca con logo en el portal` };
  }
  const brandSel = `.billing_brand_selection img[src*="${logo}"]`;
  try {
    await page.waitForSelector(brandSel, { timeout: 10000 });
    await page.click(brandSel);
    await page.waitForTimeout(1500);
  } catch (e) {
    reportDom(page, { action: 'select_brand', logo }, e.message);
    return { success: false, mensaje: `Alsea: no se pudo seleccionar marca ${logo} — ${e.message}` };
  }

  // 2. Esperar a que un billing_form se haga visible y detectar variant
  let formVariant;
  try {
    await page.waitForFunction(() => {
      const forms = document.querySelectorAll('form.billing_form');
      for (const f of forms) if (f.offsetParent !== null) return true;
      return false;
    }, { timeout: 10000 });
    formVariant = await page.evaluate(() => {
      const visible = Array.from(document.querySelectorAll('form.billing_form'))
        .find(f => f.offsetParent !== null);
      if (!visible) return null;
      if (visible.querySelector('[formcontrolname="tienda"]')) return 'tienda_fecha';
      if (visible.querySelector('[formcontrolname="monto"]'))  return 'total';
      return null;
    });
  } catch (e) {
    reportDom(page, { action: 'detect_form_variant' }, e.message);
    return { success: false, mensaje: 'Alsea: form no apareció tras seleccionar marca — ' + e.message };
  }
  if (!formVariant) {
    return { success: false, mensaje: 'Alsea: form visible pero no se detectó variant (sin #tienda ni #total)' };
  }
  console.log(`[AUTO] Alsea — marca=${logo} variant=${formVariant}`);

  // 3. Llenar campos del paso 1
  const ticket = ticketData.numero_ticket || ticketData.folio || '';
  const tienda = ticketData.numero_tienda || '';
  const fecha  = formatFechaDDMMYYYY(ticketData.fecha_compra || ticketData.fecha_formateada);
  const total  = ticketData.total != null ? String(ticketData.total) : '';

  try {
    await fillAngular(page, 'input[formcontrolname="rfc"]', perfil.rfc);
    await fillAngular(page, 'input[formcontrolname="ticket"]', ticket);
    if (formVariant === 'tienda_fecha') {
      if (!tienda) {
        return { success: false, mensaje: 'Alsea: marca requiere numero_tienda y el ticket no lo trae extraído' };
      }
      await fillAngular(page, 'input[formcontrolname="tienda"]', tienda);
      // Fecha: probar formControlName primero, fallback a la clase .txFecha
      // que algunas marcas usan (datepicker custom de Alsea).
      const fechaSel = (await page.$('input[formcontrolname="fecha"]'))
        ? 'input[formcontrolname="fecha"]'
        : 'input.txFecha';
      await fillAngular(page, fechaSel, fecha);
    } else {
      if (!total) {
        return { success: false, mensaje: 'Alsea: marca requiere total y el ticket no lo trae' };
      }
      await fillAngular(page, 'input[formcontrolname="monto"]', total);
    }
  } catch (e) {
    reportDom(page, { action: 'fill_paso1', formVariant }, e.message);
    return { success: false, mensaje: 'Alsea: error llenando paso 1 — ' + e.message };
  }

  // 4. Submit paso 1 (Enviar del form visible)
  try {
    await page.evaluate(() => {
      const visForm = Array.from(document.querySelectorAll('form.billing_form'))
        .find(f => f.offsetParent !== null);
      const btn = visForm && visForm.querySelector('button[type=submit]');
      if (btn) btn.click();
    });
    await page.waitForTimeout(3500);
  } catch (e) {
    reportDom(page, { action: 'submit_paso1' }, e.message);
    return { success: false, mensaje: 'Alsea: error en submit paso 1 — ' + e.message };
  }

  // 5. Detectar resultado del paso 1
  const estado = await page.evaluate(() => {
    const popup = document.querySelector('#popup');
    const popupVisible = popup && popup.offsetParent !== null;
    const popupText = popupVisible ? (popup.innerText || '').substring(0, 500) : '';
    return {
      popupVisible, popupText,
      hasRegimen: !!document.querySelector('[formcontrolname="regimenFiscal"]'),
      hasUsoCfdi: !!document.querySelector('[formcontrolname="usoCfdi"]'),
      hasEmail:   !!document.querySelector('[formcontrolname="correoElectronico"]'),
      bodyText: document.body.innerText.substring(0, 600)
    };
  });

  if (estado.popupVisible && /error|inv[áa]lid|incorrect|no\s+(existe|encontrad)/i.test(estado.popupText)) {
    return { success: false, mensaje: 'Alsea: rechazado en paso 1 — ' + estado.popupText.substring(0, 200) };
  }

  // 6. Paso 2 — datos fiscales (aparece como continuación o modal)
  if (estado.hasRegimen && estado.hasUsoCfdi && estado.hasEmail) {
    try {
      // persona: 'F' (Física, RFC 13 chars) o 'M' (Moral, RFC 12 chars).
      // El bundle Angular auto-deriva esto del RFC, pero lo seteamos
      // explícito por si el evento de input no llegó a disparar la lógica.
      const personaCode = (perfil.rfc || '').length === 13 ? 'F' : 'M';
      const esMoral = personaCode === 'M';
      const { nombres, apellidos } = splitNombre(perfil.nombre_sat || perfil.nombre || '', esMoral);

      await setAngularField(page, 'persona', personaCode);
      await setAngularField(page, 'nombres', nombres);
      if (apellidos) await setAngularField(page, 'apellidos', apellidos);
      await setAngularField(page, 'codigoPostal', perfil.cp || '');
      await setAngularField(page, 'regimenFiscal', perfil.regimen || '612');
      await setAngularField(page, 'usoCfdi', perfil.uso_cfdi || 'G03');
      await setAngularField(page, 'correoElectronico', perfil.email || '');

      // Submit paso 2 — el último botón submit visible
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button[type=submit], input[type=submit]'))
          .filter(b => b.offsetParent !== null);
        if (btns.length) btns[btns.length - 1].click();
      });
      await page.waitForTimeout(5000);
    } catch (e) {
      reportDom(page, { action: 'paso2_datos_fiscales' }, e.message);
      return { success: false, mensaje: 'Alsea: error en paso 2 — ' + e.message };
    }
  } else {
    console.log(`[AUTO] Alsea — paso 2 no detectado (regimen=${estado.hasRegimen} uso=${estado.hasUsoCfdi} email=${estado.hasEmail}); puede que Alsea use formato distinto`);
  }

  // 7. Verificar éxito final
  await page.waitForTimeout(2000);
  const final = await page.evaluate(() => {
    const text = (document.body.innerText || '').toLowerCase();
    return {
      success: /factura.*generad|cfdi.*generad|exitosa|enviad.*correo|descarga|xml.*pdf/i.test(text),
      url: location.href,
      snippet: (document.body.innerText || '').substring(0, 400)
    };
  });

  if (final.success) {
    return { success: true, mensaje: `Factura Alsea generada (${ticketData.establecimiento})` };
  }
  return { success: false, mensaje: `Alsea: completado paso 2 pero éxito no detectado. URL=${final.url}. Snippet: ${final.snippet.substring(0, 150)}` };
}

module.exports = { ejecutar };
