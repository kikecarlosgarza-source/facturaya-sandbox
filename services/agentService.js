const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const MAX_PASOS = 20;

// ── MEMORIA DE PORTALES ──────────────────────────────────────────────────────
// Inicializar tabla de conocimiento si no existe
try {
  db.prepare(`CREATE TABLE IF NOT EXISTS portal_knowledge (
    portal TEXT PRIMARY KEY,
    intentos INTEGER DEFAULT 0,
    exitosos INTEGER DEFAULT 0,
    conocimiento TEXT DEFAULT '{}',
    actualizado TEXT
  )`).run();
} catch(e) {}

function getConocimiento(portal) {
  try {
    const row = db.prepare('SELECT * FROM portal_knowledge WHERE portal = ?').get(portal);
    return row ? JSON.parse(row.conocimiento) : {};
  } catch(e) { return {}; }
}

function guardarConocimiento(portal, nuevo, exito) {
  try {
    const row = db.prepare('SELECT * FROM portal_knowledge WHERE portal = ?').get(portal);
    const actual = row ? JSON.parse(row.conocimiento) : {};
    const merged = Object.assign(actual, nuevo);
    if (row) {
      db.prepare('UPDATE portal_knowledge SET intentos=intentos+1, exitosos=exitosos+?, conocimiento=?, actualizado=? WHERE portal=?')
        .run(exito?1:0, JSON.stringify(merged), new Date().toISOString(), portal);
    } else {
      db.prepare('INSERT INTO portal_knowledge (portal, intentos, exitosos, conocimiento, actualizado) VALUES (?,1,?,?,?)')
        .run(portal, exito?1:0, JSON.stringify(merged), new Date().toISOString());
    }
  } catch(e) { console.log('[AGENT] Error guardando conocimiento:', e.message); }
}

async function screenshot(page) { const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false }); return buf.toString('base64'); }

function determinarPortal(e, p) { const n = (e||'').toLowerCase(); if (n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb'; if (n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com'; if (n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/'; if (n.includes('bandeja')) return 'https://www.bandeja.mx/facturacion'; if (p && p.startsWith('http')) return p; return null; }

function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
  if (!s) throw new Error('No encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(s.usuario_id);
  if (!p) throw new Error('Sin perfil');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if (!url) { db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Portal no identificado: '+s.establecimiento,solicitudId); return {success:false}; }

  const portal = dominioDe(url);
  const conocimiento = getConocimiento(portal);
  const pasosSolucion = conocimiento.pasos_exitosos || [];
  const erroresConocidos = conocimiento.errores || [];
  const selectoresConocidos = conocimiento.selectores || {};

  console.log('[AGENT] Iniciando:',s.establecimiento,'->',url);
  console.log('[AGENT] Conocimiento previo:', JSON.stringify({pasos: pasosSolucion.length, selectores: Object.keys(selectoresConocidos).length}));
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando',solicitudId);

  const ctx = {
    establecimiento: s.establecimiento,
    folio: s.folio,
    fecha: s.fecha_compra,
    total: s.total,
    portal_url: url,
    perfil: {rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'},
    conocimiento_previo: {
      selectores_que_funcionaron: selectoresConocidos,
      errores_a_evitar: erroresConocidos,
      pasos_exitosos_anteriores: pasosSolucion
    }
  };

  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const pasosEjecutados = [];
  let exito = false;

  try {
    const page = await (await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',viewport:{width:1280,height:800}})).newPage();
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(3000);

    // Cerrar popups al inicio via JS
    await page.evaluate(()=>{
      const sels=['[class*="popup"] [class*="close"]','[class*="modal"] [class*="close"]','[class*="overlay"] [class*="close"]','button[class*="dismiss"]','[data-dismiss]','.klaviyo-close-form','.needsclick[class*="close"]'];
      for(const sel of sels){const el=document.querySelector(sel);if(el&&el.offsetParent!==null){el.click();}}
      document.querySelectorAll('[class*="overlay"],[class*="backdrop"]').forEach(el=>{if(el.style)el.style.display='none';});
    }).catch(()=>{});
    await page.waitForTimeout(1000);

    const hist = [];
    let paso = 0;

    while(paso < MAX_PASOS) {
      paso++;
      console.log('[AGENT] Paso', paso);
      const sc = await screenshot(page);
      const sys = `Eres agente experto en autofacturacion Mexico CFDI 4.0. APRENDE de cada intento.

CONTEXTO: ${JSON.stringify(ctx)}

REGLAS CRITICAS:
1. USA los selectores_que_funcionaron del conocimiento_previo cuando apliquen
2. EVITA los errores_a_evitar del conocimiento_previo  
3. Para popups/modales: usa SIEMPRE accion=evaluate con JS para cerrarlos, NO uses click con selector
4. Cuando llenes un campo exitosamente, anota el selector en tu razonamiento
5. Al completar exitosamente incluye en mensaje_final los selectores que funcionaron como JSON

Responde SOLO JSON sin backticks:
{"estado":"en_progreso o completado o error o captcha","descripcion":"pantalla actual","accion":"click o fill o navigate o wait o evaluate o ninguna","selector":"CSS exacto","valor":"val","url":"url","js":"codigo JS","aprendizaje":{"selector_exitoso":"nombre:selector"},"mensaje_final":"msg"}`;

      const r = await axios.post(CLAUDE_API,{model:MODEL,max_tokens:1000,system:sys,messages:[...hist,{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:sc}},{type:'text',text:'Siguiente accion.'}]}]},{headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});
      const txt = r.data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
      let dec; try{dec=JSON.parse(txt.match(/\{[\s\S]*\}/)[0])}catch{dec={estado:'error',mensaje_final:'JSON invalido'}}
      console.log('[AGENT]',dec.estado,'|',dec.accion,'|',(dec.descripcion||'').substring(0,60));

      // Guardar aprendizaje en tiempo real
      if(dec.aprendizaje) {
        const nuevosSelectores = Object.assign(selectoresConocidos, dec.aprendizaje);
        guardarConocimiento(portal, {selectores: nuevosSelectores}, false);
      }

      hist.push({role:'user',content:[{type:'text',text:'Paso '+paso+': '+(dec.descripcion||'')}]});
      hist.push({role:'assistant',content:[{type:'text',text:JSON.stringify(dec)}]});
      if(hist.length>12)hist.splice(0,2);

      pasosEjecutados.push({paso,accion:dec.accion,selector:dec.selector,descripcion:dec.descripcion});

      if(dec.estado==='completado') {
        exito = true;
        // Guardar lo que aprendimos de este éxito
        guardarConocimiento(portal, {
          pasos_exitosos: pasosEjecutados,
          selectores: Object.assign(selectoresConocidos, dec.aprendizaje||{}),
          ultimo_exito: new Date().toISOString()
        }, true);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado',dec.mensaje_final||'OK',solicitudId);
        return {success:true};
      }
      if(dec.estado==='captcha'){db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('captcha_required','Captcha',solicitudId);return{success:false}}
      if(dec.estado==='error') {
        // Guardar el error para no repetirlo
        erroresConocidos.push(dec.mensaje_final||'Error desconocido paso '+paso);
        guardarConocimiento(portal, {errores: erroresConocidos}, false);
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
        console.log('[AGENT] err:',e.message);
        erroresConocidos.push('selector "'+dec.selector+'" fallo: '+e.message.substring(0,80));
        guardarConocimiento(portal, {errores: erroresConocidos.slice(-10)}, false);
      }
    }

    guardarConocimiento(portal, {pasos_max_alcanzados: true, ultimo_intento_pasos: pasosEjecutados}, false);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Max pasos alcanzados',solicitudId);
    return {success:false};

  } catch(e) {
    console.error('[AGENT]',e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return {success:false};
  } finally {
    await browser.close();
  }
}};
