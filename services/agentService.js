const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_PASOS = 20;

// ── TABLAS DE MEMORIA ────────────────────────────────────────────────────────
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS portal_knowledge (
    portal TEXT PRIMARY KEY,
    intentos INTEGER DEFAULT 0,
    exitosos INTEGER DEFAULT 0,
    conocimiento TEXT DEFAULT '{}',
    actualizado TEXT
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS patrones_globales (
    id INTEGER PRIMARY KEY,
    categoria TEXT,
    patron TEXT,
    confianza INTEGER DEFAULT 1,
    portales_confirmados TEXT DEFAULT '[]',
    actualizado TEXT
  )`).run();
} catch(e) {}

function getConocimiento(portal) {
  try { const r = db.prepare('SELECT conocimiento FROM portal_knowledge WHERE portal=?').get(portal); return r ? JSON.parse(r.conocimiento) : {}; } catch { return {}; }
}

function getPatronesGlobales() {
  try {
    const rows = db.prepare('SELECT * FROM patrones_globales ORDER BY confianza DESC').all();
    const p = {};
    for (const r of rows) { if (!p[r.categoria]) p[r.categoria] = []; p[r.categoria].push({patron:r.patron, confianza:r.confianza, portales:JSON.parse(r.portales_confirmados)}); }
    return p;
  } catch { return {}; }
}

function guardarConocimiento(portal, nuevo, exito) {
  try {
    const row = db.prepare('SELECT conocimiento FROM portal_knowledge WHERE portal=?').get(portal);
    const actual = row ? JSON.parse(row.conocimiento) : {};
    const merged = Object.assign({}, actual, nuevo);
    if (row) {
      db.prepare('UPDATE portal_knowledge SET intentos=intentos+1, exitosos=exitosos+?, conocimiento=?, actualizado=? WHERE portal=?')
        .run(exito?1:0, JSON.stringify(merged), new Date().toISOString(), portal);
    } else {
      db.prepare('INSERT INTO portal_knowledge (portal,intentos,exitosos,conocimiento,actualizado) VALUES (?,1,?,?,?)')
        .run(portal, exito?1:0, JSON.stringify(merged), new Date().toISOString());
    }
  } catch(e) { console.log('[AGENT] err guardando conocimiento:', e.message); }
}

function actualizarPatronGlobal(categoria, patron, portal) {
  try {
    const existing = db.prepare('SELECT * FROM patrones_globales WHERE categoria=? AND patron=?').get(categoria, patron);
    if (existing) {
      const portales = JSON.parse(existing.portales_confirmados);
      if (!portales.includes(portal)) portales.push(portal);
      db.prepare('UPDATE patrones_globales SET confianza=confianza+1, portales_confirmados=?, actualizado=? WHERE id=?')
        .run(JSON.stringify(portales), new Date().toISOString(), existing.id);
    } else {
      db.prepare('INSERT INTO patrones_globales (categoria,patron,confianza,portales_confirmados,actualizado) VALUES (?,?,1,?,?)')
        .run(categoria, patron, JSON.stringify([portal]), new Date().toISOString());
    }
    console.log('[AGENT] Patron global actualizado:', categoria, '->', patron.substring(0,60));
  } catch(e) {}
}

async function analizarYGeneralizarAprendizaje(portal, pasosExitosos, ctx) {
  try {
    console.log('[AGENT] Analizando aprendizaje para generalizar...');
    const prompt = `Analiza estos pasos exitosos de autofacturacion en ${portal} y extrae PATRONES GENERALES que podrian aplicar a CUALQUIER portal de facturacion mexicano.

PASOS EXITOSOS:
${JSON.stringify(pasosExitosos, null, 2)}

CONTEXTO USADO:
RFC: ${ctx.perfil.rfc}, Regimen: ${ctx.perfil.regimen}, CFDI: ${ctx.perfil.uso_cfdi}

Responde SOLO JSON sin backticks con patrones generalizables:
{
  "patrones": [
    {
      "categoria": "cerrar_popup | campo_rfc | campo_folio | campo_total | campo_email | campo_regimen | campo_uso_cfdi | campo_cp | boton_submit | boton_continuar | selector_generico",
      "patron": "el selector CSS o codigo JS que funciono",
      "descripcion": "cuando usar este patron",
      "confianza": 1-10
    }
  ],
  "insight_general": "aprendizaje clave de este portal que aplica a otros"
}`;

    const r = await axios.post(CLAUDE_API, {
      model: MODEL, max_tokens: 1000,
      messages: [{role:'user', content: prompt}]
    }, {headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});

    const txt = r.data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    let analisis; try { analisis = JSON.parse(txt.match(/\{[\s\S]*\}/)[0]); } catch { return; }

    for (const p of (analisis.patrones||[])) {
      if (p.confianza >= 6) actualizarPatronGlobal(p.categoria, p.patron, portal);
    }
    if (analisis.insight_general) {
      guardarConocimiento(portal, {insight: analisis.insight_general}, false);
      console.log('[AGENT] Insight:', analisis.insight_general.substring(0,100));
    }
  } catch(e) { console.log('[AGENT] err analizando:', e.message); }
}

async function screenshot(page) { const buf = await page.screenshot({type:'jpeg',quality:80,fullPage:false}); return buf.toString('base64'); }

function determinarPortal(e, p) { const n=(e||'').toLowerCase(); if(n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb'; if(n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com'; if(n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/'; if(n.includes('bandeja')) return 'https://www.bandeja.mx/facturacion'; if(p&&p.startsWith('http')) return p; return null; }

function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id=?').get(solicitudId);
  if (!s) throw new Error('No encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id=?').get(s.usuario_id);
  if (!p) throw new Error('Sin perfil');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if (!url) { db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Portal no identificado: '+s.establecimiento,solicitudId); return {success:false}; }

  const portal = dominioDe(url);
  const conocimientoPortal = getConocimiento(portal);
  const patronesGlobales = getPatronesGlobales();

  console.log('[AGENT] Portal:', portal);
  console.log('[AGENT] Conocimiento propio:', Object.keys(conocimientoPortal).length, 'claves');
  console.log('[AGENT] Patrones globales disponibles:', Object.keys(patronesGlobales).length, 'categorias');

  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando', solicitudId);

  const ctx = {
    establecimiento: s.establecimiento,
    folio: s.folio,
    fecha: s.fecha_compra,
    total: s.total,
    portal_url: url,
    perfil: {rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'},
    memoria: {
      conocimiento_este_portal: conocimientoPortal,
      patrones_globales_probados: patronesGlobales,
      instruccion: 'USA primero los patrones con mayor confianza. Cuando algo funcione, incluye selector en campo aprendizaje. Cuando algo falle, prueba el siguiente patron de la misma categoria.'
    }
  };

  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const pasosEjecutados = [];
  const erroresEsteIntento = [];

  try {
    const page = await (await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',viewport:{width:1280,height:800}})).newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(3000);

    // Aplicar patrones globales de cerrar_popup si los hay
    const patronesPopup = (patronesGlobales.cerrar_popup||[]).sort((a,b)=>b.confianza-a.confianza);
    for (const pat of patronesPopup.slice(0,3)) {
      await page.evaluate(pat.patron).catch(()=>{});
    }
    // Fallback generico
    await page.evaluate(()=>{
      ['[class*="popup"] [class*="close"]','[class*="modal"] [class*="close"]','.klaviyo-close-form','[data-dismiss="modal"]','.fancybox-close'].forEach(sel=>{const el=document.querySelector(sel);if(el&&el.offsetParent)el.click();});
      document.querySelectorAll('[class*="overlay"],[class*="backdrop"]').forEach(el=>{if(el.style)el.style.display='none';});
    }).catch(()=>{});
    await page.waitForTimeout(1000);

    const hist = [];
    let paso = 0;

    while (paso < MAX_PASOS) {
      paso++;
      console.log('[AGENT] Paso', paso);
      const sc = await screenshot(page);

      const sys = `Eres un agente de autofacturacion Mexico CFDI 4.0 que APRENDE y MEJORA con cada intento.

CONTEXTO Y MEMORIA:
${JSON.stringify(ctx, null, 2)}

ERRORES EN ESTE INTENTO (evitar repetir):
${JSON.stringify(erroresEsteIntento)}

REGLAS:
1. PRIORIZA patrones_globales con mayor confianza para cada tipo de campo
2. Para popups: usa SIEMPRE evaluate con JS, nunca click con selector
3. Cuando un selector funcione, guardalo en campo "aprendizaje" de tu respuesta
4. Si un patron falla, prueba el siguiente de la misma categoria
5. Sé eficiente: si ya conoces el selector exacto de un campo, usalo directo

Responde SOLO JSON sin backticks:
{"estado":"en_progreso o completado o error o captcha","descripcion":"pantalla","accion":"click o fill o navigate o wait o evaluate o ninguna","selector":"CSS","valor":"val","url":"url","js":"JS","aprendizaje":{"categoria":"selector_que_funciono"},"mensaje_final":"msg"}`;

      const r = await axios.post(CLAUDE_API,{model:MODEL,max_tokens:1000,system:sys,messages:[...hist,{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:sc}},{type:'text',text:'Siguiente accion.'}]}]},{headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});
      const txt = r.data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      let dec; try{dec=JSON.parse(txt.match(/\{[\s\S]*\}/)[0])}catch{dec={estado:'error',mensaje_final:'JSON invalido'}}
      console.log('[AGENT]',dec.estado,'|',dec.accion,'|',(dec.descripcion||'').substring(0,60));

      // Guardar aprendizaje inmediato
      if (dec.aprendizaje) {
        for (const [categoria, patron] of Object.entries(dec.aprendizaje)) {
          actualizarPatronGlobal(categoria, patron, portal);
        }
        const sel = conocimientoPortal.selectores || {};
        Object.assign(sel, dec.aprendizaje);
        guardarConocimiento(portal, {selectores: sel}, false);
      }

      hist.push({role:'user',content:[{type:'text',text:'Paso '+paso+': '+(dec.descripcion||'')}]});
      hist.push({role:'assistant',content:[{type:'text',text:JSON.stringify(dec)}]});
      if (hist.length>12) hist.splice(0,2);
      pasosEjecutados.push({paso,accion:dec.accion,selector:dec.selector,valor:dec.valor,descripcion:(dec.descripcion||'').substring(0,80)});

      if (dec.estado==='completado') {
        guardarConocimiento(portal, {pasos_exitosos:pasosEjecutados, ultimo_exito:new Date().toISOString()}, true);
        // Analizar y generalizar en background (no bloqueante)
        analizarYGeneralizarAprendizaje(portal, pasosEjecutados, ctx).catch(()=>{});
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado',dec.mensaje_final||'OK',solicitudId);
        return {success:true};
      }
      if (dec.estado==='captcha') { db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('captcha_required','Captcha',solicitudId); return {success:false}; }
      if (dec.estado==='error') {
        erroresEsteIntento.push(dec.mensaje_final||'Error paso '+paso);
        guardarConocimiento(portal, {errores:(conocimientoPortal.errores||[]).concat(erroresEsteIntento).slice(-20)}, false);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',dec.mensaje_final||'Error',solicitudId);
        return {success:false};
      }

      try {
        if(dec.accion==='click'&&dec.selector) await page.click(dec.selector,{timeout:8000,force:true});
        else if(dec.accion==='fill'&&dec.selector) await page.fill(dec.selector,String(dec.valor||''),{timeout:8000});
        else if(dec.accion==='navigate'&&dec.url) await page.goto(dec.url,{waitUntil:'domcontentloaded',timeout:30000});
        else if(dec.accion==='evaluate'&&dec.js) await page.evaluate(dec.js);
        else if(dec.accion==='wait') await page.waitForTimeout(2000);
        await page.waitForTimeout(1500);
      } catch(e) {
        console.log('[AGENT] err accion:',e.message);
        erroresEsteIntento.push('selector "'+dec.selector+'" fallo: '+e.message.substring(0,80));
        guardarConocimiento(portal, {errores:(conocimientoPortal.errores||[]).concat(erroresEsteIntento).slice(-20)}, false);
      }
    }

    guardarConocimiento(portal, {pasos_max:pasosEjecutados}, false);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Max pasos',solicitudId);
    return {success:false};

  } catch(e) {
    console.error('[AGENT]',e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return {success:false};
  } finally {
    await browser.close();
  }
}};
