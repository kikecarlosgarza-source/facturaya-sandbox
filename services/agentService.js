const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

try {
  db.prepare(`CREATE TABLE IF NOT EXISTS portal_knowledge (
    portal TEXT PRIMARY KEY, intentos INTEGER DEFAULT 0, exitosos INTEGER DEFAULT 0,
    script_exitoso TEXT, conocimiento TEXT DEFAULT '{}', actualizado TEXT
  )`).run();
} catch(e) {}

function getKnowledge(p) { try { return db.prepare('SELECT * FROM portal_knowledge WHERE portal=?').get(p)||null; } catch { return null; } }
function saveKnowledge(portal, data, exito) {
  try {
    const r = db.prepare('SELECT portal FROM portal_knowledge WHERE portal=?').get(portal);
    const now = new Date().toISOString();
    const c = JSON.stringify(data.conocimiento||{});
    if (r) db.prepare('UPDATE portal_knowledge SET intentos=intentos+1,exitosos=exitosos+?,script_exitoso=COALESCE(?,script_exitoso),conocimiento=?,actualizado=? WHERE portal=?').run(exito?1:0,data.script||null,c,now,portal);
    else db.prepare('INSERT INTO portal_knowledge(portal,intentos,exitosos,script_exitoso,conocimiento,actualizado) VALUES(?,1,?,?,?,?)').run(portal,exito?1:0,data.script||null,c,now);
  } catch(e) { console.log('[AGENT] err saving:',e.message); }
}
async function screenshot(page) { return (await page.screenshot({type:'jpeg',quality:75,fullPage:false})).toString('base64'); }
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

async function claudeEjecutar(sc, ctx, hist, knowledge) {
  const sys = `Eres un agente experto en portales de autofacturacion de Mexico CFDI 4.0.

MISION: Completar la solicitud de factura electronica en el portal web.

DATOS DEL TICKET:
- Establecimiento: ${ctx.establecimiento}
- Folio/Orden: ${ctx.folio}
- Total: ${ctx.total}
- Fecha: ${ctx.fecha}
- Portal: ${ctx.portal_url}

DATOS FISCALES:
- RFC: ${ctx.perfil.rfc}
- Nombre: ${ctx.perfil.nombre}
- CP: ${ctx.perfil.cp}
- Email: ${ctx.perfil.email}
- Regimen: ${ctx.perfil.regimen}
- Uso CFDI: ${ctx.perfil.uso_cfdi}

CONOCIMIENTO PREVIO: ${knowledge?JSON.stringify(JSON.parse(knowledge.conocimiento||'{}')).substring(0,600):'Primera vez en este portal'}
ERRORES PREVIOS (NO repetir): ${ctx.errores?.join(' | ')||'ninguno'}

FLUJO TIPICO PORTAL MEXICO:
1. Ingresar folio/ticket y total -> click BUSCAR
2. Aparece formulario: RFC, nombre, CP, email, regimen, uso CFDI -> llenar
3. Click GENERAR/SOLICITAR FACTURA
4. Confirmacion: factura enviada al correo

REGLAS JS:
- Para llenar input: el.value='x'; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
- Para click: el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); el.click();
- Para encontrar boton por texto: Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().includes('TEXTO'))
- Para select: sel.value='612'; sel.dispatchEvent(new Event('change',{bubbles:true}));
- Siempre usa return al final del JS para indicar que paso
- Si ves confirmacion de exito: estado=completado

RESPONDE SOLO JSON sin backticks:
{"estado":"ejecutar o completado o error o captcha","descripcion":"que ves y que haras","js":"JS completo funcional","aprendido":"que selectores funcionan aqui","mensaje_final":"solo si completado/error"}`;

  try {
    const r = await axios.post(CLAUDE_API,{model:MODEL,max_tokens:1500,system:sys,messages:[...hist,{role:'user',content:[{type:'image',source:{type:'base64',media_type:'image/jpeg',data:sc}},{type:'text',text:'Que JS ejecuto ahora?'}]}]},{headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});
    const txt = r.data.content.filter(b=>b.type==='text').map(b=>b.text).join('');
    const clean = txt.replace(/```[\w]*\n?/g,'').trim();
    try { return JSON.parse(clean); } catch { const m=clean.match(/\{[\s\S]*\}/); if(m) return JSON.parse(m[0]); return {estado:'error',mensaje_final:'JSON invalido'}; }
  } catch(e) {
    if(e.response?.status===429) throw new Error('RATE_LIMIT');
    return {estado:'error',mensaje_final:'API: '+e.message};
  }
}

module.exports = { procesarConAgente: async function(solicitudId) {
  const s = db.prepare('SELECT * FROM solicitudes WHERE id=?').get(solicitudId);
  if(!s) throw new Error('No encontrada');
  const p = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id=?').get(s.usuario_id);
  if(!p) throw new Error('Sin perfil fiscal');
  const url = determinarPortal(s.establecimiento, s.portal_url);
  if(!url) { db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','Portal no identificado: '+s.establecimiento,solicitudId); return {success:false}; }

  const portal = dominioDe(url);
  const knowledge = getKnowledge(portal);
  console.log('[AGENT]',portal,'| intentos:',knowledge?.intentos||0,'| exitosos:',knowledge?.exitosos||0);
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando',solicitudId);

  const ctx = {folio:s.folio,fecha:s.fecha_compra,total:s.total,portal_url:url,establecimiento:s.establecimiento,perfil:{rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'},errores:[]};

  // Si hay script exitoso: ejecutarlo directo sin Claude
  if(knowledge?.script_exitoso) {
    console.log('[AGENT] Ejecutando script aprendido (sin Claude)...');
    const b2 = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
    try {
      const pg2 = await (await b2.newContext({userAgent:'Mozilla/5.0',viewport:{width:1280,height:800}})).newPage();
      await pg2.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      await pg2.waitForTimeout(3000);
      for(const paso of knowledge.script_exitoso.split('// --- siguiente paso ---')) {
        if(paso.trim()) { await pg2.evaluate(paso).catch(e=>console.log('[AGENT] script paso err:',e.message)); await pg2.waitForTimeout(2000); }
      }
      await pg2.waitForTimeout(3000);
      const t = await pg2.textContent('body');
      if(t.includes('exitosa')||t.includes('enviada')||t.includes('correo')||t.includes('generada')) {
        console.log('[AGENT] Script aprendido funciono! Exito automatico.');
        saveKnowledge(portal,{script:knowledge.script_exitoso,conocimiento:JSON.parse(knowledge.conocimiento||'{}')},true);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado','Factura generada (automatico)',solicitudId);
        return {success:true};
      }
      console.log('[AGENT] Script aprendido fallo, activando agente visual...');
    } catch(e){console.log('[AGENT] script err:',e.message);}
    finally{await b2.close();}
  }

  // Agente visual: Claude ve pantalla y escribe JS
  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const jsEjecutados = [];
  const aprendizajes = [];

  try {
    const page = await (await browser.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',viewport:{width:1280,height:800}})).newPage();
    await page.addInitScript(()=>{Object.defineProperty(navigator,'webdriver',{get:()=>undefined});});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(3000);

    const hist = [];
    let paso = 0;

    while(paso < 15) {
      paso++;
      await sleep(2000);
      console.log('[AGENT] Paso',paso);
      const sc = await screenshot(page);
      let dec;
      try { dec = await claudeEjecutar(sc,ctx,hist,knowledge); }
      catch(e) { if(e.message==='RATE_LIMIT'){console.log('[AGENT] Rate limit, esperando 30s...');await sleep(30000);continue;} throw e; }

      console.log('[AGENT]',dec.estado,'|',(dec.descripcion||'').substring(0,80));
      if(dec.aprendido){aprendizajes.push(dec.aprendido);console.log('[AGENT] Aprendido:',(dec.aprendido).substring(0,100));}

      hist.push({role:'user',content:[{type:'text',text:'Paso '+paso+': '+(dec.descripcion||'')}]});
      hist.push({role:'assistant',content:[{type:'text',text:JSON.stringify({estado:dec.estado,descripcion:dec.descripcion,aprendido:dec.aprendido})}]});
      if(hist.length>12)hist.splice(0,2);

      if(dec.estado==='completado') {
        const scriptFinal = jsEjecutados.join('\n// --- siguiente paso ---\n');
        saveKnowledge(portal,{script:scriptFinal,conocimiento:{aprendizajes,pasos:paso,fecha:new Date().toISOString()}},true);
        console.log('[AGENT] EXITO en',paso,'pasos! Guardado para proxima vez - sera automatico.');
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado',dec.mensaje_final||'Factura generada',solicitudId);
        return {success:true};
      }
      if(dec.estado==='captcha'){db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('captcha_required','Captcha',solicitudId);return {success:false};}
      if(dec.estado==='error'){
        ctx.errores.push(dec.mensaje_final||'error paso '+paso);
        saveKnowledge(portal,{conocimiento:{errores:ctx.errores,aprendizajes}},false);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',dec.mensaje_final||'Error',solicitudId);
        return {success:false};
      }

      if(dec.js) {
        try {
          const res = await page.evaluate(dec.js);
          jsEjecutados.push(dec.js);
          if(res) console.log('[AGENT] JS ok:',String(res).substring(0,80));
          await page.waitForTimeout(1500);
        } catch(e) {
          const em = e.message.substring(0,100);
          console.log('[AGENT] JS err:',em);
          ctx.errores.push('paso '+paso+': '+em);
          saveKnowledge(portal,{conocimiento:{errores:ctx.errores.slice(-5),aprendizajes}},false);
        }
      }
    }

    saveKnowledge(portal,{conocimiento:{aprendizajes,errores:ctx.errores}},false);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','15 pasos agotados',solicitudId);
    return {success:false};

  } catch(e) {
    console.error('[AGENT] Fatal:',e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return {success:false};
  } finally { await browser.close(); }
}};
