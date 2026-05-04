const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

// Inicializar y migrar tabla de conocimiento
try { db.prepare('CREATE TABLE IF NOT EXISTS portal_knowledge (portal TEXT PRIMARY KEY, intentos INTEGER DEFAULT 0, exitosos INTEGER DEFAULT 0, script_exitoso TEXT, conocimiento TEXT DEFAULT "{}", actualizado TEXT)').run(); } catch(e) {}
try { db.prepare('ALTER TABLE portal_knowledge ADD COLUMN script_exitoso TEXT').run(); } catch(e) {}

function getKnowledge(p) { try { return db.prepare('SELECT * FROM portal_knowledge WHERE portal=?').get(p)||null; } catch { return null; } }
function saveKnowledge(portal, data, exito) {
  try {
    const r = db.prepare('SELECT portal FROM portal_knowledge WHERE portal=?').get(portal);
    const now = new Date().toISOString();
    const c = JSON.stringify(data.conocimiento||{});
    if(r) db.prepare('UPDATE portal_knowledge SET intentos=intentos+1,exitosos=exitosos+?,script_exitoso=COALESCE(?,script_exitoso),conocimiento=?,actualizado=? WHERE portal=?').run(exito?1:0,data.script||null,c,now,portal);
    else db.prepare('INSERT INTO portal_knowledge(portal,intentos,exitosos,script_exitoso,conocimiento,actualizado) VALUES(?,1,?,?,?,?)').run(portal,exito?1:0,data.script||null,c,now);
  } catch(e) { console.log('[AGENT] err saving:',e.message); }
}

async function screenshot(page) { return (await page.screenshot({type:'jpeg',quality:50,fullPage:false})).toString('base64'); }
function dominioDe(url) { try { return new URL(url).hostname.replace('www.',''); } catch { return url; } }
function determinarPortal(e,p) {
  const n=(e||'').toLowerCase();
  if(n.includes('home depot')) return 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb';
  if(n.includes('oxxo gas')) return 'https://facturacion.oxxogas.com';
  if(n.includes('petro')) return 'https://tarjetapetro-7.com.mx:8443/KPortalExterno/';
  if(n.includes('bandeja')) return 'https://www.bandeja.mx/pages/facturacion-bandeja';
  if(p&&p.startsWith('http')) return p;
  return null;
}
async function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// Limpiar popups antes de cada paso
async function limpiarPopups(page) {
  await page.evaluate(function() {
    var selectores = ['[class*="klaviyo"]','[class*="newsletter"]','[class*="popup"]','[class*="Popup"]','[id*="popup"]','[class*="overlay"]:not([class*="header"])','[class*="modal"]:not([role="main"])','.pswp','#gorgias-chat-container'];
    selectores.forEach(function(s) { var els = document.querySelectorAll(s); els.forEach(function(el) { if(el.style) el.style.display='none'; }); });
    document.body.style.overflow = '';
    document.body.classList.remove('modal-open','swal2-shown','swal2-height-auto');
  }).catch(function(){});
}

async function claudeEjecutar(sc, ctx, hist, knowledge) {
  const sys = 'Eres un agente experto en portales de autofacturacion de Mexico CFDI 4.0.\nTu unica tarea: analizar la pantalla y escribir JavaScript que avance hacia completar la factura.\n\nDATOS DEL TICKET:\nEstablecimiento: '+ctx.establecimiento+'\nFolio/Orden: '+ctx.folio+'\nTotal: '+ctx.total+'\nFecha: '+ctx.fecha+'\nPortal URL: '+ctx.portal_url+'\n\nDATOS FISCALES A INGRESAR:\nRFC: '+ctx.perfil.rfc+'\nNombre: '+ctx.perfil.nombre+'\nCP: '+ctx.perfil.cp+'\nEmail: '+ctx.perfil.email+'\nRegimen fiscal: '+ctx.perfil.regimen+'\nUso CFDI: '+ctx.perfil.uso_cfdi+'\n\nCONOCIMIENTO PREVIO: '+(knowledge?JSON.stringify(JSON.parse(knowledge.conocimiento||'{}')).substring(0,600):'Primera vez en este portal')+'\n\nERRORES PREVIOS (evitar): '+(ctx.errores&&ctx.errores.length?ctx.errores.slice(-5).join(' | '):'ninguno')+'\n\nREGLAS ABSOLUTAS DEL JAVASCRIPT:\n1. JAMAS uses "return" en el nivel superior - causara SyntaxError fatal\n2. El JS se ejecuta como script directo, NO como funcion\n3. Para clicks: var el=document.querySelector(\'css\'); if(el){el.dispatchEvent(new MouseEvent(\'click\',{bubbles:true,cancelable:true,view:window}));el.click();}\n4. Para inputs: var inp=document.querySelector(\'css\'); if(inp){inp.value=\'valor\';inp.dispatchEvent(new Event(\'input\',{bubbles:true}));inp.dispatchEvent(new Event(\'change\',{bubbles:true}));}\n5. Para selects: var sel=document.querySelector(\'select\'); if(sel){var opt=Array.from(sel.options).find(function(o){return o.value===\'612\'||o.text.includes(\'612\');});if(opt){sel.value=opt.value;sel.dispatchEvent(new Event(\'change\',{bubbles:true}));}}\n6. Para iframes cross-origin: NO puedes acceder al contenido. En su lugar indica iframe_selector en tu respuesta para que Playwright lo maneje\n7. Para eliminar popups: document.querySelectorAll(\'[class*="popup"],[class*="overlay"],[class*="modal"]\').forEach(function(e){e.style.display=\'none\';});document.body.style.overflow=\'\';\n8. Para buscar por texto: var btns=Array.from(document.querySelectorAll(\'button,a\'));var btn=btns.find(function(b){return b.textContent.trim()===\'BUSCAR\'||b.textContent.trim()===\'Buscar\';});if(btn)btn.click();\n9. IMPORTANTE: El script guardado debe usar VARIABLES DEL CONTEXTO, no valores hardcodeados del ticket anterior\n\nFLUJO TIPICO:\nPaso 1: eliminar popups | Paso 2: llenar folio y total | Paso 3: click BUSCAR\nPaso 4: llenar RFC nombre CP email regimen uso CFDI | Paso 5: click GENERAR | Paso 6: confirmacion\n\nCUANDO DETECTAS EXITO REAL: busca selectores especificos como .success, .confirmacion, textos como "factura enviada al correo", "CFDI generado" - NO el texto general de la pagina\n\nRespuesta SOLO JSON sin backticks:\n{"estado":"ejecutar o completado o error o captcha","descripcion":"que ves exactamente","js":"JavaScript valido sin return en top level","iframe_selector":"selector del iframe si el formulario esta dentro (o null)","iframe_accion":"fill o click (si aplica)","iframe_target":"selector dentro del iframe (si aplica)","iframe_valor":"valor a escribir (si fill)","aprendido":"selectores que funcionan aqui","mensaje_final":"solo si completado o error"}';

  try {
    const r = await axios.post(CLAUDE_API, {
      model: MODEL, max_tokens: 1500, system: sys,
      messages: [...hist, {role:'user',content:[
        {type:'image',source:{type:'base64',media_type:'image/jpeg',data:sc}},
        {type:'text',text:'Que JavaScript ejecuto ahora para avanzar?'}
      ]}]
    }, {headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});
    const txt = r.data.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    const clean = txt.replace(/```[\w]*/g,'').replace(/```/g,'').trim();
    try { return JSON.parse(clean); } catch {
      // Intentar extraer JSON aunque este truncado
      try {
        var start = clean.indexOf('{');
        if(start>=0){
          // Buscar el JSON completo progressivamente
          for(var end=clean.length;end>start;end--){
            try{ var candidate=clean.substring(start,end); JSON.parse(candidate); return JSON.parse(candidate); }catch{}
          }
        }
      } catch {}
      // Si el JS en el JSON esta truncado, retornar solo wait
      console.log('[AGENT] JSON truncado de Claude, esperando...');
      return {estado:'ejecutar',descripcion:'JSON truncado - esperando',js:'void 0;',aprendido:''};
    }
  } catch(e) {
    if(e.response&&e.response.status===429) throw new Error('RATE_LIMIT');
    return {estado:'error',mensaje_final:'API error: '+e.message};
  }
}

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id=?').get(solicitudId);
  if(!s) throw new Error('Solicitud no encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id=?').get(s.usuario_id);
  if(!p) throw new Error('Perfil fiscal no configurado');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if(!url) { db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Portal no identificado: '+s.establecimiento,solicitudId); return {success:false}; }

  const portal = dominioDe(url);
  const knowledge = getKnowledge(portal);
  console.log('[AGENT]',portal,'| intentos:',knowledge?knowledge.intentos:0,'| exitosos:',knowledge?knowledge.exitosos:0);
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando',solicitudId);

  const ctx = {
    folio:s.folio, fecha:s.fecha_compra, total:s.total,
    portal_url:url, establecimiento:s.establecimiento,
    perfil:{rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'},
    errores:[]
  };

  // MODO AUTOMATICO: script guardado con valores dinamicos del ticket actual
  if(knowledge&&knowledge.script_exitoso) {
    console.log('[AGENT] Modo automatico: ejecutando script aprendido...');
    // Reemplazar placeholders con valores actuales del ticket
    var scriptDinamico = knowledge.script_exitoso
      .replace(/FOLIO_PLACEHOLDER/g, ctx.folio)
      .replace(/TOTAL_PLACEHOLDER/g, String(ctx.total))
      .replace(/RFC_PLACEHOLDER/g, ctx.perfil.rfc)
      .replace(/EMAIL_PLACEHOLDER/g, ctx.perfil.email)
      .replace(/CP_PLACEHOLDER/g, ctx.perfil.cp)
      .replace(/NOMBRE_PLACEHOLDER/g, ctx.perfil.nombre)
      .replace(/REGIMEN_PLACEHOLDER/g, ctx.perfil.regimen)
      .replace(/USO_PLACEHOLDER/g, ctx.perfil.uso_cfdi);

    const b2 = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
    try {
      const pg = await (await b2.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',viewport:{width:1280,height:800}})).newPage();
      await pg.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      await pg.waitForTimeout(3000);
      await limpiarPopups(pg);
      for(var paso of scriptDinamico.split('// --- siguiente paso ---')) {
        if(paso.trim()) { await pg.evaluate(paso).catch(function(e){console.log('[AGENT] auto paso err:',e.message);}); await pg.waitForTimeout(2000); }
      }
      await pg.waitForTimeout(3000);
      const t = await pg.textContent('body');
      if(t.includes('exitosa')||t.includes('enviada')||t.includes('correo')||t.includes('generada')||t.includes('CFDI')) {
        console.log('[AGENT] AUTOMATICO exitoso!');
        saveKnowledge(portal,{script:knowledge.script_exitoso,conocimiento:JSON.parse(knowledge.conocimiento||'{}')},true);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado','Factura generada (automatico)',solicitudId);
        return {success:true};
      }
      console.log('[AGENT] Script automatico fallo, activando agente visual...');
    } catch(e){console.log('[AGENT] auto err:',e.message);}
    finally{await b2.close();}
  }

  // MODO AGENTE: Claude ve pantalla y escribe JS
  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const jsEjecutados = [];
  const aprendizajes = [];

  try {
    const page = await (await browser.newContext({
      userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:{width:1280,height:800}
    })).newPage();
    await page.addInitScript(function(){Object.defineProperty(navigator,'webdriver',{get:function(){return undefined;}});});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(3000);

    // Limpieza inicial de popups antes de empezar
    await limpiarPopups(page);
    console.log('[AGENT] Popups limpiados, iniciando agente...');

    const hist = [];
    var paso = 0;

    while(paso<12) {
      paso++;
      await sleep(2500);
      console.log('[AGENT] Paso',paso);
      const sc = await screenshot(page);
      var dec;
      try { dec = await claudeEjecutar(sc,ctx,hist,knowledge); }
      catch(e) {
        if(e.message==='RATE_LIMIT'){console.log('[AGENT] Rate limit 429, esperando 30s...');await sleep(30000);continue;}
        throw e;
      }

      console.log('[AGENT]',dec.estado,'|',(dec.descripcion||'').substring(0,80));
      if(dec.aprendido){aprendizajes.push(dec.aprendido);console.log('[AGENT] Aprendido:',(dec.aprendido).substring(0,100));}

      hist.push({role:'user',content:[{type:'text',text:'Paso '+paso+': '+(dec.descripcion||'')}]});
      hist.push({role:'assistant',content:[{type:'text',text:JSON.stringify({estado:dec.estado,descripcion:dec.descripcion,aprendido:dec.aprendido})}]});
      if(hist.length>10)hist.splice(0,2);

      if(dec.estado==='completado') {
        // Guardar script con PLACEHOLDERS en lugar de valores hardcodeados
        var scriptFinal = jsEjecutados.join('\n// --- siguiente paso ---\n')
          .replace(new RegExp(ctx.folio.replace(/[-]/g,'\\-'),'g'),'FOLIO_PLACEHOLDER')
          .replace(new RegExp(String(ctx.total),'g'),'TOTAL_PLACEHOLDER')
          .replace(new RegExp(ctx.perfil.rfc,'g'),'RFC_PLACEHOLDER')
          .replace(new RegExp(ctx.perfil.email,'g'),'EMAIL_PLACEHOLDER')
          .replace(new RegExp(ctx.perfil.cp,'g'),'CP_PLACEHOLDER')
          .replace(new RegExp(ctx.perfil.regimen,'g'),'REGIMEN_PLACEHOLDER')
          .replace(new RegExp(ctx.perfil.uso_cfdi,'g'),'USO_PLACEHOLDER');
        saveKnowledge(portal,{script:scriptFinal,conocimiento:{aprendizajes:aprendizajes,pasos:paso,fecha:new Date().toISOString()}},true);
        console.log('[AGENT] EXITO en',paso,'pasos! Script con placeholders guardado. Proxima vez sera automatico.');
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado',dec.mensaje_final||'Factura generada',solicitudId);
        return {success:true};
      }
      if(dec.estado==='captcha'){db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('captcha_required','Captcha',solicitudId);return {success:false};}
      if(dec.estado==='error'){
        ctx.errores.push(dec.mensaje_final||'error paso '+paso);
        saveKnowledge(portal,{conocimiento:{errores:ctx.errores,aprendizajes:aprendizajes}},false);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',dec.mensaje_final||'Error',solicitudId);
        return {success:false};
      }

      // Ejecutar JS de Claude
      if(dec.js) {
        try {
          var res = await page.evaluate(dec.js);
          jsEjecutados.push(dec.js);
          if(res) console.log('[AGENT] JS ok:',String(res).substring(0,80));
          await page.waitForTimeout(1500);
        } catch(e) {
          var em = e.message.substring(0,120);
          console.log('[AGENT] JS err:',em);
          ctx.errores.push('paso '+paso+': '+em);
          saveKnowledge(portal,{conocimiento:{errores:ctx.errores.slice(-5),aprendizajes:aprendizajes}},false);
        }
      }

      // Manejar iframe via Playwright si Claude lo indica
      if(dec.iframe_selector&&dec.iframe_accion&&dec.iframe_target) {
        try {
          console.log('[AGENT] Intentando via Playwright frameLocator:',dec.iframe_selector,dec.iframe_accion,dec.iframe_target);
          const frame = page.frameLocator(dec.iframe_selector);
          if(dec.iframe_accion==='click') await frame.locator(dec.iframe_target).click({timeout:6000});
          else if(dec.iframe_accion==='fill') await frame.locator(dec.iframe_target).fill(dec.iframe_valor||'',{timeout:6000});
          jsEjecutados.push('// iframe: '+dec.iframe_selector+' '+dec.iframe_accion+' '+dec.iframe_target);
          await page.waitForTimeout(1500);
        } catch(ie){console.log('[AGENT] iframe err:',ie.message.substring(0,80));}
      }

      // Limpiar popups entre pasos
      await limpiarPopups(page);
    }

    saveKnowledge(portal,{conocimiento:{aprendizajes:aprendizajes,errores:ctx.errores}},false);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','12 pasos agotados',solicitudId);
    return {success:false};

  } catch(e) {
    console.error('[AGENT] Fatal:',e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return {success:false};
  } finally { await browser.close(); }
}};
