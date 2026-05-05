const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const DISPLAY_WIDTH = 1280;
const DISPLAY_HEIGHT = 800;

try { db.prepare('CREATE TABLE IF NOT EXISTS portal_knowledge (portal TEXT PRIMARY KEY, intentos INTEGER DEFAULT 0, exitosos INTEGER DEFAULT 0, conocimiento TEXT DEFAULT "{}", actualizado TEXT)').run(); } catch(e) {}

function getKnowledge(p) { try { return db.prepare('SELECT * FROM portal_knowledge WHERE portal=?').get(p)||null; } catch { return null; } }
function saveKnowledge(portal, data, exito) {
  try {
    const r = db.prepare('SELECT portal FROM portal_knowledge WHERE portal=?').get(portal);
    const now = new Date().toISOString();
    const c = JSON.stringify(data||{});
    if(r) db.prepare('UPDATE portal_knowledge SET intentos=intentos+1,exitosos=exitosos+?,conocimiento=?,actualizado=? WHERE portal=?').run(exito?1:0,c,now,portal);
    else db.prepare('INSERT INTO portal_knowledge(portal,intentos,exitosos,conocimiento,actualizado) VALUES(?,1,?,?,?)').run(portal,exito?1:0,c,now);
  } catch(e) { console.log('[CU] err saving:',e.message); }
}

const ALSEA_MARCAS = [
  'vips','starbucks','dominos',"domino's",'burger king',
  'chilis',"chili's",'p.f. chang','pf chang','italianni','el portón','el porton'
];

function determinarPortal(e,p) {
  const n=(e||'').toLowerCase();
  if(n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb';
  if(n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com';
  if(n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/';
  if(n.includes('bandeja')) return 'https://www.bandeja.mx/pages/facturacion-bandeja';
  if(ALSEA_MARCAS.some(m => n.includes(m))) return 'https://alsea.interfactura.com';
  if(p&&p.startsWith('http')) return p;
  return null;
}
function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }

function urlPattern(url) {
  try { const u = new URL(url); return u.host + u.pathname; } catch { return url; }
}

function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const tlds = new Set(['com','org','net','gob','edu','mx','us','co']);
    while (parts.length > 1 && tlds.has(parts[parts.length - 1].toLowerCase())) parts.pop();
    return parts[parts.length - 1] || host;
  } catch { return ''; }
}

function placeholderize(text, ctx) {
  if (!text) return text;
  let result = String(text);
  const subs = [
    ['{{folio}}',    String(ctx.folio || '')],
    ['{{rfc}}',      ctx.perfil.rfc || ''],
    ['{{nombre}}',   ctx.perfil.nombre || ''],
    ['{{cp}}',       ctx.perfil.cp || ''],
    ['{{email}}',    ctx.perfil.email || ''],
    ['{{regimen}}',  ctx.perfil.regimen || ''],
    ['{{uso_cfdi}}', ctx.perfil.uso_cfdi || ''],
    ['{{total}}',    String(ctx.total || '')],
    ['{{fecha}}',    String(ctx.fecha || '')]
  ].filter(([, v]) => v && v.length >= 2)
   .sort((a, b) => b[1].length - a[1].length);
  for (const [ph, val] of subs) {
    const re = new RegExp(val.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    if (re.test(result)) result = result.replace(re, ph);
  }
  return result;
}

async function captureSelectorAt(page, coord) {
  if (!Array.isArray(coord)) return { selector: null, tag: null };
  try {
    const info = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      function escId(s) { try { return CSS.escape(s); } catch { return s; } }
      function build(e) {
        if (e.id) return '#' + escId(e.id);
        const name = e.getAttribute && e.getAttribute('name');
        if (name) return e.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\"') + '"]';
        const path = [];
        let cur = e;
        while (cur && cur.nodeType === 1 && cur !== document.body) {
          let part = cur.tagName.toLowerCase();
          const cls = (cur.className && typeof cur.className === 'string') ? cur.className : '';
          if (cls) {
            const c = cls.split(/\s+/).filter(Boolean).slice(0, 2).map(escId).join('.');
            if (c) part += '.' + c;
          }
          const parent = cur.parentNode;
          if (parent && parent.children) {
            const same = Array.from(parent.children).filter(s => s.tagName === cur.tagName);
            if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
          }
          path.unshift(part);
          if (path.length > 4) break;
          cur = cur.parentNode;
        }
        return path.join(' > ');
      }
      return { selector: build(el), tag: el.tagName };
    }, coord);
    return info || { selector: null, tag: null };
  } catch {
    return { selector: null, tag: null };
  }
}

// Hints específicos por portal. El agente entra a ciegas; cada hint le da
// los campos exactos del form, su orden y el valor que debe inyectar.
// Reglas comunes (NO presionar F11/Escape, usar valores literales) las
// repetimos por hint en lugar de un system prompt para que estén siempre
// junto a los pasos.
function buildHintForPortal(url, ctx) {
  if (url.includes('alsea.interfactura.com')) {
    const tienda = ctx.numero_tienda || '(no detectado en el ticket — búscalo)';
    return (
      'Pasos exactos para alsea.interfactura.com - llena estos campos y presiona Enviar:\n' +
      '1. RFC: ' + ctx.perfil.rfc + '\n' +
      '2. Número de ticket (9 dígitos): ' + ctx.folio + '\n' +
      '3. Número de tienda (5 dígitos): ' + tienda + '\n' +
      '4. Fecha de consumo: ' + ctx.fecha + '\n' +
      '5. Monto total: ' + ctx.total + '\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n' +
      'Solo llena los 5 campos visibles y presiona Enviar.\n\n'
    );
  }
  if (url.includes('shell.com.mx/electronic-billing')) {
    return (
      'shell.com.mx/electronic-billing NO tiene un form único — es un selector de estado.\n' +
      'La página muestra una lista de estados de México (Aguascalientes, CDMX, Coahuila, etc.).\n' +
      'Cada estado redirige a un portal específico de Shell para esa región.\n' +
      'Pasos:\n' +
      '1. Identifica el estado de la estación Shell donde se cargó. Si el ticket o el establecimiento "' + (ctx.establecimiento || '') + '" no permite determinarlo, reporta el problema.\n' +
      '2. Click en el estado correspondiente.\n' +
      '3. En el portal del estado, busca el form de facturación y llénalo con:\n' +
      '   RFC: ' + ctx.perfil.rfc + ', Nombre: ' + ctx.perfil.nombre + ', CP: ' + ctx.perfil.cp + ', Email: ' + ctx.perfil.email + '\n' +
      '   Folio: ' + ctx.folio + ', Total: ' + ctx.total + ', Fecha: ' + ctx.fecha + '\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }
  if (url.includes('heb.com.mx')) {
    const tienda = ctx.numero_tienda || '(busca el número de Sucursal en el ticket)';
    return (
      'Pasos exactos para facturacion.heb.com.mx - llena los 4 campos del form "Agregar ticket":\n' +
      '1. Sucursal: ' + tienda + ' (es un autocomplete: escribe el número, espera la opción y selecciónala)\n' +
      '2. Ticket: ' + ctx.folio + ' (campo numérico)\n' +
      '3. Fecha: ' + ctx.fecha + ' (datepicker, formato dd/mm/aaaa)\n' +
      '4. Venta (Total): ' + ctx.total + '\n' +
      'Después presiona el botón "Agregar ticket". Luego el portal pedirá datos fiscales:\n' +
      'RFC ' + ctx.perfil.rfc + ', CP ' + ctx.perfil.cp + ', Email ' + ctx.perfil.email + '.\n' +
      'NO presiones F11, Escape ni teclas de sistema.\n\n'
    );
  }
  return '';
}

async function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function screenshot(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false });
  return buf.toString('base64');
}

// Ejecutar accion de Computer Use en Playwright
async function ejecutarAccion(page, action) {
  const type = action.type;
  console.log('[CU] Ejecutando:', type, JSON.stringify(action).substring(0,80));

  switch(type) {
    case 'screenshot':
      // Solo retornar screenshot, no hacer nada
      break;

    case 'left_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1]);
      await sleep(800);
      break;

    case 'right_click':
      await page.mouse.click(action.coordinate[0], action.coordinate[1], { button: 'right' });
      await sleep(500);
      break;

    case 'double_click':
      await page.mouse.dblclick(action.coordinate[0], action.coordinate[1]);
      await sleep(500);
      break;

    case 'type':
      await page.keyboard.type(action.text, { delay: 50 });
      await sleep(300);
      break;

    case 'key':
      await page.keyboard.press(action.key);
      await sleep(300);
      break;

    case 'scroll':
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      await page.mouse.wheel(0, action.direction === 'down' ? 300 : -300);
      await sleep(300);
      break;

    case 'mouse_move':
      await page.mouse.move(action.coordinate[0], action.coordinate[1]);
      break;
  }
}

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id=?').get(solicitudId);
  if(!s) throw new Error('No encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id=?').get(s.usuario_id);
  if(!p) throw new Error('Sin perfil fiscal');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if(!url) {
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Portal no identificado: '+s.establecimiento,solicitudId);
    return {success:false};
  }

  const portal = dominioDe(url);
  const knowledge = getKnowledge(portal);
  console.log('[CU]',portal,'| intentos:',knowledge?knowledge.intentos:0,'| exitosos:',knowledge?knowledge.exitosos:0);
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando_agente_visual',solicitudId);

  const ctx = {
    folio:s.folio, fecha:s.fecha_compra, total:s.total,
    numero_tienda: s.numero_tienda || '',
    portal_url:url, establecimiento:s.establecimiento,
    perfil:{rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'}
  };

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--window-size=1280,800']
  });

  try {
    const page = await (await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT }
    })).newPage();

    await page.addInitScript(function(){ Object.defineProperty(navigator,'webdriver',{get:function(){return undefined;}}); });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    // Hint específico por dominio: el agente entra a ciegas, así que cuando
    // sabemos algo del portal (multi-marca, flujo de código de autorización,
    // etc.) se lo decimos en el prompt para que no lo descubra desde cero.
    const hintDominio = buildHintForPortal(url, ctx);

    // Loop de Computer Use
    const messages = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Completa la solicitud de factura electronica en este portal.\n\n' +
          hintDominio +
          'DATOS DEL TICKET:\n' +
          '- Folio/Orden: ' + ctx.folio + '\n' +
          '- Total: $' + ctx.total + '\n' +
          '- Fecha: ' + ctx.fecha + '\n\n' +
          'DATOS FISCALES:\n' +
          '- RFC: ' + ctx.perfil.rfc + '\n' +
          '- Nombre: ' + ctx.perfil.nombre + '\n' +
          '- CP: ' + ctx.perfil.cp + '\n' +
          '- Email: ' + ctx.perfil.email + '\n' +
          '- Regimen fiscal: ' + ctx.perfil.regimen + '\n' +
          '- Uso CFDI: ' + ctx.perfil.uso_cfdi + '\n\n' +
          'Toma un screenshot para ver el estado actual y comienza.'
      }]
    }];

    let iteraciones = 0;
    const MAX = 20;
    const recording = [];

    while(iteraciones < MAX) {
      iteraciones++;
      await sleep(3000); // evitar rate limit
      console.log('[CU] Iteracion', iteraciones);

      // Tomar screenshot actual
      const sc = await screenshot(page);

      // Agregar screenshot al ultimo mensaje si es tool_result, o como nuevo mensaje
      const ultimoMsg = messages[messages.length-1];
      if(ultimoMsg.role === 'user' && Array.isArray(ultimoMsg.content)) {
        // Si el ultimo mensaje es tool_result, ya tiene el screenshot
        // Si no, agregar screenshot
        const tieneImagen = ultimoMsg.content.some(c => c.type === 'tool_result');
        if(!tieneImagen) {
          ultimoMsg.content.push({
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: sc }
          });
        }
      }

      let response;
      try {
        response = await axios.post(CLAUDE_API, {
          model: MODEL,
          max_tokens: 1024,
          tools: [{
            type: 'computer_20251124',
            name: 'computer',
            display_width_px: DISPLAY_WIDTH,
            display_height_px: DISPLAY_HEIGHT
          }],
          messages: messages
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'computer-use-2025-11-24'
          }
        });
      } catch(e) {
        if(e.response?.status === 429) { console.log('[CU] Rate limit, esperando 60s...'); await sleep(60000); continue; }
        throw e;
      }

      const respuesta = response.data;
      console.log('[CU] Stop reason:', respuesta.stop_reason);

      // Agregar respuesta de Claude al historial
      messages.push({ role: 'assistant', content: respuesta.content });

      // Si Claude termino
      if(respuesta.stop_reason === 'end_turn') {
        const textoFinal = respuesta.content.filter(b=>b.type==='text').map(b=>b.text).join('');
        console.log('[CU] Claude termino:', textoFinal.substring(0,150));

        // Verificar si fue exitoso
        const cuerpo = await page.textContent('body').catch(()=>'');
        const exitoso = textoFinal.toLowerCase().includes('exit') ||
          textoFinal.toLowerCase().includes('complet') ||
          textoFinal.toLowerCase().includes('factura') ||
          cuerpo.includes('exitosa') || cuerpo.includes('enviada') || cuerpo.includes('generada');

        if(exitoso) {
          saveKnowledge(portal, { ultimo_exito: new Date().toISOString() }, true);

          // Persistir macro reproducible para que handlerUniversal lo replaye
          // sin gastar tokens de visión la próxima vez.
          if (recording.length > 0) {
            try {
              const macro = {
                version: 1,
                url_pattern: urlPattern(url),
                viewport: { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT },
                steps: recording
              };
              db.prepare(`INSERT INTO portal_scripts (portal, step, patch_js, descripcion, confidence, active)
                          VALUES (?, ?, ?, ?, ?, 1)`).run(
                brandFromUrl(url),
                'agente_visual_exitoso',
                JSON.stringify(macro),
                `Macro Computer Use para ${portal}`,
                0.9
              );
              console.log('[CU] Macro guardado:', recording.length, 'pasos');
            } catch (e) {
              console.log('[CU] err saving macro:', e.message);
            }
          }

          db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado','Factura generada via Computer Use',solicitudId);
          console.log('[CU] EXITO!');
          return { success: true };
        }
        break;
      }

      // Procesar tool_use (acciones de Computer Use)
      if(respuesta.stop_reason === 'tool_use') {
        const toolResults = [];

        for(const block of respuesta.content) {
          if(block.type !== 'tool_use') continue;

          let resultado;
          if(block.input.action === 'screenshot') {
            // Tomar screenshot y retornarlo
            await sleep(1000);
            const sc2 = await screenshot(page);
            resultado = [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: sc2 }
            }];
          } else {
            // Capturar selector ANTES de ejecutar el click — el DOM puede mutar tras la acción
            const action = block.input.action;
            const isClick = action === 'left_click' || action === 'right_click' || action === 'double_click';
            let selectorInfo = { selector: null, tag: null };
            if (isClick) {
              selectorInfo = await captureSelectorAt(page, block.input.coordinate);
            }

            // Ejecutar accion en el browser
            await ejecutarAccion(page, block.input);
            await sleep(1500);

            // Registrar paso reproducible
            if (isClick) {
              recording.push({
                type: action,
                coord: block.input.coordinate,
                selector: selectorInfo.selector,
                tag: selectorInfo.tag,
                wait: 800
              });
            } else if (action === 'type') {
              recording.push({
                type: 'type',
                text: placeholderize(block.input.text, ctx),
                wait: 300
              });
            } else if (action === 'key') {
              recording.push({
                type: 'key',
                key: block.input.key,
                wait: 300
              });
            } else if (action === 'scroll') {
              recording.push({
                type: 'scroll',
                coord: block.input.coordinate,
                direction: block.input.direction,
                wait: 300
              });
            }

            // Tomar screenshot del resultado
            const sc3 = await screenshot(page);
            resultado = [{
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: sc3 }
            }];
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: resultado
          });
        }

        // Agregar resultados al historial
        messages.push({ role: 'user', content: toolResults });
      }
    }

    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Computer Use agoto iteraciones',solicitudId);
    return { success: false };

  } catch(e) {
    console.error('[CU] Error:', e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return { success: false };
  } finally {
    await browser.close();
  }
}};
