const { chromium } = require('playwright');
const db = require('../db/database');
const path = require('path');
const fs = require('fs');

// Directorio para guardar captchas
const CAPTCHA_DIR = '/data/captchas';
try { fs.mkdirSync(CAPTCHA_DIR, { recursive: true }); } catch(e) {}

const PORTALES = {
        'home depot': {
                  url: 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb',
                  async ejecutar(page, perfil, ticketData) {
                              await page.waitForSelector('#rfc', { timeout: 20000 });
                              await page.fill('#rfc', perfil.rfc);
                              await page.fill('#ticket', ticketData.folio);
                              console.log('[AUTO] RFC y ticket llenados');
                              await page.waitForTimeout(4000);
                              await page.click('button.btn-primary', { timeout: 15000 });
                              console.log('[AUTO] Click Continuar');
                              await page.waitForTimeout(4000);
                              try {
                                            const inputs = await page.$$('input:not([type="hidden"])');
                                            console.log('[AUTO] Inputs en paso 2:', inputs.length);
                                            const campoEmail = await page.$('input[type="email"], input[placeholder*="correo"], input[placeholder*="Correo"]');
                                            if (campoEmail) await campoEmail.fill(perfil.email);
                                            const campoNombre = await page.$('input[placeholder*="Nombre"], input[placeholder*="nombre"]');
                                            if (campoNombre) await campoNombre.fill(perfil.nombre);
                                            const campoCP = await page.$('input[placeholder*="Postal"], input[placeholder*="postal"]');
                                            if (campoCP) await campoCP.fill(perfil.cp);
                                            const selects = await page.$$('select');
                                            if (selects.length >= 1) await selects[0].selectOption({ value: perfil.regimen || '612' }).catch(() => {});
                                            if (selects.length >= 2) await selects[1].selectOption({ value: perfil.uso_cfdi || 'G03' }).catch(() => {});
                                            await page.waitForTimeout(1000);
                                            await page.click('button.btn-primary', { timeout: 15000 });
                                            await page.waitForTimeout(5000);
                                            const texto = await page.textContent('body');
                                            if (texto.includes('exitosa') || texto.includes('generada') || texto.includes('correo')) {
                                                            return { success: true, mensaje: 'Factura generada exitosamente' };
                                            }
                              } catch (e) {
                                            console.log('[AUTO] Error paso 2:', e.message);
                              }
                              return { success: false, mensaje: 'Proceso parcial - verifica en portal' };
                  }
        },

        'petro': {
                  url: 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/',
                  async ejecutar(page, perfil, ticketData, solicitudId) {
                              // Click en Factura Express
                    await page.waitForSelector('input[value="FACTURA EXPRESS"], .btn:has-text("FACTURA EXPRESS")', { timeout: 15000 });
                              await page.click('input[value="FACTURA EXPRESS"], .btn:has-text("FACTURA EXPRESS")');
                              await page.waitForTimeout(2000);

                    // Llenar datos del ticket
                    await page.fill('[name="noEstacion"]', ticketData.estacion || '');
                              await page.fill('[name="noTicket"]', ticketData.folio || '');
                              await page.fill('[name="wid"]', ticketData.web_id || '');

                    // Fecha del ticket - formato MM/DD/YYYY
                    const fechaInput = await page.$('.md-datepicker-input');
                              if (fechaInput) {
                                            await fechaInput.click();
                                            await fechaInput.fill(ticketData.fecha_formateada || '');
                              }

                    // Click Agregar Ticket
                    await page.click('button:has-text("Agregar Ticket"), input[value="Agregar Ticket"]');
                              await page.waitForTimeout(2000);

                    // Datos fiscales
                    await page.fill('[name="rfc"]', perfil.rfc);
                              await page.fill('[name="nombre"]', perfil.nombre);

                    // Regimen fiscal (select nativo)
                    const selectRegimen = await page.$('select[name="regimenFiscal"], select:nth-of-type(1)');
                              if (selectRegimen) await selectRegimen.selectOption({ value: perfil.regimen || '612' });

                    // Uso CFDI
                    const selectUso = await page.$('select[name="usoCFDI"], select:nth-of-type(2)');
                              if (selectUso) await selectUso.selectOption({ value: perfil.uso_cfdi || 'G03' });

                    // CP y Correo
                    await page.fill('[name="cp"]', perfil.cp);
                              await page.fill('[name="correo"]', perfil.email);

                    // Tomar screenshot del captcha y guardarlo
                    const captchaEl = await page.$('.captcha-img, img[src*="captcha"], #captchaImg');
                              const captchaPath = path.join(CAPTCHA_DIR, `${solicitudId}.png`);
                              if (captchaEl) {
                                            await captchaEl.screenshot({ path: captchaPath });
                                            console.log('[AUTO] Captcha guardado:', captchaPath);
                              } else {
                                            // Screenshot del area de captcha
                                await page.screenshot({ path: captchaPath, clip: { x: 200, y: 850, width: 400, height: 120 } });
                              }

                    // Actualizar DB con status captcha_required
                    db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                                .run('captcha_required', captchaPath, solicitudId);

                    return { success: false, captcha_required: true, captcha_path: captchaPath };
                  }
        }
};

// Mapa de establecimiento -> clave de portal
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
                      estacion: solicitud.estacion || '',
                      web_id: solicitud.web_id || '',
                      fecha_formateada: solicitud.fecha_compra || '',
                      establecimiento: solicitud.establecimiento,
                      total: solicitud.total
          };

          const resultado = await portal.ejecutar(page, perfil, ticketData, solicitudId);

          if (resultado.success) {
                      db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                        .run('completado', resultado.mensaje, solicitudId);
          } else if (!resultado.captcha_required) {
                      db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                        .run('manual', resultado.mensaje || 'Proceso parcial', solicitudId);
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

// Enviar captcha resuelto por el usuario
async function enviarCaptcha(solicitudId, captchaTexto) {
        const solicitud = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
        if (!solicitud || solicitud.status !== 'captcha_required') {
                  throw new Error('Solicitud no en espera de captcha');
        }

  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(solicitud.usuario_id);
        const portal = detectarPortal(solicitud.establecimiento);
                if (!portal) throw new Error('Portal no encontrado: ' + solicitud.establecimiento);

                // Resolver el captcha pendiente via el mecanismo del portal
                console.log('[CAPTCHA] Resolviendo captcha para solicitud', solicitudId);
                db.prepare("UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?")
                    }

module.exports = { procesarFactura, enviarCaptcha, detectarPortal };
