const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

try { db.prepare('CREATE TABLE IF NOT EXISTS portal_knowledge (portal TEXT PRIMARY KEY, intentos INTEGER DEFAULT 0, exitosos INTEGER DEFAULT 0, pasos_exitosos TEXT, conocimiento TEXT DEFAULT "{}", actualizado TEXT)').run(); } catch(e) {}
try { db.prepare('ALTER TABLE portal_knowledge ADD COLUMN pasos_exitosos TEXT').run(); } catch(e) {}

function getKnowledge(p) { try { return db.prepare('SELECT * FROM portal_knowledge WHERE portal=?').get(p)||null; } catch { return null; } }
function saveKnowledge(portal, data, exito) {
  try {
    const exists = db.prepare('SELECT portal FROM portal_knowledge WHERE portal=?').get(portal);
    const now = new Date().toISOString();
    const conocimiento = JSON.stringify(data.conocimiento||{});
    const pasos = data.pasos ? JSON.stringify(data.pasos) : null;
    if(exists) {
      db.prepare('UPDATE portal_knowledge SET intentos=intentos+1,exitosos=exitosos+?,pasos_exitosos=COALESCE(?,pasos_exitosos),conocimiento=?,actualizado=? WHERE portal=?')
        .run(exito?1:0, pasos, conocimiento, now, portal);
    } else {
      db.prepare('INSERT INTO portal_knowledge(portal,intentos,exitosos,pasos_exitosos,conocimiento,actualizado) VALUES(?,1,?,?,?,?)')
        .run(portal, exito?1:0, pasos, conocimiento, now);
    }
  } catch(e) { console.log('[AGENT] err saving:',e.message); }
}

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
async function screenshot(page) { return (await page.screenshot({type:'jpeg',quality:90,fullPage:false})).toString('base64'); }


async function getDomInfo(page) {
  return page.evaluate(function() {
    var info = [];
    // Todos los botones visibles
    Array.from(document.querySelectorAll('button,input[type="submit"],a.btn,a.button')).forEach(function(el) {
      if(el.offsetParent !== null) {
        var r = el.getBoundingClientRect();
        info.push({tipo:'BOTON', texto:(el.textContent||el.value||'').trim().substring(0,30), selector:el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(el.className?' .'+el.className.trim().split(/\s+/).join('.'):''), x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)});
      }
    });
    // Todos los inputs visibles
    Array.from(document.querySelectorAll('input[type="text"],input[type="email"],input[type="number"],select,textarea')).forEach(function(el) {
      if(el.offsetParent !== null) {
        info.push({tipo:'INPUT', id:el.id, name:el.name, tipo_input:el.type, placeholder:el.placeholder, valor:el.value.substring(0,20)});
      }
    });
    return info;
  }).catch(function(){return [];});
}

async function claudeDecide(sc, ctx, hist, knowledge, paso, domInfo) {
  const pasosAnteriores = knowledge && knowledge.pasos_exitosos
    ? JSON.parse(knowledge.pasos_exitosos).map(function(p,i){ return (i+1)+'. '+p.descripcion+' -> '+p.accion+' '+p.selector; }).join('\n')
    : 'Primera vez en este portal';

  const domTxt = domInfo && domInfo.length ? '\n\nELEMENTOS VISIBLES EN PANTALLA AHORITA:\n'+JSON.stringify(domInfo,null,1).substring(0,800) : '';
  const sys = 'Eres un operador experto navegando portales de autofacturacion de Mexico CFDI 4.0.\nOperas el browser igual que un humano — ves la pantalla y dices exactamente que accion tomar.\n\nDATOS DEL TICKET:\n- Establecimiento: '+ctx.establecimiento+'\n- Folio/Orden: '+ctx.folio+'\n- Total: '+ctx.total+'\n- Fecha: '+ctx.fecha+'\n- Portal: '+ctx.portal_url+'\n\nDATOS FISCALES:\n- RFC: '+ctx.perfil.rfc+'\n- Nombre: '+ctx.perfil.nombre+'\n- CP: '+ctx.perfil.cp+'\n- Email: '+ctx.perfil.email+'\n- Regimen: '+ctx.perfil.regimen+'\n- Uso CFDI: '+ctx.perfil.uso_cfdi+'\n\nPASOS EXITOSOS ANTERIORES:\n'+pasosAnteriores+'\n\nERRORES ESTE INTENTO: '+(ctx.errores.slice(-3).join(' | ')||'ninguno')+'\n\nACCIONES DISPONIBLES:\n- click: hacer click en un elemento (da selector CSS)\n- fill: escribir en un campo (da selector CSS y valor)\n- select: seleccionar opcion de un dropdown (da selector CSS y valor)\n- wait: esperar 2 segundos\n- completado: la factura fue generada exitosamente\n- error: hay un error que no puedes resolver\n\nREGLAS:\n1. Da selectores CSS precisos y especificos\n2. Si hay un popup/overlay bloqueando: click en el boton X para cerrarlo\n3. Para selects de regimen fiscal usa value=612, para uso CFDI usa value=G03\n4. Si ves confirmacion de factura enviada/generada: accion=completado\n5. Usa los pasos exitosos anteriores como guia exacta\n\nResponde SOLO JSON valido sin backticks:\n{"descripcion":"que ves en pantalla","accion":"click o fill o select o wait o completado o error","selector":"CSS selector","valor":"valor si fill o select","razon":"por que","mensaje_final":"solo si completado o error"}';

  try {
    const r = await axios.post(CLAUDE_API, {
      model: MODEL, max_tokens: 600, system: sys,
      messages: [...hist, {
        role: 'user',
        content: [
          {type:'image', source:{type:'base64', media_type:'image/jpeg', data:sc}},
          {type:'text', text:'Paso '+paso+': que hago ahora?'}
        ]
      }]
    }, {headers:{'Content-Type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}});
    const txt = r.data.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    const m = txt.match(/{[sS]*}/);
    if(m) { try { return JSON.parse(m[0]); } catch(e) { return {accion:'wait',descripcion:'JSON parse error'}; } }
    const js=txt.indexOf('{');const je=txt.lastIndexOf('}');if(js>=0&&je>js){try{return JSON.parse(txt.substring(js,je+1));}catch{}}
    console.log('[AGENT] Sin JSON:', txt.substring(0,120));
    return {accion:'wait', descripcion:'Esperando'};
  } catch(e) {
    if(e.response&&e.response.status===429) throw new Error('RATE_LIMIT');
    return {accion:'error', mensaje_final:'API: '+e.message};
  }
}

async function ejecutar(page, dec) {
  const sel = dec.selector || '';
  const val = dec.valor || '';
  try {
    switch(dec.accion) {
      case 'click':
        try { await page.locator(sel).first().click({timeout:6000}); }
        catch { await page.locator(sel).first().click({force:true, timeout:6000}); }
        break;
      case 'fill':
        await page.locator(sel).first().fill(val, {timeout:6000});
        break;
      case 'select':
        await page.locator(sel).first().selectOption(val, {timeout:6000});
        break;
      case 'wait':
        await sleep(2000);
        break;
    }
    await sleep(1200);
    return true;
  } catch(e) {
    console.log('[AGENT] err ('+dec.accion+' "'+sel+'"):', e.message.substring(0,80));
    return false;
  }
}

function reemplazarPlaceholders(valor, ctx) {
  return (valor||'')
    .replace(/FOLIO_PLACEHOLDER/g, ctx.folio)
    .replace(/TOTAL_PLACEHOLDER/g, String(ctx.total))
    .replace(/RFC_PLACEHOLDER/g, ctx.perfil.rfc)
    .replace(/EMAIL_PLACEHOLDER/g, ctx.perfil.email)
    .replace(/CP_PLACEHOLDER/g, ctx.perfil.cp)
    .replace(/REGIMEN_PLACEHOLDER/g, ctx.perfil.regimen)
    .replace(/USO_PLACEHOLDER/g, ctx.perfil.uso_cfdi)
    .replace(/NOMBRE_PLACEHOLDER/g, ctx.perfil.nombre);
}

function agregarPlaceholders(valor, ctx) {
  return (valor||'')
    .split(ctx.folio).join('FOLIO_PLACEHOLDER')
    .split(String(ctx.total)).join('TOTAL_PLACEHOLDER')
    .split(ctx.perfil.rfc).join('RFC_PLACEHOLDER')
    .split(ctx.perfil.email).join('EMAIL_PLACEHOLDER')
    .split(ctx.perfil.cp).join('CP_PLACEHOLDER')
    .split(ctx.perfil.regimen).join('REGIMEN_PLACEHOLDER')
    .split(ctx.perfil.uso_cfdi).join('USO_PLACEHOLDER');
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
  console.log('[AGENT]',portal,'| intentos:',knowledge?knowledge.intentos:0,'| exitosos:',knowledge?knowledge.exitosos:0);
  db.prepare('UPDATE solicitudes SET status=? WHERE id=?').run('procesando',solicitudId);

  const ctx = {
    folio:s.folio, fecha:s.fecha_compra, total:s.total,
    portal_url:url, establecimiento:s.establecimiento,
    perfil:{rfc:p.rfc,nombre:p.nombre,cp:p.cp,email:p.email,regimen:p.regimen||'612',uso_cfdi:p.uso_cfdi||'G03'},
    errores:[]
  };

  // MODO AUTOMATICO: repetir pasos aprendidos con valores actuales
  if(knowledge && knowledge.pasos_exitosos) {
    console.log('[AGENT] Modo automatico: repitiendo pasos aprendidos...');
    const pasosGuardados = JSON.parse(knowledge.pasos_exitosos);
    const b2 = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
    try {
      const pg = await (await b2.newContext({userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',viewport:{width:1280,height:800}})).newPage();
      await pg.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
      await pg.waitForTimeout(3000);
      let todoOk = true;
      for(const paso of pasosGuardados) {
        const decAuto = {accion:paso.accion, selector:paso.selector, valor:reemplazarPlaceholders(paso.valor, ctx)};
        const ok = await ejecutar(pg, decAuto);
        if(!ok) { console.log('[AGENT] Auto fallo en:', paso.accion, paso.selector); todoOk=false; break; }
        console.log('[AGENT] Auto OK:', paso.accion, paso.selector);
      }
      if(todoOk) {
        await pg.waitForTimeout(3000);
        const t = await pg.textContent('body');
        if(t.includes('exitosa')||t.includes('enviada')||t.includes('correo')||t.includes('generada')) {
          console.log('[AGENT] AUTOMATICO exitoso!');
          saveKnowledge(portal,{pasos:pasosGuardados,conocimiento:JSON.parse(knowledge.conocimiento||'{}')},true);
          db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado','Factura automatica',solicitudId);
          return {success:true};
        }
      }
      console.log('[AGENT] Auto no completo, activando agente visual...');
    } catch(e){console.log('[AGENT] auto err:',e.message);}
    finally{await b2.close();}
  }

  // MODO AGENTE: Claude ve pantalla y decide acciones Playwright
  const browser = await chromium.launch({headless:true,args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  const pasosExitosos = [];

  try {
    const page = await (await browser.newContext({
      userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport:{width:1280,height:800}
    })).newPage();
    await page.addInitScript(function(){Object.defineProperty(navigator,'webdriver',{get:function(){return undefined;}});});
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForTimeout(3000);

    const hist = [];
    let paso = 0;

    while(paso < 15) {
      paso++;
      await sleep(2000);
      console.log('[AGENT] Paso',paso);

      const sc = await screenshot(page);
      const domInfo = await getDomInfo(page);
      let dec;
      try { dec = await claudeDecide(sc, ctx, hist, knowledge, paso, domInfo); }
      catch(e) {
        if(e.message==='RATE_LIMIT'){console.log('[AGENT] Rate limit 30s...');await sleep(30000);continue;}
        throw e;
      }

      console.log('[AGENT]',dec.accion,'|',(dec.selector||'').substring(0,40),'|',(dec.descripcion||'').substring(0,50));

      hist.push({role:'user',content:[{type:'text',text:'Paso '+paso+': '+dec.descripcion}]});
      hist.push({role:'assistant',content:[{type:'text',text:JSON.stringify({accion:dec.accion,selector:dec.selector})}]});
      if(hist.length>10) hist.splice(0,2);

      if(dec.accion==='completado') {
        const pasosConPH = pasosExitosos.map(function(p) {
          return {accion:p.accion, selector:p.selector, valor:agregarPlaceholders(p.valor,ctx), descripcion:p.descripcion};
        });
        saveKnowledge(portal,{pasos:pasosConPH,conocimiento:{fecha:new Date().toISOString(),total_pasos:paso}},true);
        console.log('[AGENT] EXITO en',paso,'pasos! Guardado. Proxima vez automatico sin Claude.');
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('completado',dec.mensaje_final||'Factura generada',solicitudId);
        return {success:true};
      }
      if(dec.accion==='error') {
        ctx.errores.push(dec.mensaje_final||'error paso '+paso);
        db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',dec.mensaje_final||'Error',solicitudId);
        return {success:false};
      }

      const ok = await ejecutar(page, dec);
      if(ok && dec.accion !== 'wait') {
        pasosExitosos.push({accion:dec.accion, selector:dec.selector||'', valor:dec.valor||'', descripcion:dec.descripcion||''});
      } else if(!ok) {
        ctx.errores.push('Fallo: '+dec.accion+' '+dec.selector);
      }
    }

    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('manual','15 pasos agotados',solicitudId);
    return {success:false};
  } catch(e) {
    console.error('[AGENT] Fatal:',e.message);
    db.prepare('UPDATE solicitudes SET status=?,status_detalle=? WHERE id=?').run('error',e.message.substring(0,200),solicitudId);
    return {success:false};
  } finally { await browser.close(); }
}};
