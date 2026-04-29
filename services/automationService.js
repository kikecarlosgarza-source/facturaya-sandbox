óíconst { chromium } = require('playwright');
const db = require('../db/database');

const PORTALES = {
      'home depot': {
              url: 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb',
              async ejecutar(page, perfil, ticketData) {
                        // Paso 1: llenar RFC y ticket
                await page.waitForSelector('#rfc', { timeout: 20000 });
                        await page.fill('#rfc', perfil.rfc);
                        await page.fill('#ticket', ticketData.folio);
                        console.log('[AUTO] RFC y ticket llenados');

                // Esperar captcha Cloudflare
                await page.waitForTimeout(4000);

                // Click en boton Continuar (btn-primary)
                await page.click('button.btn-primary', { timeout: 15000 });
                        console.log('[AUTO] Click Continuar');
                        await page.waitForTimeout(4000);

                // Paso 2: llenar datos fiscales
                try {
                            // Tomar screenshot para debug
                          const html = await page.content();
                            console.log('[AUTO] HTML paso 2 (primeros 500 chars):', html.substring(0, 500));

                          // Buscar campos de la segunda pantalla
                          const inputs = await page.$$('input:not([type="hidden"])');
                            console.log('[AUTO] Inputs encontrados en paso 2:', inputs.length);

                          // Email
                          const campoEmail = await page.$('input[type="email"], input[placeholder*="correo"], input[placeholder*="Correo"], input[placeholder*="mail"]');
                            if (campoEmail) { await campoEmail.fill(perfil.email); console.log('[AUTO] Email llenado'); }

                          // Nombre
                          const campoNombre = await page.$('input[placeholder*="Nombre"], input[placeholder*="nombre"], input[placeholder*="Razon"], input[placeholder*="razon"]');
                            if (campoNombre) { await campoNombre.fill(perfil.nombre); console.log('[AUTO] Nombre llenado'); }

                          // CP
                          const campoCP = await page.$('input[placeholder*="Postal"], input[placeholder*="postal"], input[placeholder*="CP"], input[placeholder*="C.P"]');
                            if (campoCP) { await campoCP.fill(perfil.cp); console.log('[AUTO] CP llenado'); }

                          // Selects de regimen y uso
                          const selects = await page.$$('select');
                            console.log('[AUTO] Selects encontrados:', selects.length);
                            if (selects.length >= 1) await selects[0].selectOption({ value: perfil.regimen || '612' });
                            if (selects.length >= 2) await selects[1].selectOption({ value: perfil.uso_cfdi || 'G03' });

                          await page.waitForTimeout(1000);

                          // Click en boton de envio (btn-primary en paso 2)
                          await page.click('button.btn-primary', { timeout: 15000 });
                            console.log('[AUTO] Click enviar factura');
                            await page.waitForTimeout(5000);

                          const textoFinal = await page.textContent('body');
                            console.log('[AUTO] Texto final:', textoFinal.substring(0, 300));

                          if (textoFinal.includes('exitosa') || textoFinal.includes('generada') || textoFinal.includes('enviada') || textoFinal.includes('correo') || textoFinal.includes('PDF')) {
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

  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando', solicitudId);

  const browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
          const context = await browser.newContext({
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    viewport: { width: 1280, height: 800 }
          });
          const page = await context.newPage();

        console.log('[AUTO] Navegando a:', portal.url);
          await page.goto(portal.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(3000);

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
