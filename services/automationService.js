const { chromium } = require('playwright');
const portalsData  = require('../portals/portals.json');

class PortalAutomationService {

  detectarPortal(ticketData) {
  if (ticketData.url_facturacion && ticketData.url_facturacion.includes('autoInvoicing')) {
    return { portal: { name: 'Wansoft', automation: { flow: [], base_url: ticketData.url_facturacion, requires_account: false } }, url_directa: ticketData.url_facturacion };
  }
    const {
      establecimiento = '',
      rfc_emisor = '',
      url_facturacion = ''
    } = ticketData;

    const texto = `${establecimiento} ${rfc_emisor} ${url_facturacion}`.toLowerCase();

    if (url_facturacion) {
      for (const portal of portalsData.portals) {
        // FIX: portales sin url_pattern no crashean
        if (portal.url_pattern && url_facturacion.includes(portal.url_pattern)) {
          return { portal, url_directa: url_facturacion };
        }
      }
    }

    for (const portal of portalsData.portals) {
      const { detection } = portal;
      if (!detection) continue; // FIX: portales sin detection no crashean

      const keywords = detection.ticket_keywords || [];
      const rfcKeys  = detection.rfc_keywords    || [];

      if (keywords.some(k => texto.includes(k.toLowerCase()))) {
        return { portal, url_directa: null };
      }
      if (rfcKeys.some(r => rfc_emisor.includes(r))) {
        return { portal, url_directa: null };
      }
    }

    return null;
  }

  async solicitarFactura(ticketData, perfilFiscal, portalInfo) {
    const { portal, url_directa } = portalInfo;

    // FIX: normalizar requires_account y requires_membership (costco usa el segundo)
    const requiereCuenta = portal.automation.requires_account || portal.automation.requires_membership;
    if (requiereCuenta) {
      return {
        success: false,
        requiere_cuenta: true,
        mensaje: `El portal de ${portal.name} requiere una cuenta registrada. No es posible automatizar sin credenciales.`,
        portal_url: portal.automation.base_url
      };
    }

    // Flujo directo para URLs de Wansoft autoInvoicing (vienen del QR)
    if (ticketData.portal_url && ticketData.portal_url.includes('autoInvoicing')) {
      let browser2;
      try {
        browser2 = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const ctx2 = await browser2.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' });
        const page2 = await ctx2.newPage();
        page2.setDefaultTimeout(60000);
        const resultado = await procesarWansoftAutoInvoicing(page2, ticketData.portal_url, ticketData, perfil);
        await browser2.close();
        if (resultado.exito) return { success: true, folio: resultado.folio, cfdi_uuid: resultado.folio };
        return { success: false, mensaje: resultado.error || 'Error en portal Wansoft' };
      } catch(e) {
        if (browser2) await browser2.close().catch(()=>{});
        return { success: false, mensaje: 'Error Wansoft: ' + e.message };
      }
    }

    // FIX: portales con flow vacío avisan en lugar de proceder sin hacer nada
    if (!portal.automation.flow || portal.automation.flow.length === 0) {
      return {
        success: false,
        requiere_cuenta: false,
        mensaje: `El portal de ${portal.name} aún no tiene flujo de automatización configurado. Visita el portal manualmente.`,
        portal_url: portal.automation.base_url
      };
    }

    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--dns-prefetch-disable', '--no-sandbox', '--disable-setuid-sandbox'] });
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        viewport: { width: 390, height: 844 }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(60000);

      const url = url_directa || portal.automation.base_url;
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const resultado = await this._ejecutarFlujo(page, portal.automation.flow, ticketData, perfilFiscal);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });

      return {
        success: resultado.success,
        mensaje: resultado.mensaje,
        screenshot: screenshot.toString('base64'),
        portal_nombre: portal.name
      };

    } catch (err) {
      console.error('Error en automatización:', err.message);
      return {
        success: false,
        mensaje: `Error al procesar el portal: ${err.message}`,
        error: err.message
      };
    } finally {
      if (browser) await browser.close();
    }
  }

  async _ejecutarFlujo(page, flow, ticketData, perfil) {
    const vars = {
      '{{rfc}}':      perfil.rfc,
      '{{email}}':    perfil.email,
      '{{nombre}}':   perfil.nombre,
      '{{cp}}':       perfil.cp,
      '{{regimen}}':  perfil.regimen,
      '{{uso_cfdi}}': perfil.uso_cfdi,
      '{{folio}}':    ticketData.folio || '',
      '{{total}}':    String(ticketData.total || ''),
      '{{fecha}}':    ticketData.fecha || '',
      '{{tienda}}':   ticketData.establecimiento || '',
      '{{codigo}}':   ticketData.codigo_facturacion || ''
    };

    const resolver = (val) => {
      if (!val) return val;
      return Object.keys(vars).reduce((acc, k) => acc.replace(k, vars[k]), val);
    };

    for (const step of flow) {
      try {
        // FIX: if/else en lugar de switch con const — evita SyntaxError en strict mode
        if (step.action === 'navigate') {
          const navUrl = step.target === 'ticket_url'
            ? ticketData.url_facturacion
            : resolver(step.target);
          await page.goto(navUrl, { waitUntil: 'domcontentloaded' });

        } else if (step.action === 'fill') {
          await page.waitForSelector(step.selector, { timeout: 10000 });
          await page.fill(step.selector, resolver(step.value));

        } else if (step.action === 'select') {
          await page.waitForSelector(step.selector, { timeout: 10000 });
          await page.selectOption(step.selector, resolver(step.value));

        } else if (step.action === 'click') {
          await page.waitForSelector(step.selector, { timeout: 10000 });
          await page.click(step.selector);

        } else if (step.action === 'wait') {
          await page.waitForTimeout(step.ms || 2000);

        } else if (step.action === 'wait_selector') {
          await page.waitForSelector(step.selector, { timeout: 15000 });

        } else if (step.action === 'js_select') {
          await page.evaluate(({sel, val}) => {
            const el = document.querySelector(sel);
            if (el) { el.value = val; $(el).selectpicker('val', val); $(el).trigger('change'); }
          }, {sel: step.selector, val: resolver(step.value)});

        } else if (step.action === 'wait_success') {
          await page.waitForTimeout(3000);
          const pageText = await page.textContent('body');
          const exitosos = ['factura generada', 'cfdi generado', 'enviado a tu correo', 'descarga', 'éxito', 'exitoso', 'xml'];
          if (exitosos.some(e => pageText.toLowerCase().includes(e))) {
            // FIX: retornar de inmediato al detectar éxito en lugar de continuar el loop
            return { success: true, mensaje: 'Factura solicitada exitosamente. Revisa tu correo.' };
          }
        }

      } catch (stepErr) {
        console.warn(`Paso falló [${step.action} ${step.selector || ''}]:`, stepErr.message);
      }
    }

    return { success: true, mensaje: 'Flujo completado. Revisa tu correo para la factura.' };
  }

  async solicitarFacturaURLDirecta(url, ticketData, perfil) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true, args: ['--dns-prefetch-disable', '--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await (await browser.newContext()).newPage();
      page.setDefaultTimeout(60000);

      await page.goto(url, { waitUntil: 'domcontentloaded' });

      const camposRFC    = ['input[name*="rfc" i]', 'input[id*="rfc" i]', 'input[placeholder*="RFC" i]'];
      const camposEmail  = ['input[type="email"]', 'input[name*="email" i]', 'input[id*="email" i]', 'input[name*="correo" i]'];
      const camposCP     = ['input[name*="postal" i]', 'input[id*="cp" i]', 'input[name*="cp" i]', 'input[placeholder*="postal" i]'];
      const camposNombre = ['input[name*="razon" i]', 'input[id*="razon" i]', 'input[name*="nombre" i]', 'input[id*="nombre" i]'];

      for (const sel of camposRFC)    { try { await page.fill(sel, perfil.rfc);    break; } catch(e) {} }
      for (const sel of camposEmail)  { try { await page.fill(sel, perfil.email);  break; } catch(e) {} }
      for (const sel of camposCP)     { try { await page.fill(sel, perfil.cp);     break; } catch(e) {} }
      for (const sel of camposNombre) { try { await page.fill(sel, perfil.nombre); break; } catch(e) {} }

      const regimenSels = ['select[name*="regimen" i]', 'select[id*="regimen" i]'];
      for (const sel of regimenSels) { try { await page.selectOption(sel, perfil.regimen);  break; } catch(e) {} }

      const usoSels = ['select[name*="uso" i]', 'select[id*="uso" i]', 'select[name*="cfdi" i]'];
      for (const sel of usoSels)     { try { await page.selectOption(sel, perfil.uso_cfdi); break; } catch(e) {} }

      await page.waitForTimeout(1000);

      const submitSels = [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Generar")',
        'button:has-text("Facturar")',
        'button:has-text("Solicitar")',
        'button:has-text("Siguiente")',
        'button:has-text("Continuar")'
      ];
      for (const sel of submitSels) { try { await page.click(sel); break; } catch(e) {} }

      await page.waitForTimeout(3000);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 80 });
      const bodyText   = await page.textContent('body').catch(() => '');

      const exitosos = ['factura generada', 'cfdi generado', 'enviado', 'correo', 'descarga', 'éxito', 'xml'];
      const success  = exitosos.some(e => bodyText.toLowerCase().includes(e));

      return {
        success,
        mensaje: success
          ? 'Factura solicitada. Revisa tu correo en unos minutos.'
          : 'El portal fue abierto. Puede requerir un paso manual adicional.',
        screenshot: screenshot.toString('base64')
      };

    } finally {
      if (browser) await browser.close();
    }
  }
}


async function procesarWansoftAutoInvoicing(page, portalUrl, ticketData, perfil) {
  // Navegar a la URL del QR directamente
  await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
  
  // Hacer clic en buscar
  await page.click('.btn-search-inv');
  await page.waitForTimeout(3000);
  
  // Llenar datos del receptor
  await page.fill('#rfc', perfil.rfc);
  await page.fill('#legalName', perfil.nombre);
  await page.fill('#email', perfil.email);
  await page.fill('#CP', perfil.cp);
  
  // Seleccionar régimen
  await page.selectOption('#receiverFiscalRegime', perfil.regimen || '612');
  await page.selectOption('#ReceiverCfdiUse', perfil.uso_cfdi || 'G03');
  
  // Emitir factura
  await page.click('input[id="btnIssueInvoice"]');
  await page.waitForTimeout(5000);
  
  // Verificar éxito
  const mensaje = await page.$('.ui-dialog-content, #mensaje, .alert');
  const texto = await mensaje?.textContent() || '';
  
  if (texto.includes('exitosamente') || texto.includes('generó')) {
    const folio = await page.$eval('#FolioFiscal, td:contains("Folio")', el => el.textContent).catch(() => '');
    return { exito: true, folio: folio.trim() };
  }
  
  return { exito: false, error: texto };
}

module.exports = new PortalAutomationService();
