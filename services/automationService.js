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
        // Intentar multiples estrategias para seleccionar regimen
        const regimenSet = await page.evaluate((regimen) => {
          // Estrategia 0: SweetAlert2 select directo
          var swalSel = document.querySelector('.swal2-select');
          if(swalSel){var opt=Array.from(swalSel.options).find(function(o){return o.value===regimen||o.text.includes(regimen);});if(opt){swalSel.value=opt.value;swalSel.dispatchEvent(new Event('change',{bubbles:true}));return 'swal2-select:'+opt.value;}}
          // Estrategia 1: ng-select o mat-select custom
          var allSels = document.querySelectorAll('select,ng-select,[class*="select"],[class*="dropdown"]');
          // Estrategia ORIGINAL:
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

  'bandeja': {
    httpOnly: true,
    async ejecutar(perfil, ticketData) {
      const axios = require('axios');

      const transformarRespuesta = [(data) => {
        if (typeof data !== 'string') return data;
        try { return JSON.parse(data.replace(/^\(|\)$/g, '')); } catch { return data; }
      }];

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': 'https://app.facturama.mx',
        'Referer': 'https://app.facturama.mx/Shopify/Clients'
      };

      // Paso 1: SearchOrder — obtener orderId interno de Shopify
      const searchInfo = Buffer.from(JSON.stringify({
        ShopName: 'bandeja-mx.myshopify.com',
        OrderId: ticketData.folio,
        OrdenName: String(ticketData.total)
      })).toString('base64');

      let orderId;
      try {
        const { data: searchData } = await axios.get(
          `https://app.facturama.mx/Shopify/Clients/SearchOrder?info=${searchInfo}`,
          { headers, transformResponse: transformarRespuesta }
        );
        if (!searchData.success || !searchData.orderId) {
          return { success: false, mensaje: 'Bandeja: orden no encontrada - verifica folio y total' };
        }
        orderId = searchData.orderId;
      } catch (e) {
        return { success: false, mensaje: 'Bandeja: error buscando orden - ' + e.message };
      }

      console.log('[AUTO] Bandeja HTTP - orderId:', orderId);

      // Paso 2: SaveClient — genera la factura via Facturama
      const params = new URLSearchParams({
        ShopName: 'bandeja-mx',
        OrderId: String(orderId),
        'Client.Id': '',
        'Client.Name': perfil.nombre,
        'Client.Rfc': perfil.rfc,
        'Client.FiscalRegime': perfil.regimen || '612',
        'Client.CfdiUse': perfil.uso_cfdi || 'G03',
        'Client.PaymentForm': '04',
        'Client.Email': perfil.email,
        'Client.Address.ZipCode': perfil.cp,
        'Client.Address.Street': '',
        'Client.Address.ExteriorNumber': '',
        'Client.Address.InteriorNumber': '',
        'Client.Address.Neighborhood': '',
        'Client.Address.Locality': '',
        'Client.Address.Municipality': '',
        'Client.Address.State': '',
        State: ''
      });

      try {
        const { data: saveData } = await axios.post(
          'https://app.facturama.mx/Shopify/Clients/SaveClient',
          params.toString(),
          { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' }, transformResponse: transformarRespuesta }
        );
        console.log('[AUTO] Bandeja HTTP - SaveClient:', JSON.stringify(saveData));

        if (saveData.success || saveData.shopInvoiceId > 0) {
          return { success: true, mensaje: 'Factura Bandeja generada exitosamente' };
        }
        return { success: false, mensaje: 'Bandeja: factura no generada - RFC inválido o límite alcanzado' };
      } catch (e) {
        return { success: false, mensaje: 'Bandeja: error generando factura - ' + e.message };
      }
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
      // Cerrar popup de aviso si aparece (bloquea el form)
      await page.evaluate(() => {
        const modal = document.querySelector('.modal.show, .modal-backdrop, [class*="aviso"], [class*="popup"]');
        if (modal) modal.remove();
        // Remover backdrop si quedó
        document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';
      });
      await page.waitForTimeout(500);
      // Selectores reales: input#username y input[name="password"]
      await page.waitForSelector('input#username, input.username', { timeout: 15000 });
      await page.fill('input#username, input.username', creds.email);
      await page.fill('input[name="password"]', creds.password);

      // Resolver reCAPTCHA v2 visible con CapSolver (ReCaptchaV2TaskProxyLess)
      const capsolver_key = process.env.CAPSOLVER_API_KEY;
      if (capsolver_key) {
        console.log('[AUTO] OXXO Gas - resolviendo reCAPTCHA con CapSolver');
        try {
          const axios = require('axios');
          const sitekey = await page.evaluate(() => {
            const el = document.querySelector('.g-recaptcha, [data-sitekey]');
            return el?.dataset?.sitekey || null;
          });
          if (sitekey) {
            const createRes = await axios.post('https://api.capsolver.com/createTask', {
              clientKey: capsolver_key,
              task: {
                type: 'ReCaptchaV2TaskProxyLess',
                websiteURL: 'https://facturacion.oxxogas.com',
                websiteKey: sitekey
              }
            });
            const taskId = createRes.data.taskId;
            let token = null;
            for (let i = 0; i < 18; i++) {
              await page.waitForTimeout(5000);
              const result = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capsolver_key, taskId });
              if (result.data.status === 'ready') { token = result.data.solution.gRecaptchaResponse; break; }
            }
            if (token) {
              // Inyectar token en el textarea oculto y disparar callback del widget
              await page.evaluate((t) => {
                // Poner token en todos los textareas de recaptcha
                document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => { el.value = t; });
                // Buscar y llamar el callback del widget
                try {
                  if (typeof ___grecaptcha_cfg !== 'undefined') {
                    const clients = ___grecaptcha_cfg.clients;
                    for (const key of Object.keys(clients || {})) {
                      const client = clients[key];
                      for (const k2 of Object.keys(client || {})) {
                        if (client[k2] && typeof client[k2].callback === 'function') {
                          client[k2].callback(t);
                          break;
                        }
                      }
                    }
                  }
                } catch(e) {}
              }, token);
              console.log('[AUTO] OXXO Gas - reCAPTCHA resuelto');
              await page.waitForTimeout(1000);
            }
          }
        } catch (e) { console.log('[AUTO] OXXO Gas - CapSolver error:', e.message); }
      }

      // Click login
      await page.click('button[type="submit"], button:has-text("INICIAR"), button:has-text("Iniciar")');
      await page.waitForTimeout(4000);

      // ── REGISTRAR DATOS FISCALES (si no hay RFC registrado) ────────────
      console.log('[AUTO] OXXO Gas - registrando datos fiscales');
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a.navAsAjax'));
        const datosFiscales = links.find(l => l.textContent.includes('Registrar Datos Fiscales') || l.textContent.includes('Datos Fiscales'));
        if (datosFiscales) datosFiscales.click();
        else {
          // Click en tarjeta "Acceder a Datos Fiscales"
          const card = Array.from(document.querySelectorAll('a')).find(a => a.textContent.includes('ACCEDER A DATOS FISCALES'));
          if (card) card.click();
        }
      });
      await page.waitForTimeout(2000);

      // Verificar si ya hay RFC registrado — si la tabla de datos fiscales tiene filas, skip registro
      const tieneRFC = await page.evaluate(() => {
        const tabla = document.querySelector('#datosfiscales tbody tr');
        return tabla && !tabla.textContent.includes('Ningún Registro');
      }).catch(() => false);

      if (!tieneRFC) {
        console.log('[AUTO] OXXO Gas - no hay RFC registrado, registrando ahora');
        // Tipo contribuyente: 1=Persona Física, 2=Moral
        const tipoVal = (perfil.regimen === '601' || perfil.regimen === '626') ? '2' : '1';
        await page.evaluate(({tipo, regimen, uso, rfc, email}) => {
          // Tipo contribuyente
          const selTipo = document.querySelector('select#regimen');
          if (selTipo) { selTipo.value = tipo; selTipo.dispatchEvent(new Event('change', {bubbles:true})); }
        }, {tipo: tipoVal, regimen: perfil.regimen, uso: perfil.uso_cfdi, rfc: perfil.rfc, email: perfil.email});
        await page.waitForTimeout(1000);

        // Régimen fiscal y Uso CFDI
        await page.evaluate(({r: regimen, u: uso}) => {
          const selReg = document.querySelector('select#regimen_fiscal');
          if (selReg) {
            const opt = Array.from(selReg.options).find(o => o.value === regimen);
            if (opt) { selReg.value = opt.value; selReg.dispatchEvent(new Event('change', {bubbles:true})); }
          }
          setTimeout(() => {
            const selUso = document.querySelector('select#usocfdi');
            if (selUso) {
              const opt = Array.from(selUso.options).find(o => o.value === uso);
              if (opt) { selUso.value = opt.value; selUso.dispatchEvent(new Event('change', {bubbles:true})); }
            }
          }, 500);
        }, {r: perfil.regimen || '612', u: perfil.uso_cfdi || 'G03'});
        await page.waitForTimeout(1500);

        // RFC, Email, CP
        await page.$eval('input#rfc', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }, perfil.rfc).catch(() => {});
        await page.$eval('input#email', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); }, perfil.email).catch(() => {});
        await page.$eval('input#cp', (el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); }, perfil.cp).catch(() => {});
        await page.waitForTimeout(500);

        // Click REGISTRAR DATOS FISCALES
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn')).find(b =>
            (b.textContent || b.value || '').includes('REGISTRAR') || (b.textContent || b.value || '').includes('Registrar')
          );
          if (btn) btn.click();
        });
        await page.waitForTimeout(3000);
        console.log('[AUTO] OXXO Gas - datos fiscales registrados');
      } else {
        console.log('[AUTO] OXXO Gas - RFC ya registrado, saltando');
      }

      // ── FACTURAR ───────────────────────────────────────────────────────
      console.log('[AUTO] OXXO Gas - navegando a facturar');
      // Click en link "Facturar" del sidebar (navAsAjax)
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a.navAsAjax'));
        const facturar = links.find(l => l.textContent.includes('Facturar') && !l.textContent.includes('Mis'));
        if (facturar) facturar.click();
      });
      await page.waitForTimeout(3000);

      // ── RFC a Facturar ────────────────────────────────────────────────
      // Seleccionar el RFC registrado en el portal
      await page.evaluate((rfc) => {
        const sel = document.querySelector('select#rfc');
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.text.includes(rfc) || o.value.includes(rfc));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
          else if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', {bubbles:true})); }
        }
      }, perfil.rfc);
      await page.waitForTimeout(1000);

      // Seleccionar régimen fiscal
      await page.evaluate((regimen) => {
        const sel = document.querySelector('select#regimen_fiscal');
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.value === regimen || o.text.includes(regimen));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
          else if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', {bubbles:true})); }
        }
      }, perfil.regimen || '612');
      await page.waitForTimeout(500);

      // Seleccionar uso CFDI
      await page.evaluate((uso) => {
        const sel = document.querySelector('select#usocfdi');
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.value === uso || o.text.includes(uso));
          if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
          else if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', {bubbles:true})); }
        }
      }, perfil.uso_cfdi || 'G03');
      await page.waitForTimeout(500);

      // Email
      await page.$eval('input#rfc_email', (el, email) => { el.value = email; el.dispatchEvent(new Event('input', {bubbles:true})); }, perfil.email).catch(() => {});

      // ── Agregar Ticket ────────────────────────────────────────────────
      // Seleccionar estación por no_estacion del ticket
      const noEstacion = ticketData.estacion || '';
      await page.evaluate((estacion) => {
        const sel = document.querySelector('select#estacion');
        if (!sel) return;
        // Buscar por texto que contenga el ID de estacion
        const opt = Array.from(sel.options).find(o =>
          estacion && (o.text.toLowerCase().includes(estacion.toLowerCase().substring(0,8)) || o.value === estacion)
        );
        if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); }
        else if (sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', {bubbles:true})); }
      }, noEstacion);
      await page.waitForTimeout(500);

      // Folio
      await page.$eval('input#ticket', (el, folio) => { el.value = folio; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }, ticketData.folio || '').catch(() => {});

      // Monto (con 2 decimales)
      const montoStr = parseFloat(ticketData.total || 0).toFixed(2);
      await page.$eval('input#monto', (el, monto) => { el.value = monto; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }, montoStr).catch(() => {});
      await page.waitForTimeout(500);

      // Click Agregar Ticket
      console.log('[AUTO] OXXO Gas - agregando ticket');
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a.btn')).find(b => b.textContent.includes('AGREGAR TICKET') || b.textContent.includes('Agregar Ticket'));
        if (btn) btn.click();
      });
      await page.waitForTimeout(3000);

      // Click Facturar (botón final de generar factura)
      console.log('[AUTO] OXXO Gas - generando factura');
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, a.btn, input[type="submit"]')).find(b =>
          b.textContent.includes('Facturar') || b.textContent.includes('FACTURAR') || b.textContent.includes('Generar') || b.value?.includes('Facturar')
        );
        if (btn) btn.click();
      });
      await page.waitForTimeout(5000);

      const texto = await page.textContent('body');
      if (texto.includes('exitosa') || texto.includes('generada') || texto.includes('generado') || texto.includes('enviada') || texto.includes('correo') || texto.includes('factura')) {
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

  const ticketData = {
    folio: solicitud.folio,
    estacion: solicitud.estacion || '',
    web_id: solicitud.web_id || '',
    fecha_formateada: solicitud.fecha_compra || '',
    establecimiento: solicitud.establecimiento,
    total: solicitud.total
  };

  // Portales HTTP directo (sin browser)
  if (portal.httpOnly) {
    try {
      const resultado = await portal.ejecutar(perfil, ticketData, solicitudId);
      if (resultado.success) {
        db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
          .run('completado', resultado.mensaje, solicitudId);
      } else {
        db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
          .run('manual', resultado.mensaje || 'Proceso parcial', solicitudId);
      }
      return resultado;
    } catch (e) {
      console.error('[AUTO] Error HTTP portal:', e.message);
      db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
        .run('error', e.message.substring(0, 200), solicitudId);
      return { success: false, error: e.message };
    }
  }

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
