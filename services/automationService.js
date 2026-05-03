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
      // ── PASO 1: RFC + ticket ──────────────────────────────────────────────
      await page.waitForSelector('#rfc', { timeout: 20000 });
      await page.fill('#rfc', perfil.rfc);
      await page.fill('#ticket', (ticketData.folio || '').replace(/[^0-9]/g, ''));
      console.log('[AUTO] RFC y ticket llenados');
      await page.waitForTimeout(4000);

      // Si hay SweetAlert2 de verificacion (captcha), notificar
      const swalVisible = await page.$('.swal2-container');
      if (swalVisible) {
        console.log('[AUTO] SweetAlert2 detectado - requiere verificacion manual');
        return { success: false, captcha_required: true, mensaje: 'Verificacion de seguridad requerida en Home Depot' };
      }

      await page.click('button.btn-primary', { timeout: 15000 });
      console.log('[AUTO] Click Continuar paso 1');
      await page.waitForTimeout(4000);

      // ── PASO 2: Datos fiscales ────────────────────────────────────────────
      try {
        // Esperar a que cargue el formulario del paso 2
        await page.waitForSelector('input[type="email"], input[placeholder*="correo"], input[placeholder*="Correo"], input[placeholder*="nombre"], input[placeholder*="Nombre"]', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // Cerrar cualquier Swal que bloquee el formulario via JS
        const swalPaso2 = await page.$('.swal2-container');
        if (swalPaso2) {
          console.log('[AUTO] Swal en paso 2 detectado - cerrando via JS');
          await page.evaluate(() => {
            // Forzar cierre del SweetAlert2
            const swalContainer = document.querySelector('.swal2-container');
            if (swalContainer) swalContainer.remove();
            // Quitar el overflow:hidden del body que bloquea interaccion
            document.body.style.overflow = '';
            document.body.classList.remove('swal2-shown', 'swal2-height-auto');
          });
          await page.waitForTimeout(500);
        }

        // Llenar email
        const campoEmail = await page.$('input[type="email"], input[placeholder*="correo"], input[placeholder*="Correo"]');
        if (campoEmail) {
          await campoEmail.click();
          await campoEmail.fill(perfil.email);
        }

        // Llenar nombre
        const campoNombre = await page.$('input[placeholder*="Nombre"], input[placeholder*="nombre"]');
        if (campoNombre) {
          await campoNombre.click();
          await campoNombre.fill(perfil.nombre);
        }

        // Llenar CP
        const campoCP = await page.$('input[placeholder*="Postal"], input[placeholder*="postal"], input[placeholder*="CP"], input[placeholder*="C.P"]');
        if (campoCP) {
          await campoCP.click();
          await campoCP.fill(perfil.cp);
        }

        // ── Regimen fiscal: SweetAlert2 custom select - usar page.evaluate() ──
        const regimenTarget = perfil.regimen || '612';
        const regimenSet = await page.evaluate((regimen) => {
          // Intentar selects nativos primero
          const selects = document.querySelectorAll('select');
          if (selects.length >= 1) {
            const sel = selects[0];
            const opt = Array.from(sel.options).find(o => o.value === regimen || o.text.includes(regimen));
            if (opt) {
              sel.value = opt.value;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              sel.dispatchEvent(new Event('input', { bubbles: true }));
              return 'select-native:' + opt.value;
            }
          }
          // Buscar el trigger del Swal2 select de regimen y hacer click
          const triggers = Array.from(document.querySelectorAll('button, .swal2-select, [class*="select"], [class*="Select"]'));
          const regimenTrigger = triggers.find(el => {
            const txt = el.textContent || '';
            return txt.includes('Regimen') || txt.includes('régimen') || txt.includes('612') || txt.includes('Persona');
          });
          if (regimenTrigger) {
            regimenTrigger.click();
            return 'trigger-clicked:' + regimenTrigger.className;
          }
          return 'not-found';
        }, regimenTarget);
        console.log('[AUTO] Regimen result:', regimenSet);

        // Si el Swal se abrió para seleccionar regimen, seleccionar la opcion
        await page.waitForTimeout(800);
        const swalRegimenOpen = await page.$('.swal2-container .swal2-input, .swal2-container select, .swal2-container .swal2-radio');
        if (swalRegimenOpen) {
          console.log('[AUTO] Swal de regimen abierto, seleccionando opcion via evaluate');
          await page.evaluate((regimen) => {
            // Intentar input/select dentro del Swal
            const swalInput = document.querySelector('.swal2-input');
            if (swalInput) { swalInput.value = regimen; swalInput.dispatchEvent(new Event('input', { bubbles: true })); }
            const swalSelect = document.querySelector('.swal2-select');
            if (swalSelect) {
              const opt = Array.from(swalSelect.options).find(o => o.value === regimen || o.text.includes(regimen));
              if (opt) { swalSelect.value = opt.value; swalSelect.dispatchEvent(new Event('change', { bubbles: true })); }
            }
            // Confirmar el Swal
            const confirmBtn = document.querySelector('.swal2-confirm');
            if (confirmBtn) confirmBtn.click();
          }, regimenTarget);
          await page.waitForTimeout(800);
        }

        // ── Uso CFDI ──────────────────────────────────────────────────────────
        const usoTarget = perfil.uso_cfdi || 'G03';
        await page.evaluate((uso) => {
          const selects = document.querySelectorAll('select');
          if (selects.length >= 2) {
            const sel = selects[1];
            const opt = Array.from(sel.options).find(o => o.value === uso || o.text.includes(uso));
            if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); }
          }
        }, usoTarget);

        await page.waitForTimeout(500);

        // Asegurarse de que no hay Swal bloqueando antes de submit
        await page.evaluate(() => {
          const swal = document.querySelector('.swal2-container');
          if (swal) { swal.remove(); }
          document.body.style.overflow = '';
          document.body.classList.remove('swal2-shown', 'swal2-height-auto');
        });
        await page.waitForTimeout(500);

        await page.click('button.btn-primary', { timeout: 15000 });
        console.log('[AUTO] Click submit paso 2');
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

  'oxxo gas': {
    url: 'https://facturacion.oxxogas.com',
    requiereCuenta: true,
    async ejecutar(page, perfil, ticketData, solicitudId) {
      // Parsear credenciales del portal
      let creds = {};
      try { creds = JSON.parse(perfil.password_portales || '{}')?.oxxo_gas || {}; } catch {}
      if (!creds.email || !creds.password) {
        db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
          .run('manual', 'Configura tus credenciales de OXXO Gas en Perfil > Portales', solicitudId);
        return { success: false, manual: true, mensaje: 'Credenciales OXXO Gas no configuradas. Ve a Perfil > Portales.' };
      }

      // Cerrar popup de aviso si aparece
      await page.waitForTimeout(2000);
      const popup = await page.$('.swal2-container, .modal, [class*="aviso"]');
      if (popup) {
        await page.evaluate(() => {
          const closeBtn = document.querySelector('.swal2-close, .close, [aria-label="Close"], .btn-close');
          if (closeBtn) closeBtn.click();
          const overlay = document.querySelector('.swal2-container');
          if (overlay) overlay.remove();
        });
        await page.waitForTimeout(500);
      }

      // ── LOGIN ──────────────────────────────────────────────────────────
      console.log('[AUTO] OXXO Gas - iniciando login');
      await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="Correo"]', { timeout: 15000 });
      await page.fill('input[type="email"], input[name="email"], input[placeholder*="Correo"]', creds.email);
      await page.fill('input[type="password"], input[name="password"], input[placeholder*="Contrase"]', creds.password);

      // Resolver reCAPTCHA con CapSolver
      const capsolver_key = process.env.CAPSOLVER_API_KEY;
      if (capsolver_key) {
        console.log('[AUTO] OXXO Gas - resolviendo reCAPTCHA con CapSolver');
        try {
          const axios = require('axios');
          // Obtener sitekey del reCAPTCHA
          const sitekey = await page.evaluate(() => {
            const el = document.querySelector('.g-recaptcha, [data-sitekey]');
            return el?.dataset?.sitekey || null;
          });
          if (sitekey) {
            // Crear tarea en CapSolver
            const createRes = await axios.post('https://api.capsolver.com/createTask', {
              clientKey: capsolver_key,
              task: { type: 'ReCaptchaV2Task', websiteURL: 'https://facturacion.oxxogas.com', websiteKey: sitekey }
            });
            const taskId = createRes.data.taskId;
            // Esperar resultado (max 90s)
            let token = null;
            for (let i = 0; i < 18; i++) {
              await page.waitForTimeout(5000);
              const result = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capsolver_key, taskId });
              if (result.data.status === 'ready') { token = result.data.solution.gRecaptchaResponse; break; }
            }
            if (token) {
              await page.evaluate((t) => {
                document.querySelector('#g-recaptcha-response, textarea[name="g-recaptcha-response"]').value = t;
                if (window.captchaCallback) window.captchaCallback(t);
                if (typeof ___grecaptcha_cfg !== 'undefined') {
                  const id = Object.keys(___grecaptcha_cfg.clients || {})[0];
                  if (id !== undefined) grecaptcha.execute(id);
                }
              }, token);
              console.log('[AUTO] OXXO Gas - reCAPTCHA resuelto');
            }
          }
        } catch (e) { console.log('[AUTO] OXXO Gas - CapSolver error:', e.message); }
      }

      // Click login
      await page.click('button[type="submit"], button:has-text("INICIAR"), button:has-text("Iniciar")');
      await page.waitForTimeout(4000);

      // ── FACTURAR ───────────────────────────────────────────────────────
      console.log('[AUTO] OXXO Gas - navegando a facturar');
      // Buscar menu Facturar
      const menuFacturar = await page.$('a:has-text("Facturar"), button:has-text("Facturar"), a[href*="factura"]');
      if (menuFacturar) { await menuFacturar.click(); await page.waitForTimeout(2000); }

      // Llenar datos del ticket
      const fecha = ticketData.fecha_compra || '';
      const folio = ticketData.folio || '';

      const campoFolio = await page.$('input[placeholder*="folio"], input[placeholder*="Folio"], input[name*="folio"]');
      if (campoFolio) await campoFolio.fill(folio);

      const campoFecha = await page.$('input[type="date"], input[placeholder*="fecha"], input[name*="fecha"]');
      if (campoFecha) await campoFecha.fill(fecha);

      const campoTotal = await page.$('input[placeholder*="total"], input[placeholder*="Total"], input[name*="total"], input[name*="importe"]');
      if (campoTotal) await campoTotal.fill(String(ticketData.total || ''));

      // Continuar
      await page.click('button:has-text("Continuar"), button:has-text("CONTINUAR"), button[type="submit"]');
      await page.waitForTimeout(3000);

      // Llenar datos fiscales si los pide
      const rfcInput = await page.$('input[placeholder*="RFC"], input[name*="rfc"]');
      if (rfcInput) {
        await rfcInput.fill(perfil.rfc);
        const nombreInput = await page.$('input[placeholder*="Nombre"], input[placeholder*="Razón"], input[name*="nombre"]');
        if (nombreInput) await nombreInput.fill(perfil.nombre);
        const cpInput = await page.$('input[placeholder*="Postal"], input[placeholder*="C.P"], input[name*="cp"]');
        if (cpInput) await cpInput.fill(perfil.cp);
        const emailInput = await page.$('input[type="email"], input[placeholder*="correo"]');
        if (emailInput) await emailInput.fill(perfil.email);

        // Régimen y CFDI via select
        await page.evaluate((regimen, uso) => {
          document.querySelectorAll('select').forEach((sel, i) => {
            if (i === 0) { const opt = Array.from(sel.options).find(o => o.value === regimen || o.text.includes(regimen)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); } }
            if (i === 1) { const opt = Array.from(sel.options).find(o => o.value === uso || o.text.includes(uso)); if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); } }
          });
        }, perfil.regimen || '612', perfil.uso_cfdi || 'G03');
      }

      // Generar factura
      await page.click('button:has-text("Generar"), button:has-text("GENERAR"), button:has-text("Solicitar")').catch(() => {});
      await page.waitForTimeout(5000);

      const texto = await page.textContent('body');
      if (texto.includes('exitosa') || texto.includes('generada') || texto.includes('generado') || texto.includes('enviada') || texto.includes('correo')) {
        return { success: true, mensaje: 'Factura OXXO Gas generada exitosamente' };
      }
      return { success: false, mensaje: 'Proceso parcial OXXO Gas - verifica en portal' };
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
      if (selectRegimen) await selectRegimen.selectOption({ value: perfil.regimen || '612' }).catch(() => {});

      // Uso CFDI
      const selectUso = await page.$('select[name="usoCFDI"], select:nth-of-type(2)');
      if (selectUso) await selectUso.selectOption({ value: perfil.uso_cfdi || 'G03' }).catch(() => {});

      // CP y Correo
      await page.fill('[name="cp"]', perfil.cp);
      await page.fill('[name="correo"]', perfil.email);

      // Tomar screenshot del captcha
      const captchaEl = await page.$('.captcha-img, img[src*="captcha"], #captchaImg');
      const captchaPath = path.join(CAPTCHA_DIR, `${solicitudId}.png`);
      if (captchaEl) {
        await captchaEl.screenshot({ path: captchaPath });
        console.log('[AUTO] Captcha guardado:', captchaPath);
      } else {
        await page.screenshot({ path: captchaPath, clip: { x: 200, y: 850, width: 400, height: 120 } });
      }

      db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
        .run('captcha_required', captchaPath, solicitudId);

      return { success: false, captcha_required: true, captcha_path: captchaPath };
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
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled']
  });

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();

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

async function enviarCaptcha(solicitudId, captchaTexto) {
  const solicitud = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
  if (!solicitud || solicitud.status !== 'captcha_required') {
    throw new Error('Solicitud no en espera de captcha');
  }
  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(solicitud.usuario_id);
  const portal = detectarPortal(solicitud.establecimiento);
  if (!portal) throw new Error('Portal no encontrado: ' + solicitud.establecimiento);

  console.log('[CAPTCHA] Captcha recibido para solicitud', solicitudId);
  db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
    .run('procesando', 'Captcha enviado', solicitudId);
}

module.exports = { procesarFactura, enviarCaptcha, detectarPortal };
