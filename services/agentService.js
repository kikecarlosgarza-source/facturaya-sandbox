const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS portal_knowledge (
    portal TEXT PRIMARY KEY,
    intentos INTEGER DEFAULT 0,
    exitosos INTEGER DEFAULT 0,
    script_exitoso TEXT,
    conocimiento TEXT DEFAULT '{}',
    actualizado TEXT
  )`).run();
} catch(e) {}

function getKnowledge(portal) {
  try { const r = db.prepare('SELECT * FROM portal_knowledge WHERE portal=?').get(portal); return r || null; } catch { return null; }
}

function saveKnowledge(portal, data, exito) {
  try {
    const r = db.prepare('SELECT portal FROM portal_knowledge WHERE portal=?').get(portal);
    const now = new Date().toISOString();
    if (r) {
      db.prepare('UPDATE portal_knowledge SET intentos=intentos+1, exitosos=exitosos+?, script_exitoso=COALESCE(?,script_exitoso), conocimiento=?, actualizado=? WHERE portal=?')
        .run(exito?1:0, data.script||null, JSON.stringify(data.conocimiento||{}), now, portal);
    } else {
      db.prepare('INSERT INTO portal_knowledge(portal,intentos,exitosos,script_exitoso,conocimiento,actualizado) VALUES(?,1,?,?,?,?)')
        .run(portal, exito?1:0, data.script||null, JSON.stringify(data.conocimiento||{}), now);
    }
  } catch(e) { console.log('[AGENT] err saving:', e.message); }
}

async function screenshot(page) {
  const buf = await page.screenshot({ type: 'jpeg', quality: 75, fullPage: false });
  return buf.toString('base64');
}

function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }

function determinarPortal(e, p) {
  const n = (e||'').toLowerCase();
  if (n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb';
  if (n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com';
  if (n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/';
  if (n.includes('bandeja')) return 'https://www.bandeja.mx/pages/facturacion-bandeja';
  if (p && p.startsWith('http')) return p;
  return null;
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function claudeEjecutar(sc, ctx, historial, knowledge) {
  const sys = `Eres un agente experto en autofacturacion Mexico CFDI 4.0.
Tu trabajo: ver la pantalla y escribir JavaScript que se ejecutara DIRECTAMENTE en el browser para avanzar hacia completar la factura.

DATOS A USAR:
${JSON.stringify(ctx.perfil)}
TICKET: folio=${ctx.folio} total=${ctx.total} fecha=${ctx.fecha}
PORTAL: ${ctx.portal_url}

CONOCIMIENTO PREVIO DE ESTE PORTAL:
${knowledge ? JSON.stringify(JSON.parse(knowledge.conocimiento||'{}')).substring(0,500) : 'Primera vez en este portal'}
ERRORES ANTERIORES: ${ctx.errores?.join(', ')||'ninguno'}

REGLAS:
1. Escribe JS que ejecuta UNA accion clara: llenar campo, hacer click, cerrar popup, submit
2. El JS tiene acceso completo al DOM - usa document.querySelector, click(), fill values, etc
3. Para hacer click usa: el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true})) Y el.click()
4. Para llenar inputs: el.value='valor'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
5. Si ves que ya se completo exitosamente, indica estado=completado
6. En "aprendido" describe que selector/tecnica funciono para este portal

Responde SOLO JSON sin backticks:
{
  "estado": "ejecutar o completado o error o captcha",
  "descripcion": "que ves y que vas a hacer",
  "js": "codigo JavaScript completo a ejecutar en el browser",
  "aprendido": "que aprendiste sobre este portal para recordar",
  "mensaje_final": "solo si completado o error"
}`;

  let r, dec;
  try {
    r = await axios.post(CLAUDE_API, {
      model: MODEL, max_tokens: 1200,
      system: sys,
      messages: [...historial, {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sc } },
          { type: 'text', text: 'Que JS ejecuto ahora para avanzar?' }
        ]
      }]
    }, { headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' } });
    const txt = r.data.content.filter(b => b.type === 'text').map(b => b.text).join('');
    try { dec = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]); } catch { dec = { estado: 'error', mensaje_final: 'JSON invalido' }; }
  } catch(e) {
    if (e.response?.status === 429) throw new Error('RATE_LIMIT');
    dec = { estado: 'error', mensaje_final: 'API error: ' + e.message };
  }
  return dec;
}

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id=?').get(solicitudId);
  if (!s) throw new Error('No encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id=?').get(s.usuario_id);
  if (!p) throw new Error('Sin perfil');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if (!url) {
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual', 'Portal no identificado: '+s.establecimiento, solicitudId);
    return { success: false };
  }

  const portal = dominioDe(url);
  const knowledge = getKnowledge(portal);
  console.log('[AGENT]', portal, '| intentos previos:', knowledge?.intentos||0, '| exitosos:', knowledge?.exitosos||0);

  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando', solicitudId);

  const ctx = {
    folio: s.folio, fecha: s.fecha_compra, total: s.total,
    portal_url: url, establecimiento: s.establecimiento,
    perfil: { rfc: p.rfc, nombre: p.nombre, cp: p.cp, email: p.email, regimen: p.regimen||'612', uso_cfdi: p.uso_cfdi||'G03' },
    errores: []
  };

  // Si hay script exitoso guardado, intentarlo primero
  if (knowledge?.script_exitoso) {
    console.log('[AGENT] Intentando script exitoso guardado...');
    const browser2 = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    try {
      const page2 = await (await browser2.newContext({ userAgent: 'Mozilla/5.0', viewport: { width: 1280, height: 800 } })).newPage();
      await page2.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page2.waitForTimeout(3000);
      await page2.evaluate(knowledge.script_exitoso);
      await page2.waitForTimeout(5000);
      const t = await page2.textContent('body');
      if (t.includes('exitosa') || t.includes('enviada') || t.includes('correo') || t.includes('generada') || t.includes('factura')) {
        console.log('[AGENT] Script guardado exitoso!');
        saveKnowledge(portal, { script: knowledge.script_exitoso, conocimiento: JSON.parse(knowledge.conocimiento||'{}') }, true);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado', 'Factura generada (script guardado)', solicitudId);
        return { success: true };
      }
    } catch(e) { console.log('[AGENT] Script guardado fallo:', e.message); }
    finally { await browser2.close(); }
  }

  // Agente visual con Claude
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  const jsEjecutados = [];
  const aprendizajes = [];
  const MAX = 15;

  try {
    const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const hist = [];
    let paso = 0;

    while (paso < MAX) {
      paso++;
      await sleep(2500);
      console.log('[AGENT] Paso', paso);

      const sc = await screenshot(page);
      let dec;
      try {
        dec = await claudeEjecutar(sc, ctx, hist, knowledge);
      } catch(e) {
        if (e.message === 'RATE_LIMIT') { console.log('[AGENT] Rate limit, esperando 30s...'); await sleep(30000); continue; }
        throw e;
      }

      console.log('[AGENT]', dec.estado, '|', (dec.descripcion||'').substring(0, 70));
      if (dec.aprendido) { aprendizajes.push(dec.aprendido); console.log('[AGENT] Aprendido:', dec.aprendido.substring(0,80)); }

      hist.push({ role: 'user', content: [{ type: 'text', text: 'Paso ' + paso + ': ' + (dec.descripcion||'') }] });
      hist.push({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify(dec) }] });
      if (hist.length > 10) hist.splice(0, 2);

      if (dec.estado === 'completado') {
        // Guardar el JS completo que funcionó como script reutilizable
        const scriptFinal = jsEjecutados.join('\n// --- siguiente paso ---\n');
        saveKnowledge(portal, {
          script: scriptFinal,
          conocimiento: { aprendizajes, pasos: paso, ultima_vez: new Date().toISOString() }
        }, true);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado', dec.mensaje_final||'Factura generada', solicitudId);
        console.log('[AGENT] Exito en', paso, 'pasos. Script guardado para proxima vez.');
        return { success: true };
      }
      if (dec.estado === 'captcha') {
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('captcha_required', 'Captcha requerido', solicitudId);
        return { success: false };
      }
      if (dec.estado === 'error') {
        ctx.errores.push(dec.mensaje_final||'error paso '+paso);
        saveKnowledge(portal, { conocimiento: { errores: ctx.errores, aprendizajes } }, false);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error', dec.mensaje_final||'Error', solicitudId);
        return { success: false };
      }

      // Ejecutar el JS que Claude escribio
      if (dec.js) {
        try {
          await page.evaluate(dec.js);
          jsEjecutados.push(dec.js);
          await page.waitForTimeout(1500);
        } catch(e) {
          console.log('[AGENT] JS error:', e.message.substring(0,100));
          ctx.errores.push('JS fallo: ' + e.message.substring(0,80));
        }
      }
    }

    saveKnowledge(portal, { conocimiento: { aprendizajes, errores: ctx.errores } }, false);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual', 'Max pasos alcanzado', solicitudId);
    return { success: false };

  } catch(e) {
    console.error('[AGENT]', e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error', e.message.substring(0,200), solicitudId);
    return { success: false };
  } finally {
    await browser.close();
  }
}};
