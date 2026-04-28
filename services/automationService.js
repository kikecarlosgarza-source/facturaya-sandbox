const { chromium } = require('playwright');
const db = require('../db/database');

const PORTALES = {
    'home depot': {
          url: 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb',
          async ejecutar(page, perfil, ticketData) {
                  // Paso 1: llenar RFC y ticket
            await page.waitForSelector('#rfc', { timeout: 15000 });
                  await page.fill('#rfc', perfil.rfc);
                  await page.fill('#ticket', ticketData.folio);

            // Esperar que el captcha Cloudflare se resuelva solo
            await page.waitForTimeout(3000);

            // Click Continuar
            await page.click('button:has-text("Continuar"), input[value="Continuar"], .btn-continuar');
                  await page.waitForTimeout(3000);

            // Paso 2: llenar datos fiscales en la siguiente pantalla
            try {
                      // Nombre/Razon social
                    const campoNombre = await page.$('input[placeholder*="Nombre"], input[placeholder*="nombre"], input[placeholder*="Razón"], #nombre, #razonSocial');
                      if (campoNombre) await campoNombre.fill(perfil.nombre);

                    // CP
                    const campoCP = await page.$('input[placeholder*="Postal"], input[placeholder*="postal"], #cp, #codigoPostal');
                      if (campoCP) await campoCP.fill(perfil.cp);

                    // Email
                    const campoEmail = await page.$('input[type="email"], input[placeholder*="correo"], input[placeholder*="email"], #email');
                      if (campoEmail) await campoEmail.fill(perfil.email);

                    // Regimen fiscal - buscar select o dropdown
                    const selectRegimen = await page.$('select[name*="regimen"], select[id*="regimen"], select[id*="Regimen"]');
                      if (selectRegimen) await selectRegimen.selectOption({ value: perfil.regimen || '612' });

                    // Uso CFDI
                    const selectUso = await page.$('select[name*="uso"], select[id*="uso"], select[id*="Uso"]');
                      if (selectUso) await selectUso.selectOption({ value: perfil.uso_cfdi || 'G03' });

                    await page.waitForTimeout(1000);

                    // Click en Generar/Facturar
                    await page.click('button:has-text("Facturar"), button:has-text("Generar"), button:has-text("Solicitar"), .btn-facturar');
                      await page.waitForTimeout(5000);

                    // Verificar exito
                    const textoExito = await page.textContent('body');
                      if (textoExito.includes('exitosa') || textoExito.includes('generada') || textoExito.includes('enviada') || textoExito.includes('correo')) {
                                  return { success: true, mensaje: 'Factura generada exitosamente' };
                      }
            } catch (e) {
                      console.log('[AUTO] Error en paso 2:', e.message);
            }

            return { success: false, mensaje: 'Proceso parcial - verifica en el portal' };
          }
    }
};

function detectarPortal(establecimiento) {
    if (!establecimiento) return null;
    const n = establecimiento.toLowerCase();
    for (const [key, config] of Object.entries(PORTALES)) {
          if (n.includes(key)) return { key, ...config };
    }
    return null;
}

async function procesarFactura(solicitudId) {
    // Obtener datos de la solicitud y perfil
  const solicitud = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
    if (!solicitud) throw new Error('Solicitud no encontrada');

  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(solicitud.usuario_id);
    if (!perfil) throw new Error('Perfil fiscal no configurado');

  const portal = detectarPortal(solicitud.establecimiento);
    if (!portal) {
          db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
            .run('manual', 'Portal no soportado aun', solicitudId);
          return { success: false, manual: true };
    }

  // Actualizar status a procesando
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando', solicitudId);

  const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
        const context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                viewport: { width: 390, height: 844 }
        });
        const page = await context.newPage();

      console.log('[AUTO] Navegando a:', portal.url);
        await page.goto(portal.url, { waitUntil: 'networkidle', timeout: 30000 });

      const ticketData = {
              folio: solicitud.folio,
              establecimiento: solicitud.establecimiento,
              total: solicitud.total
      };

      const resultado = await portal.ejecutar(page, perfil, ticketData);

      if (resultado.success) {
              db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                .run('completado', resultado.mensaje, solicitudId);
      } else {
              db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                .run('manual', resultado.mensaje, solicitudId);
      }

      return resultado;
  } catch (e) {
        console.error('[AUTO] Error:', e.message);
        db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
          .run('error', e.message.substring(0, 200), solicitudId);
        return { success: false, error: e.message };
  } finally {
        await browser.close();
  }
}

module.exports = { procesarFactura, detectarPortal };
