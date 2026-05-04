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

      // ── PASO 2: Datos fiscales (Angular form, selects nativos #regimenFiscal y #usoCfdi) ──
      try {
        // Cerrar cualquier Swal residual (post-captcha o post-submit)
        if (await page.$('.swal2-container')) {
          console.log('[AUTO] HD - Swal en paso 2, cerrando');
          await page.evaluate(() => {
            document.querySelectorAll('.swal2-container').forEach(e => e.remove());
            document.body.style.overflow = '';
            document.body.classList.remove('swal2-shown', 'swal2-height-auto');
          });
          await page.waitForTimeout(800);
        }

        // Esperar a que el select de régimen aparezca en el DOM (Angular lo renderiza async después del Turnstile)
        let regimenAparecio = false;
        try {
          await page.waitForSelector('#regimenFiscal', { timeout: 15000 });
          regimenAparecio = true;
          console.log('[AUTO] HD - #regimenFiscal apareció en DOM');
        } catch (e) {
          console.log('[AUTO] HD - #regimenFiscal NO apareció en 15s, dump del body para diagnóstico:');
          const dump = await page.evaluate(() => ({
            url: location.href,
            bodyText: (document.body.innerText || '').substring(0, 2000),
            swalText: (document.querySelector('.swal2-container')?.textContent || '').substring(0, 500),
            swalHTML: (document.querySelector('.swal2-container')?.innerHTML || '').substring(0, 2000),
            visibleInputs: Array.from(document.querySelectorAll('input,select,textarea'))
              .filter(el => el.offsetParent !== null)
              .map(el => ({ tag: el.tagName, id: el.id, name: el.name, type: el.type, placeholder: el.placeholder, classes: el.className.substring(0, 60) })),
            allSelects: Array.from(document.querySelectorAll('select')).map(s => ({ id: s.id, name: s.name, visible: s.offsetParent !== null, opts: s.options.length })),
            visibleButtons: Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent !== null).map(b => ({ text: (b.textContent || '').trim().substring(0, 40), disabled: b.disabled })),
            bodyHTMLSample: document.body.outerHTML.substring(0, 5000)
          }));
          console.log('[AUTO] HD DIAG url=' + dump.url);
          console.log('[AUTO] HD DIAG swalText=' + dump.swalText);
          console.log('[AUTO] HD DIAG visibleInputs=' + JSON.stringify(dump.visibleInputs));
          console.log('[AUTO] HD DIAG allSelects=' + JSON.stringify(dump.allSelects));
          console.log('[AUTO] HD DIAG buttons=' + JSON.stringify(dump.visibleButtons));
          console.log('[AUTO] HD DIAG bodyText=' + dump.bodyText);
          console.log('[AUTO] HD DIAG swalHTML=' + dump.swalHTML);
          console.log('[AUTO] HD DIAG bodyHTML=' + dump.bodyHTMLSample);
          return { success: false, mensaje: 'HD: paso 2 no cargó (#regimenFiscal ausente) — ver logs' };
        }

        // Llenar inputs por id (Angular form ngModel)
        const setInput = async (sel, val) => {
          if (!val) return;
          const el = await page.$(sel);
          if (el) await el.fill(String(val));
        };
        await setInput('#nombre', perfil.nombre_sat || perfil.nombre);
        await setInput('#correo', perfil.email);
        await setInput('#codigoPostal', perfil.cp);
        console.log('[AUTO] HD - inputs llenados (nombre/correo/cp)');

        // Esperar a que las opciones del régimen se carguen async (getCatRegimenfiscal)
        await page.waitForFunction(
          () => { const s = document.querySelector('#regimenFiscal'); return s && s.options.length > 1; },
          { timeout: 15000 }
        ).catch(() => {});

        // Régimen fiscal — select nativo Angular ngModel
        const regimenTarget = perfil.regimen || '612';
        const regimenResult = await page.evaluate((regimen) => {
          const sel = document.querySelector('#regimenFiscal');
          if (!sel) return 'no-select';
          if (sel.disabled) return 'disabled:opts=' + sel.options.length;
          const opt = Array.from(sel.options).find(o =>
            o.value === regimen || o.value.endsWith(regimen) || o.text.startsWith(regimen) || o.text.includes(regimen)
          );
          if (!opt) return 'opt-not-found:' + Array.from(sel.options).map(o=>o.value).join(',').substring(0,200);
          sel.value = opt.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok:' + opt.value;
        }, regimenTarget);
        console.log('[AUTO] HD - régimen:', regimenResult);

        // Esperar a que usoCfdi se habilite y se filtren las opciones según el régimen
        await page.waitForFunction(
          () => { const s = document.querySelector('#usoCfdi'); return s && !s.disabled && s.options.length > 1; },
          { timeout: 8000 }
        ).catch(() => {});

        // Uso CFDI — select nativo
        const usoTarget = perfil.uso_cfdi || 'G03';
        const usoResult = await page.evaluate((uso) => {
          const sel = document.querySelector('#usoCfdi');
          if (!sel) return 'no-select';
          if (sel.disabled) return 'disabled';
          const opt = Array.from(sel.options).find(o =>
            o.value === uso || o.value.endsWith(uso) || o.text.startsWith(uso) || o.text.includes(uso)
          );
          if (!opt) return 'opt-not-found:' + Array.from(sel.options).map(o=>o.value).join(',').substring(0,200);
          sel.value = opt.value;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok:' + opt.value;
        }, usoTarget);
        console.log('[AUTO] HD - usoCFDI:', usoResult);

        await page.waitForTimeout(800);

        // Limpiar swal residual antes de submit
        await page.evaluate(() => {
          document.querySelectorAll('.swal2-container').forEach(e => e.remove());
          document.body.style.overflow = '';
          document.body.classList.remove('swal2-shown', 'swal2-height-auto');
        });

        await page.click('button.btn-primary', { timeout: 15000 });
        console.log('[AUTO] HD - submit paso 2');
        await page.waitForTimeout(6000);

        const texto = await page.textContent('body');
        if (texto.includes('exitosa') || texto.includes('generada') || texto.includes('correo') || texto.includes('Descargar')) {
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

      const tr = [(d) => {
        if (typeof d !== 'string') return d;
        try { return JSON.parse(d.replace(/^\(|\)$/g, '')); } catch { return d; }
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
          'https://app.facturama.mx/Shopify/Clients/SearchOrder',
          { params: { info: searchInfo }, headers, transformResponse: tr }
        );
        if (!searchData.success || !searchData.orderId) {
          return { success: false, mensaje: 'Bandeja: orden no encontrada - verifica folio y total' };
        }
        orderId = searchData.orderId;
      } catch (e) {
        return { success: false, mensaje: 'Bandeja: error buscando orden - ' + e.message };
      }

      console.log('[AUTO] Bandeja HTTP - orderId:', orderId);

      // Paso 2: SaveClient (GET con Base64 JSON) — registra datos fiscales y obtiene shopInvoiceId
      // nombre_sat: extraído de la Constancia de Situación Fiscal (exacto para SAT CFDI 4.0)
      const nombreSAT = perfil.nombre_sat || perfil.nombre;
      const dataClient = {
        Id: '',
        Rfc: perfil.rfc,
        Name: nombreSAT,
        Email: perfil.email,
        Address: {
          Street: null,
          ExteriorNumber: null,
          InteriorNumber: '',
          Neighborhood: null,
          ZipCode: perfil.cp,
          Locality: '',
          Municipality: null,
          State: null,
          Country: 'Mexico'
        },
        PaymentMethod: '04',
        CfdiUse: perfil.uso_cfdi || 'G03',
        IvaPercentage: null,
        ShowIeps: null,
        PaymentForm: null,
        FiscalRegime: perfil.regimen || '612'
      };

      const checkout = { Shop: 'bandeja-mx', order_id: String(orderId) };

      let shopInvoiceId, version, creditNoteId;
      try {
        const { data: saveData } = await axios.get(
          'https://app.facturama.mx/Shopify/Clients/SaveClient',
          {
            params: {
              dataClient: Buffer.from(JSON.stringify(dataClient)).toString('base64'),
              checkout: Buffer.from(JSON.stringify(checkout)).toString('base64')
            },
            headers,
            transformResponse: tr
          }
        );
        console.log('[AUTO] Bandeja HTTP - SaveClient:', JSON.stringify(saveData));

        if (!saveData.success || !saveData.shopInvoiceId) {
          const errores = saveData.errors ? saveData.errors.join('; ') : 'RFC inválido o límite alcanzado';
          return { success: false, mensaje: 'Bandeja: ' + errores };
        }

        if (saveData.createdByLimit === false) {
          return { success: false, mensaje: 'Bandeja: plazo de facturación vencido para esta orden' };
        }

        if (!saveData.orderStatus) {
          return { success: false, mensaje: 'Bandeja: orden pendiente de pago, factura se generará al acreditarse' };
        }

        shopInvoiceId = saveData.shopInvoiceId;
        creditNoteId = saveData.creditNoteId || 0;
        version = saveData.version || '40';
      } catch (e) {
        return { success: false, mensaje: 'Bandeja: error en SaveClient - ' + e.message };
      }

      // Paso 3: CreateCfdiStoreFront — genera el XML CFDI y envía por email
      try {
        const invoiceId = creditNoteId > 0 ? creditNoteId : shopInvoiceId;
        const { data: cfdiData } = await axios.get(
          `https://app.facturama.mx/Shopify/Invoice${version}/CreateCfdiStoreFront`,
          {
            params: { ShopName: 'bandeja-mx', idShopifyInvoice: invoiceId, exchangeRate: '' },
            headers,
            transformResponse: tr
          }
        );
        console.log('[AUTO] Bandeja HTTP - CreateCfdi:', JSON.stringify(cfdiData));

        if (cfdiData.existInvoice) {
          return { success: true, mensaje: 'Bandeja: factura ya generada previamente, consulta tu correo' };
        }
        if (cfdiData.success) {
          const enviada = cfdiData.send ? ' y enviada al correo' : '';
          return { success: true, mensaje: `Factura Bandeja generada exitosamente${enviada}` };
        }
        return { success: false, mensaje: 'Bandeja: ' + (cfdiData.message || 'error al generar CFDI') };
      } catch (e) {
        return { success: false, mensaje: 'Bandeja: error en CreateCfdi - ' + e.message };
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
