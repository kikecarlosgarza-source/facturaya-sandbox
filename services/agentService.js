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

function determinarPortal(e,p) {
  const n=(e||'').toLowerCase();
  if(n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb';
  if(n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com';
  if(n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/';
  if(n.includes('bandeja')) return 'https://www.bandeja.mx/pages/facturacion-bandeja';
  if(p&&p.startsWith('http')) return p;
  return null;
}
function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }
async function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

async function screenshot(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 85, fullPage: false });
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
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando',solicitudId);

  const ctx = {
    folio:s.folio, fecha:s.fecha_compra, total:s.total,
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

    // Loop de Computer Use
    const messages = [{
      role: 'user',
      content: [{
        type: 'text',
        text: 'Completa la solicitud de factura electronica en este portal.\n\n' +
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

    while(iteraciones < MAX) {
      iteraciones++;
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
        if(e.response?.status === 429) { console.log('[CU] Rate limit, 30s...'); await sleep(30000); continue; }
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
            // Ejecutar accion en el browser
            await ejecutarAccion(page, block.input);
            await sleep(1500);
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
