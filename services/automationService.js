const { chromium } = require('playwright');
const db = require('../db/database');
const path = require('path');
const fs = require('fs');
const claudeAgent = require('./claudeAgent');

// Directorio para guardar captchas
const CAPTCHA_DIR = '/data/captchas';
try { fs.mkdirSync(CAPTCHA_DIR, { recursive: true }); } catch(e) {}

// Petro 7: el server espera fechaTicket en formato ISO (lo que produce
// JSON.stringify(new Date(...))). Si lo mandamos como DD/MM/YYYY o
// "Tue Apr 30 2025..." el endpoint contesta SOAP error o "Ticket no existe".
function toIsoFechaPetro(s) {
  if (!s) return '';
  s = String(s).trim();
  // YYYY-MM-DD[Thh:mm:ss...]
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.substring(0, 10) + 'T00:00:00.000Z';
  }
  // DD/MM/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}T00:00:00.000Z`;
  }
  return s;
}

// OTA: factory que cada portal usa para reportar fallos HTTP a Claude en background.
function makeReportApi(portal) {
  return (endpoint, request, e) =>
    claudeAgent.analyzeApiFailure({
      portal,
      endpoint,
      request,
      responseStatus: e.response?.status,
      responseBody: e.response?.data,
      error: e.message
    }).catch(err => console.warn(`[OTA ${portal}] analyzeApiFailure falló (${endpoint}):`, err.message));
}

const PORTALES = {
  'home depot': {
    httpOnly: true,
    async ejecutar(perfil, ticketData) {
      const axios = require('axios');
      const BASE = 'https://facturacion.homedepot.com.mx:2053/CFDiConnectFacturacion/facturacion';
      const reportApi = makeReportApi('home depot');
      const TURNSTILE_SITEKEY = '0x4AAAAAAB6nsteTRVZ39dGq';
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://facturacion.homedepot.com.mx:2053',
        'Referer': 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/'
      };
      const opts = { headers, validateStatus: () => true, timeout: 30000 };

      const folioRaw = (ticketData.folio || '').trim().replace(/\D/g, '');
      if (!folioRaw) return { success: false, mensaje: 'HD: folio del ticket requerido' };
      // El ticket imprime 22 dígitos, pero /agregarTicket espera 23 (la API añade un 0 al inicio).
      // Si llega con 22 lo prefijamos; si ya viene con 23 (escaneado del barcode) lo dejamos.
      const folio = folioRaw.length === 22 ? '0' + folioRaw : folioRaw;
      console.log(`[AUTO] HD - folioRaw="${folioRaw}" len=${folioRaw.length} → folio API="${folio}" len=${folio.length}`);

      // 1. Resolver Turnstile via CapSolver
      const capKey = process.env.CAPSOLVER_API_KEY;
      if (!capKey) return { success: false, mensaje: 'HD: CAPSOLVER_API_KEY no configurada' };

      let turnstileToken;
      try {
        console.log('[AUTO] HD - resolviendo Turnstile via CapSolver');
        const create = await axios.post('https://api.capsolver.com/createTask', {
          clientKey: capKey,
          task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: 'https://facturacion.homedepot.com.mx/FacturacionWeb/', websiteKey: TURNSTILE_SITEKEY }
        }, { timeout: 15000 });
        if (create.data.errorId) return { success: false, mensaje: 'HD: CapSolver error - ' + create.data.errorDescription };
        const taskId = create.data.taskId;
        for (let i = 0; i < 30; i++) {
          await new Promise(r => setTimeout(r, 4000));
          const res = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capKey, taskId }, { timeout: 15000 });
          if (res.data.status === 'ready') { turnstileToken = res.data.solution.token; break; }
          if (res.data.errorId) return { success: false, mensaje: 'HD: CapSolver - ' + res.data.errorDescription };
        }
        if (!turnstileToken) return { success: false, mensaje: 'HD: CapSolver timeout' };
        console.log('[AUTO] HD - Turnstile token obtenido');
      } catch (e) {
        return { success: false, mensaje: 'HD: error CapSolver - ' + e.message };
      }

      // 2. Validar Turnstile en el backend HD
      try {
        const r = await axios.post(`${BASE}/validarRecaptcha`, { recaptchaToken: turnstileToken }, opts);
        console.log('[AUTO] HD - validarRecaptcha:', JSON.stringify(r.data));
        if (!r.data?.validado || r.data?.codigo !== 200) {
          return { success: false, mensaje: 'HD: Turnstile rechazado por backend - ' + (r.data?.mensaje || 'inválido') };
        }
      } catch (e) {
        reportApi(`${BASE}/validarRecaptcha`, { recaptchaToken: turnstileToken }, e);
        return { success: false, mensaje: 'HD: error validarRecaptcha - ' + e.message };
      }

      // 3. Buscar ticket — respuesta varía:
      //   éxito: el objeto del ticket directamente (rfcEmisor, tienda, conceptos, montos…)
      //   error: { alerta:true, codigo:500, mensaje:"ticket_longitud_invalida" | "ticket_fecha_invalida" | … }
      let datosTicket;
      try {
        const r = await axios.get(`${BASE}/agregarTicket`, { ...opts, params: { noTicket: folio } });
        const bodyStr = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data ?? '');
        console.log(`[AUTO] HD - agregarTicket status=${r.status} body=${bodyStr.substring(0, 800)}`);
        if (r.data && typeof r.data === 'object' && r.data.alerta === true && r.data.codigo !== 200) {
          return { success: false, mensaje: 'HD: ticket no válido - ' + (r.data.mensaje || 'desconocido') };
        }
        if (!r.data || typeof r.data !== 'object' || (!r.data.rfcEmisor && !r.data.tienda && !r.data.conceptos)) {
          return { success: false, mensaje: 'HD: respuesta inesperada de agregarTicket - ' + bodyStr.substring(0, 200) };
        }
        datosTicket = r.data;
      } catch (e) {
        reportApi(`${BASE}/agregarTicket`, { noTicket: folio }, e);
        return { success: false, mensaje: 'HD: error agregarTicket - ' + e.message };
      }

      // 4. Validar estado del cliente (RFC) — respuesta envuelta {codigo, mensaje}
      try {
        const r = await axios.get(`${BASE}/validarEstadoCliente`, { ...opts, params: { rfcCliente: perfil.rfc } });
        const bs = JSON.stringify(r.data ?? '');
        console.log(`[AUTO] HD - validarEstadoCliente status=${r.status} body=${bs.substring(0,300)}`);
        if (r.data?.codigo === 403) {
          return { success: false, mensaje: 'HD: RFC bloqueado - ' + (r.data?.mensaje || '') };
        }
      } catch (e) {
        reportApi(`${BASE}/validarEstadoCliente`, { rfcCliente: perfil.rfc }, e);
        return { success: false, mensaje: 'HD: error validarEstadoCliente - ' + e.message };
      }

      // 5. Verificar si el ticket ya fue facturado
      try {
        const r = await axios.get(`${BASE}/verificarComprobantePrevio`, { ...opts, params: { rfcReceptor: perfil.rfc, noTicket: folio } });
        const bs = JSON.stringify(r.data ?? '');
        console.log(`[AUTO] HD - verificarComprobantePrevio status=${r.status} body=${bs.substring(0,400)}`);
        if (r.data?.codigo === 200 && (r.data?.uuid || r.data?.uuidExistente)) {
          return { success: true, mensaje: 'HD: ticket ya facturado anteriormente, UUID ' + (r.data.uuid || r.data.uuidExistente) };
        }
      } catch (e) {
        reportApi(`${BASE}/verificarComprobantePrevio`, { rfcReceptor: perfil.rfc, noTicket: folio }, e);
        /* no crítico */
      }

      // 6. Buscar cliente existente por RFC; si no existe, guardar uno nuevo
      const nombreFiscal = perfil.nombre_sat || perfil.nombre;
      let clienteFacturama = null;
      try {
        const r = await axios.get(`${BASE}/getClientePorRFC`, { ...opts, params: { rfcCliente: perfil.rfc } });
        const bs = JSON.stringify(r.data ?? '');
        console.log(`[AUTO] HD - getClientePorRFC status=${r.status} body=${bs.substring(0,300)}`);
        // Respuesta exitosa puede venir como {codigo:200, cliente:...} o el cliente directo
        if (r.data?.codigo === 200 && r.data.cliente) clienteFacturama = r.data.cliente;
        else if (r.data && typeof r.data === 'object' && r.data.id && r.data.rfc) clienteFacturama = r.data;
      } catch (e) {
        reportApi(`${BASE}/getClientePorRFC`, { rfcCliente: perfil.rfc }, e);
        /* puede no existir */
      }

      const datosCliente = {
        rfc: perfil.rfc,
        nombre: nombreFiscal,
        codigoPostal: perfil.cp,
        regimenFiscal: perfil.regimen || '612',
        usoCfdi: perfil.uso_cfdi || 'G03',
        correo: perfil.email
      };

      try {
        if (!clienteFacturama) {
          const r = await axios.post(`${BASE}/guardarCliente`, datosCliente, opts);
          const bs = JSON.stringify(r.data ?? '');
          console.log(`[AUTO] HD - guardarCliente status=${r.status} body=${bs.substring(0,400)}`);
          if (r.data?.codigo !== 200) {
            return { success: false, mensaje: 'HD: error guardarCliente - ' + (r.data?.mensaje || 'falló') };
          }
          clienteFacturama = r.data.cliente;
        } else if (clienteFacturama.id) {
          // Actualizar datos por si cambiaron
          const update = { ...clienteFacturama, ...datosCliente };
          await axios.put(`${BASE}/actualizarCliente`, update, opts).catch(() => {});
        }
      } catch (e) {
        reportApi(`${BASE}/guardarCliente`, datosCliente, e);
        return { success: false, mensaje: 'HD: error guardar/actualizar cliente - ' + e.message };
      }

      // 7. Obtener tienda del ticket (necesario para datos del emisor)
      const noTienda = datosTicket?.noTienda || datosTicket?.tienda || datosTicket?.tienda?.noTienda;
      let tienda = null;
      if (noTienda) {
        try {
          const r = await axios.get(`${BASE}/obtenerTiendaPorNumero`, { ...opts, params: { noTienda: String(noTienda) } });
          const bs = JSON.stringify(r.data ?? '');
          console.log(`[AUTO] HD - obtenerTiendaPorNumero(${noTienda}) status=${r.status} body=${bs.substring(0,400)}`);
          if (r.data?.codigo === 200) tienda = r.data.tienda || r.data;
          else if (r.data && typeof r.data === 'object' && (r.data.emisorRfc || r.data.id)) tienda = r.data;
        } catch (e) {
          reportApi(`${BASE}/obtenerTiendaPorNumero`, { noTienda: String(noTienda) }, e);
          /* opcional */
        }
      }

      // 8. Calcular totales desde los conceptos del ticket
      const conceptos = datosTicket?.conceptos || [];
      const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
      let subTotal = 0;
      let totImpTras = 0;
      let totDescuento = 0;
      for (const c of conceptos) {
        subTotal += Number(c?.importe) || 0;
        totDescuento += Number(c?.descuento) || 0;
        const traslados = c?.traslados || c?.impuestos?.traslados || [];
        for (const t of traslados) totImpTras += Number(t?.importe) || 0;
      }
      subTotal = round2(subTotal);
      totImpTras = round2(totImpTras);
      totDescuento = round2(totDescuento);
      const total = round2(subTotal - totDescuento + totImpTras);
      console.log(`[AUTO] HD - calculados desde conceptos: subTotal=${subTotal} totImpTras=${totImpTras} descuento=${totDescuento} total=${total} (vs ticket.total=${datosTicket?.total})`);

      // Régimen del emisor: probar varias keys (la API a veces usa una distinta a la del frontend)
      const regimenEmisor = tienda?.claveRegimenFiscal || tienda?.regimenFiscal || tienda?.regimen || datosTicket?.regimenEmisor || '601';

      // 9. Construir comprobante y timbrar
      const comprobante = {
        tipoComprobante: 'I',
        tipoDocumento: 'FACTURA',
        serieId: tienda?.emisorId ? String(tienda.emisorId) : '',
        serieTiendaId: tienda?.id ? String(tienda.id) : '',
        moneda: 'MXN',
        tipoCambio: 1,
        exportacion: '01',
        condicionesPago: datosTicket?.metodoPagoInfo?.condicionesPago || 'PAGADO',
        formaPago: datosTicket?.metodoPagoInfo?.tipoPago?.formaPago || '01',
        metodoPago: datosTicket?.metodoPagoInfo?.metodoPago || 'PUE',
        lugarExpedicion: datosTicket?.codigoPostalTienda || tienda?.codigoPostal || '0',
        canalEmision: 'WEB',
        rfcEmisor: tienda?.emisorRfc || datosTicket?.rfcEmisor || '',
        nombreEmisor: tienda?.emisorNombre || '',
        regimenEmisor,
        emisor: tienda ? { id: tienda.emisorId || 0, rfc: tienda.emisorRfc || datosTicket?.rfcEmisor || '', razonSocial: tienda.emisorNombre || '', regimenFiscal: regimenEmisor } : null,
        tienda: tienda ? { id: tienda.id || 0, noTienda: tienda.noTienda || noTienda } : null,
        rfcReceptor: perfil.rfc,
        nombreReceptor: nombreFiscal,
        regimenReceptor: perfil.regimen || '612',
        usoCFDI: perfil.uso_cfdi || 'G03',
        correo: perfil.email,
        domicilioReceptor: perfil.cp,
        direccionReceptor: `Código Postal: ${perfil.cp}`,
        calle: 'NO ESPECIFICADO',
        numeroExterior: 'S/N',
        numeroInterior: '',
        colonia: 'NO ESPECIFICADO',
        municipio: 'NO ESPECIFICADO',
        estado: 'NO ESPECIFICADO',
        pais: 'MEXICO',
        activo: true,
        relacionados: [],
        tickets: [datosTicket],
        conceptos,
        descuento: totDescuento,
        totImpRet: 0,
        totImpTras,
        subTotal,
        total,
        totalDocumento: total,
        noClienteAR: datosTicket?.cliente?.noCliente || '',
        ordenCompra: '',
        tieneDetallista: datosTicket?.tieneDetallista || false,
        cliente: clienteFacturama
      };

      // Loguear el payload completo en chunks (Render trunca líneas largas)
      const payloadStr = JSON.stringify({ comprobante });
      console.log(`[AUTO] HD - timbrado payload size=${payloadStr.length} bytes`);
      console.log(`[AUTO] HD - timbrado tienda=${JSON.stringify(tienda)}`);
      console.log(`[AUTO] HD - timbrado cliente=${JSON.stringify(clienteFacturama)}`);
      console.log(`[AUTO] HD - timbrado datosTicket keys=${Object.keys(datosTicket || {}).join(',')}`);
      console.log(`[AUTO] HD - timbrado conceptos=${JSON.stringify((datosTicket?.conceptos || []).slice(0,3)).substring(0,800)}`);
      console.log(`[AUTO] HD - timbrado totales sub=${datosTicket?.subTotal} imp=${datosTicket?.totImpTras} total=${datosTicket?.total} desc=${datosTicket?.descuento}`);
      // Imprimir el payload entero en chunks de 1500 chars
      for (let i = 0; i < payloadStr.length; i += 1500) {
        console.log(`[AUTO] HD - timbrado payload[${i}-${Math.min(i+1500, payloadStr.length)}]: ${payloadStr.substring(i, i+1500)}`);
      }

      try {
        const r = await axios.post(`${BASE}/timbrado`, { comprobante }, opts);
        const bs = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data ?? '');
        console.log(`[AUTO] HD - timbrado RESPONSE status=${r.status} body=${bs.substring(0, 2000)}`);
        if (r.data?.codigo !== 200 && !r.data?.uuid && !r.data?.comprobante?.uuid) {
          return { success: false, mensaje: 'HD: error al timbrar - ' + (r.data?.mensaje || bs.substring(0, 200)) };
        }
        const uuid = r.data?.uuid || r.data?.comprobante?.uuid;

        // 9. Enviar correo con el CFDI
        if (uuid && perfil.email) {
          try {
            await axios.get(`${BASE}/enviarCorreo`, { ...opts, params: { uuid, email: perfil.email, tipo: 'cfdi.vigentes' } });
          } catch (e) {
            reportApi(`${BASE}/enviarCorreo`, { uuid, email: perfil.email, tipo: 'cfdi.vigentes' }, e);
            /* el CFDI ya está timbrado, fallo de correo no es bloqueante */
          }
        }

        return { success: true, mensaje: `Factura HD generada exitosamente${uuid ? ' UUID ' + uuid : ''}` };
      } catch (e) {
        reportApi(`${BASE}/timbrado`, { comprobante }, e);
        return { success: false, mensaje: 'HD: error timbrado - ' + e.message };
      }
    }
  },

  // Bandeja se mantiene como entrada explícita para detección por nombre (legacy/fallback)
  'bandeja': {
    httpOnly: true,
    ejecutar: (perfil, ticketData) => ejecutarFacturamaShopify(perfil, ticketData, ticketData.shop_name || 'bandeja-mx')
  },

  // Portal genérico para cualquier tienda Shopify+Facturama (se selecciona por sistema_facturacion)
  'facturama-shopify': {
    httpOnly: true,
    ejecutar: (perfil, ticketData) => ejecutarFacturamaShopify(perfil, ticketData, ticketData.shop_name)
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
      const noEstacion = ticketData.no_estacion || '';
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
    httpOnly: true,
    async ejecutar(perfil, ticketData) {
      const axios = require('axios');
      const https = require('https');
      const httpsAgent = new https.Agent({ rejectUnauthorized: false });
      const BASE = 'https://tarjetapetro-7.com.mx:8443';
      const reportApi = makeReportApi('petro');

      // Cookie jar manual
      const jar = {};
      const parseCookies = h => {
        const sc = h?.['set-cookie']; if (!sc) return;
        (Array.isArray(sc) ? sc : [sc]).forEach(c => {
          const [nv] = c.split(';'); const [n, v] = nv.split('=');
          if (n) jar[n.trim()] = v ? v.trim() : '';
        });
      };
      const cookieStr = () => Object.entries(jar).map(([k,v]) => k+'='+v).join('; ');

      const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Origin': BASE,
        'Referer': BASE + '/KPortalExterno/'
      };
      const opts = (extra = {}) => ({
        headers: { ...baseHeaders, Cookie: cookieStr(), ...extra },
        httpsAgent, validateStatus: () => true, timeout: 30000
      });

      // 1. Establecer sesión
      try {
        const r = await axios.get(BASE + '/KPortalExterno/', opts());
        parseCookies(r.headers);
        console.log('[AUTO] Petro7 - sesión:', Object.keys(jar).join(','));
      } catch (e) {
        reportApi(BASE + '/KPortalExterno/', null, e);
        return { success: false, mensaje: 'Petro7: error sesión - ' + e.message };
      }

      // 1.5. Pre-validar el ticket con verificaTicketWS2 (no requiere captcha).
      // Falla rápido con mensaje claro si los datos son incorrectos antes de
      // gastar una solución de CapSolver. status="0" = ticket correcto.
      const fechaIso = toIsoFechaPetro(ticketData.fecha_formateada || ticketData.fecha_compra || '');
      try {
        const v = await axios.get(BASE + '/KJServices/webapi/FacturacionService/verificaTicketWS2', {
          ...opts(),
          params: {
            noTicket: String(ticketData.folio || ''),
            estacion: String(ticketData.no_estacion || ''),
            fechaTicket: fechaIso,
            webId: String(ticketData.web_id || '')
          }
        });
        console.log(`[AUTO] Petro7 - verificaTicketWS2 status=${v.status} body=${JSON.stringify(v.data).substring(0,400)}`);
        if (v.data?.status !== '0' && v.data?.status !== 0) {
          const msg = v.data?.mensajeValidacion || v.data?.respuesta || 'sin detalle';
          return {
            success: false,
            mensaje: `Petro7: ticket rechazado por verificaTicketWS2 — ${msg} (folio=${ticketData.folio} estacion=${ticketData.no_estacion} webId=${ticketData.web_id} fecha=${fechaIso})`
          };
        }
      } catch (e) {
        console.log(`[AUTO] Petro7 - verificaTicketWS2 EXCEPCIÓN: ${e.message}`);
        // Continuar igual; el endpoint principal volverá a validar
      }

      // 2. Resolver Kaptcha (imagen JPG) — requiere CapSolver ImageToText
      const capKey = process.env.CAPSOLVER_API_KEY;
      if (!capKey) return { success: false, mensaje: 'Petro7: CAPSOLVER_API_KEY no configurada' };

      let captchaText;
      try {
        // GET de la imagen
        const img = await axios.get(BASE + '/KPortalExterno/Kaptcha.jpg', { ...opts(), responseType: 'arraybuffer' });
        parseCookies(img.headers);
        const captchaB64 = Buffer.from(img.data).toString('base64');
        const contentType = img.headers['content-type'] || 'unknown';
        console.log(`[AUTO] Petro7 - Kaptcha image: ${img.data.length} bytes, content-type=${contentType}, b64.length=${captchaB64.length}`);
        if (img.data.length < 500) {
          return { success: false, mensaje: 'Petro7: Kaptcha image demasiado pequeña (' + img.data.length + ' bytes), revisa cookies' };
        }

        // Resolver con CapSolver - intentar con varios módulos si falla
        // ImageToTextTask normalmente resuelve sincrónicamente: createTask retorna status=ready
        // con solution.text en la misma respuesta. Si NO viene listo, hacemos polling.
        const modulosACobrar = ['common', 'queueit'];
        let createData;
        let createErr;
        for (const mod of modulosACobrar) {
          try {
            const create = await axios.post('https://api.capsolver.com/createTask', {
              clientKey: capKey,
              task: { type: 'ImageToTextTask', body: captchaB64, module: mod }
            }, { timeout: 15000, validateStatus: () => true });
            console.log(`[AUTO] Petro7 - CapSolver createTask(module=${mod}) status=${create.status} body=${JSON.stringify(create.data).substring(0,500)}`);
            if (create.data.errorId) {
              createErr = create.data.errorDescription || create.data.errorCode || ('HTTP ' + create.status);
              continue;
            }
            // Aceptar la respuesta si trae solución directa (status=ready) o un taskId para polling
            if (create.data.status === 'ready' || create.data.solution?.text || create.data.taskId) {
              createData = { ...create.data, _module: mod };
              break;
            }
            createErr = 'createTask sin solution ni taskId: ' + JSON.stringify(create.data).substring(0, 200);
          } catch (e) {
            createErr = e.message;
            console.log(`[AUTO] Petro7 - CapSolver createTask(module=${mod}) EXCEPCIÓN: ${e.message} response=${JSON.stringify(e.response?.data).substring(0,300)}`);
          }
        }
        if (!createData) return { success: false, mensaje: 'Petro7: CapSolver createTask falló - ' + createErr };

        // Caso 1: createTask ya trae la solución (sincrónico). No llamar getTaskResult.
        if (createData.status === 'ready' || createData.solution?.text) {
          captchaText = createData.solution?.text || '';
          if (!captchaText) return { success: false, mensaje: 'Petro7: CapSolver status=ready sin texto' };
          console.log(`[AUTO] Petro7 - captcha resuelto sincrónicamente (module=${createData._module}): "${captchaText}"`);
        } else {
          // Caso 2: tenemos taskId, hacer polling
          for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 3000));
            const res = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: capKey, taskId: createData.taskId }, { timeout: 15000, validateStatus: () => true });
            console.log(`[AUTO] Petro7 - CapSolver getTaskResult[${i}] status=${res.data.status} errorId=${res.data.errorId || 0} body=${JSON.stringify(res.data).substring(0,400)}`);
            if (res.data.status === 'ready') {
              captchaText = res.data.solution?.text || '';
              break;
            }
            if (res.data.errorId) {
              return { success: false, mensaje: `Petro7: CapSolver error - ${res.data.errorCode}: ${res.data.errorDescription}` };
            }
          }
          if (!captchaText) return { success: false, mensaje: 'Petro7: CapSolver timeout sin solución' };
          console.log(`[AUTO] Petro7 - captcha resuelto via polling (module=${createData._module}): "${captchaText}"`);
        }
      } catch (e) {
        console.log(`[AUTO] Petro7 - excepción captcha: ${e.message} status=${e.response?.status} data=${JSON.stringify(e.response?.data).substring(0,300)}`);
        return { success: false, mensaje: 'Petro7: error captcha - ' + e.message };
      }

      // 3. Validar captcha contra el endpoint de Kaptcha (necesario para que la sesión lo marque como válido)
      try {
        const r = await axios.get(BASE + '/KPortalExterno/kaptcha', { ...opts(), params: { kaptcha: captchaText } });
        parseCookies(r.headers);
        console.log('[AUTO] Petro7 - kaptcha validate:', JSON.stringify(r.data));
        if (!r.data?.esValido) {
          return { success: false, mensaje: 'Petro7: captcha rechazado - ' + (r.data?.mensaje || captchaText) };
        }
      } catch (e) {
        reportApi(BASE + '/KPortalExterno/kaptcha', { kaptcha: captchaText }, e);
        return { success: false, mensaje: 'Petro7: error validando captcha - ' + e.message };
      }

      // 4. Construir ticket — fechaTicket debe ser ISO (Date.toJSON()), el
      // server rechaza DD/MM/YYYY y otros formatos.
      const ticket = {
        noEstacion: String(ticketData.no_estacion || ''),
        noTicket: String(ticketData.folio || ''),
        wid: String(ticketData.web_id || ''),
        fechaTicket: toIsoFechaPetro(ticketData.fecha_formateada || ticketData.fecha_compra || '')
      };
      // Avisar si campos clave vienen vacíos (Petro 7 los necesita para validar el ticket)
      const camposVacios = [];
      if (!ticket.noEstacion) camposVacios.push('noEstacion');
      if (!ticket.noTicket) camposVacios.push('noTicket');
      if (!ticket.wid) camposVacios.push('wid');
      if (!ticket.fechaTicket) camposVacios.push('fechaTicket');
      if (camposVacios.length) {
        console.log(`[AUTO] Petro7 - WARN campos vacíos en ticket: ${camposVacios.join(',')} (ticketData=${JSON.stringify(ticketData)})`);
      }
      console.log('[AUTO] Petro7 - ticket:', JSON.stringify(ticket));

      // 5. POST FacturaExpressService
      const params = new URLSearchParams({
        tickets: JSON.stringify([ticket]),
        idCliente: '',
        rfc: perfil.rfc,
        razon: perfil.nombre_sat || perfil.nombre,
        usoCFDI: perfil.uso_cfdi || 'G03',
        calle: '', noExterior: '', noInterior: '',
        colonia: '', delegacion: '', ciudad: '',
        cp: perfil.cp, pais: 'MEXICO',
        email: perfil.email,
        facturaExpress: 'true',
        facturaRegistrado: 'true',
        selectedFormaPago: '01',
        medioEmision: 'AUTOFACTURACIÓN',
        regimenFiscalReceptor: perfil.regimen || '612'
      });

      // Logging del payload completo en chunks (Render trunca líneas largas)
      const paramsStr = params.toString();
      console.log(`[AUTO] Petro7 - FacturaExpress payload size=${paramsStr.length} bytes`);
      for (let i = 0; i < paramsStr.length; i += 1500) {
        console.log(`[AUTO] Petro7 - FacturaExpress payload[${i}-${Math.min(i+1500, paramsStr.length)}]: ${paramsStr.substring(i, i+1500)}`);
      }

      try {
        const r = await axios.post(
          BASE + '/KJServices/webapi/FacturaExpressService',
          paramsStr,
          opts({ 'Content-Type': 'application/x-www-form-urlencoded' })
        );
        parseCookies(r.headers);
        const bodyStr = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data ?? '');
        console.log(`[AUTO] Petro7 - FacturaExpress RESPONSE status=${r.status} headers=${JSON.stringify(r.headers).substring(0,400)}`);
        for (let i = 0; i < bodyStr.length && i < 4500; i += 1500) {
          console.log(`[AUTO] Petro7 - FacturaExpress body[${i}-${Math.min(i+1500, bodyStr.length)}]: ${bodyStr.substring(i, i+1500)}`);
        }

        if (r.status >= 400) {
          return { success: false, mensaje: 'Petro7: HTTP ' + r.status + ' - ' + bodyStr.substring(0, 200) };
        }

        // Si tenemos CFDI directo en la respuesta, usarlo
        const data = r.data || {};
        let uuid = data.uuid || data.cfdis?.[0]?.uuid || (Array.isArray(data) ? data[0]?.uuid : null);
        if (data.cfdiDisponible || uuid) {
          return { success: true, mensaje: 'Factura Petro7 generada' + (uuid ? ' UUID ' + uuid : '') };
        }

        // 204 o body vacío: Petro 7 NO confirma éxito en la respuesta inmediata.
        // Verificar consultando findLastCfdi (poll hasta 60s) que el CFDI realmente
        // se generó. Si después del timeout sigue sin existir, marcar fallo.
        console.log(`[AUTO] Petro7 - FacturaExpress sin uuid/cfdiDisponible (status=${r.status}). Verificando con findLastCfdi...`);
        let findLastCfdiReported = false;
        for (let intento = 0; intento < 12; intento++) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const f = await axios.get(BASE + '/KJServices/webapi/FacturacionService/findLastCfdi', {
              ...opts(), params: { noTicket: ticket.noTicket, estacion: ticket.noEstacion }
            });
            console.log(`[AUTO] Petro7 - findLastCfdi[${intento}] status=${f.status} body=${JSON.stringify(f.data).substring(0,300)}`);
            if (f.data?.cfdiDisponible && f.data?.uuid) {
              return { success: true, mensaje: `Factura Petro7 generada UUID ${f.data.uuid} - enviada al correo` };
            }
            // Si el server confirma "ticket incorrecto" no tiene caso seguir polleando
            if (f.data?.respuesta && /incorrecto|invalido|no\s+existe/i.test(f.data.respuesta)) {
              return { success: false, mensaje: `Petro7: ${f.data.respuesta} (estacion=${ticket.noEstacion} folio=${ticket.noTicket}) - verifica que el ticket esté correcto y no muy reciente` };
            }
          } catch (e) {
            console.log(`[AUTO] Petro7 - findLastCfdi[${intento}] excepción: ${e.message}`);
            if (!findLastCfdiReported) {
              findLastCfdiReported = true;
              reportApi(
                BASE + '/KJServices/webapi/FacturacionService/findLastCfdi',
                { noTicket: ticket.noTicket, estacion: ticket.noEstacion },
                e
              );
            }
          }
        }
        return { success: false, mensaje: `Petro7: la solicitud fue aceptada (status=${r.status}) pero el CFDI no se generó en 60s. ${data.respuesta || data.mensaje || 'Probable rechazo silencioso por validación interna o delay del backend de Petro 7.'}` };
      } catch (e) {
        console.log(`[AUTO] Petro7 - FacturaExpress EXCEPCIÓN: ${e.message} status=${e.response?.status} data=${JSON.stringify(e.response?.data).substring(0,500)}`);
        reportApi(BASE + '/KJServices/webapi/FacturaExpressService', paramsStr, e);
        return { success: false, mensaje: 'Petro7: error FacturaExpress - ' + e.message };
      }
    }
  }
};

// Flujo HTTP genérico para tiendas Shopify que usan Facturama como sistema de facturación.
// Acepta cualquier shop_name (handle de Shopify, ej: "bandeja-mx", "moft").
async function ejecutarFacturamaShopify(perfil, ticketData, shopName) {
  const axios = require('axios');
  if (!shopName) return { success: false, mensaje: 'Facturama-Shopify: shop_name no definido' };

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

  const tag = `Facturama-Shopify[${shopName}]`;

  // 1. SearchOrder — obtener orderId interno de Shopify
  const searchInfo = Buffer.from(JSON.stringify({
    ShopName: shopName + '.myshopify.com',
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
      return { success: false, mensaje: `${tag}: orden no encontrada - verifica folio y total` };
    }
    orderId = searchData.orderId;
  } catch (e) {
    return { success: false, mensaje: `${tag}: error buscando orden - ${e.message}` };
  }
  console.log(`[AUTO] ${tag} - orderId: ${orderId}`);

  // 2. SaveClient (GET con Base64 JSON)
  const nombreSAT = perfil.nombre_sat || perfil.nombre;
  const dataClient = {
    Id: '',
    Rfc: perfil.rfc,
    Name: nombreSAT,
    Email: perfil.email,
    Address: {
      Street: null, ExteriorNumber: null, InteriorNumber: '',
      Neighborhood: null, ZipCode: perfil.cp, Locality: '',
      Municipality: null, State: null, Country: 'Mexico'
    },
    PaymentMethod: '04',
    CfdiUse: perfil.uso_cfdi || 'G03',
    IvaPercentage: null, ShowIeps: null, PaymentForm: null,
    FiscalRegime: perfil.regimen || '612'
  };
  const checkout = { Shop: shopName, order_id: String(orderId) };

  let shopInvoiceId, version, creditNoteId;
  try {
    const { data: saveData } = await axios.get(
      'https://app.facturama.mx/Shopify/Clients/SaveClient',
      {
        params: {
          dataClient: Buffer.from(JSON.stringify(dataClient)).toString('base64'),
          checkout: Buffer.from(JSON.stringify(checkout)).toString('base64')
        },
        headers, transformResponse: tr
      }
    );
    console.log(`[AUTO] ${tag} - SaveClient: ${JSON.stringify(saveData)}`);

    if (!saveData.success || !saveData.shopInvoiceId) {
      const errores = saveData.errors ? saveData.errors.join('; ') : 'RFC inválido o límite alcanzado';
      return { success: false, mensaje: `${tag}: ${errores}` };
    }
    if (saveData.createdByLimit === false) {
      return { success: false, mensaje: `${tag}: plazo de facturación vencido para esta orden` };
    }
    if (!saveData.orderStatus) {
      return { success: false, mensaje: `${tag}: orden pendiente de pago, factura se generará al acreditarse` };
    }
    shopInvoiceId = saveData.shopInvoiceId;
    creditNoteId = saveData.creditNoteId || 0;
    version = saveData.version || '40';
  } catch (e) {
    return { success: false, mensaje: `${tag}: error en SaveClient - ${e.message}` };
  }

  // 3. CreateCfdiStoreFront — genera el CFDI y envía por correo
  try {
    const invoiceId = creditNoteId > 0 ? creditNoteId : shopInvoiceId;
    const { data: cfdiData } = await axios.get(
      `https://app.facturama.mx/Shopify/Invoice${version}/CreateCfdiStoreFront`,
      { params: { ShopName: shopName, idShopifyInvoice: invoiceId, exchangeRate: '' }, headers, transformResponse: tr }
    );
    console.log(`[AUTO] ${tag} - CreateCfdi: ${JSON.stringify(cfdiData)}`);

    if (cfdiData.existInvoice) {
      return { success: true, mensaje: `${tag}: factura ya generada previamente, consulta tu correo` };
    }
    if (cfdiData.success) {
      const enviada = cfdiData.send ? ' y enviada al correo' : '';
      return { success: true, mensaje: `Factura ${tag} generada exitosamente${enviada}` };
    }
    return { success: false, mensaje: `${tag}: ${cfdiData.message || 'error al generar CFDI'}` };
  } catch (e) {
    return { success: false, mensaje: `${tag}: error en CreateCfdi - ${e.message}` };
  }
}

function detectarPortal(establecimiento, sistemaFacturacion) {
  // Prioridad: enrutar por sistema_facturacion si Claude lo identificó
  switch (sistemaFacturacion) {
    case 'facturama_shopify':
      return { key: 'facturama-shopify', ...PORTALES['facturama-shopify'] };
    case 'facturama_hd':
      return { key: 'home depot', ...PORTALES['home depot'] };
    case 'konesh':
      return { key: 'petro', ...PORTALES['petro'] };
    case 'oxxo_gas':
      return { key: 'oxxo gas', ...PORTALES['oxxo gas'] };
    case 'wansoft':
      // Wansoft no tiene implementación HTTP genérica todavía. Cada cliente
      // tiene su propio subdominio (factura.{empresa}.com.mx) y necesita
      // captura específica de su API. Marcamos manual para intervención.
      return null;
  }
  if (!establecimiento) return null;
  const n = establecimiento.toLowerCase();
  for (const [key, config] of Object.entries(PORTALES)) {
    if (key === 'facturama-shopify') continue; // skip el genérico en match por nombre
    if (n.includes(key)) return { key, ...config };
  }
  return null;
}

async function procesarFactura(solicitudId) {
  const solicitud = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
  if (!solicitud) throw new Error('Solicitud no encontrada');

  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(solicitud.usuario_id);
  if (!perfil) throw new Error('Perfil fiscal no configurado');

  const portal = detectarPortal(solicitud.establecimiento, solicitud.sistema_facturacion);
  if (!portal) {
    const detalle = solicitud.sistema_facturacion === 'wansoft'
      ? 'Portal Wansoft aún no soportado automáticamente — factura manualmente en el portal del comercio'
      : 'Portal no soportado aun';
    db.prepare('UPDATE solicitudes SET status=?, status_detalle=? WHERE id=?')
      .run('manual', detalle, solicitudId);
    return { success: false, manual: true, mensaje: detalle };
  }
  console.log(`[AUTO] Portal seleccionado: ${portal.key} (sistema=${solicitud.sistema_facturacion || 'N/A'} shop=${solicitud.shop_name || 'N/A'})`);

  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando', solicitudId);

  const ticketData = {
    folio: solicitud.folio,
    no_estacion: solicitud.estacion || '',
    web_id: solicitud.web_id || '',
    fecha_formateada: solicitud.fecha_compra || '',
    establecimiento: solicitud.establecimiento,
    total: solicitud.total,
    sistema_facturacion: solicitud.sistema_facturacion || null,
    shop_name: solicitud.shop_name || null
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
