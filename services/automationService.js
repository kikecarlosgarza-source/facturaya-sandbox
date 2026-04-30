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
                                        return await facturarHomedepotAPI(perfil, ticketData);
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
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  try {
            const context = await browser.newContext({
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        viewport: { width: 1280, height: 800 }
            });
            const page = await context.newPage();
                          // Ocultar que es Playwright para evitar detección de Cloudflare
                          await page.addInitScript(() => {
                                                      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                                                      window.chrome = { runtime: {} };
                          });
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
            console.log('[CAPTCHA] Captcha recibido para solicitud', solicitudId);

        // ============ HOME DEPOT API DIRECTO (sin Playwright) ============
        const axios = require('axios');
        const HD_BASE = 'https://facturacion.homedepot.com.mx:2053/CFDiConnectFacturacion/facturacion/';
        const HD_SITEKEY = '0x4AAAAAAB6nsteTRVZ39dGq';
        const CAPSOLVER_KEY = process.env.CAPSOLVER_API_KEY || '';

        async function resolverTurnstileHD() {
                    if (!CAPSOLVER_KEY) throw new Error('CAPSOLVER_API_KEY no configurado');
                    console.log('[HD-API] Resolviendo Turnstile con CapSolver...');
                    // Crear tarea
                    const crear = await axios.post('https://api.capsolver.com/createTask', {
                                    clientKey: CAPSOLVER_KEY,
                                    task: {
                                                        type: 'AntiTurnstileTaskProxyLess',
                                                        websiteURL: 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/',
                                                        websiteKey: HD_SITEKEY
                                    }
                    });
                    const taskId = crear.data.taskId;
                    if (!taskId) throw new Error('CapSolver no retorno taskId: ' + JSON.stringify(crear.data));
                    // Esperar resultado
                    for (let i = 0; i < 30; i++) {
                                    await new Promise(r => setTimeout(r, 2000));
                                    const resultado = await axios.post('https://api.capsolver.com/getTaskResult', {
                                                        clientKey: CAPSOLVER_KEY,
                                                        taskId
                                    });
                                    if (resultado.data.status === 'ready') {
                                                        console.log('[HD-API] Turnstile resuelto!');
                                                        return resultado.data.solution.token;
                                    }
                    }
                    throw new Error('CapSolver timeout - no resolvio el Turnstile');
        }

        async function facturarHomedepotAPI(perfil, ticketData) {
                    const headers = {
                                    'Content-Type': 'application/json',
                                    'Origin': 'https://facturacion.homedepot.com.mx:2053',
                                    'Referer': 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/',
                                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    };
                    const rfc = perfil.rfc;
                    const ticket = (ticketData.folio || '').replace(/\s/g, '');
                    console.log('[HD-API] Iniciando flujo API para RFC:', rfc, 'Ticket:', ticket);
                    // 1. Validar estado cliente
                    await axios.get(HD_BASE + 'validarEstadoCliente?rfcCliente=' + rfc, { headers });
                    console.log('[HD-API] Cliente valido');
                    // 2. Resolver Turnstile y validar
                    const token = await resolverTurnstileHD();
                    await axios.post(HD_BASE + 'validarRecaptcha', { recaptchaToken: token }, { headers });
                    console.log('[HD-API] Turnstile validado');
                    // 3. Agregar ticket
                    const ticketResp = await axios.get(HD_BASE + 'agregarTicket?noTicket=' + ticket, { headers });
                    const ticketInfo = ticketResp.data;
                    console.log('[HD-API] Ticket encontrado, tienda:', ticketInfo.tienda);
                    // 4. Verificar comprobante previo
                    await axios.get(HD_BASE + 'verificarComprobantePrevio?rfcReceptor=' + rfc + '&noTicket=' + ticket, { headers });
                    // 5. Obtener cliente por RFC
                    const clienteResp = await axios.get(HD_BASE + 'getClientePorRFC?rfcCliente=' + rfc, { headers });
                    const cliente = clienteResp.data;
                    console.log('[HD-API] Cliente ID:', cliente.id);
                    // 6. Obtener tienda
                    const tiendaResp = await axios.get(HD_BASE + 'obtenerTiendaPorNumero?noTienda=' + ticketInfo.tienda, { headers });
                    const tienda = tiendaResp.data;
                    // 7. Obtener serie
                    const serieResp = await axios.get(HD_BASE + 'indexSerieTienda?idTienda=' + tienda.id + '&tipoDocumento=FACTURA', { headers });
                    const serie = serieResp.data[0];
                    console.log('[HD-API] Serie:', serie.nombre, 'ID:', serie.id);
                    // 8. Timbrar
                    const payload = {
                                    tipoComprobante: serie.nombre,
                                    tipoDocumento: 'I',
                                    serieId: '1',
                                    serieTiendaId: String(serie.id),
                                    fechaEmision: new Date().toISOString().replace('T', ' ').substring(0, 19),
                                    rfcEmisor: tienda.emisorRfc || 'HDM001017AS1',
                                    rfcReceptor: rfc,
                                    nombreReceptor: cliente.nombre,
                                    regimenReceptor: cliente.claveRegimenFiscal || perfil.regimen || '612',
                                    domicilioReceptor: cliente.codigoPostal || perfil.cp,
                                    usoCFDI: cliente.claveUsoCfdi || perfil.uso_cfdi || 'G03',
                                    correo: cliente.correo || perfil.email,
                                    metodoPago: ticketInfo.metodoPagoInfo?.metodoPago || 'PUE',
                                    formaPago: ticketInfo.metodoPagoInfo?.tipoPago?.formaPago || '28',
                                    condicionesPago: 'PAGADO',
                                    moneda: 'MXN',
                                    tipoCambio: 1,
                                    exportacion: '01',
                                    lugarExpedicion: tienda.codigoPostal || '66269',
                                    subTotal: ticketInfo.conceptos?.reduce((s, c) => s + c.importe, 0) || 0,
                                    total: ticketInfo.metodoPagoInfo?.totalTicket || 0,
                                    totalDocumento: ticketInfo.metodoPagoInfo?.totalTicket |
            db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
                .run('procesando', 'Captcha enviado', solicitudId);
}

module.exports = { procesarFactura, enviarCaptcha, detectarPortal, facturarHomedepotAPI };
