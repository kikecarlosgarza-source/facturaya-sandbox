const { chromium } = require('playwright');
const axios = require('axios');

const CAPSOLVER_KEY = 'CAP-91DBB78CF63E63B7750671653C652D3035333B175998A8AC8B04C827FEBCE2D2';
const URL = 'https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb';
const RFC = 'GAME860412CY6';
const TICKET = '12345678';

async function solveTurnstile(siteKey, pageUrl) {
  console.log('[CAP] Creating task siteKey=' + siteKey.substring(0,12) + '...');
  const create = await axios.post('https://api.capsolver.com/createTask', {
    clientKey: CAPSOLVER_KEY,
    task: { type: 'AntiTurnstileTaskProxyLess', websiteURL: pageUrl, websiteKey: siteKey }
  });
  if (create.data.errorId) throw new Error('CapSolver create error: ' + create.data.errorDescription);
  const taskId = create.data.taskId;
  console.log('[CAP] Task created:', taskId);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const res = await axios.post('https://api.capsolver.com/getTaskResult', { clientKey: CAPSOLVER_KEY, taskId });
    if (res.data.status === 'ready') return res.data.solution;
    if (res.data.errorId) throw new Error('CapSolver result error: ' + res.data.errorDescription);
    process.stdout.write('.');
  }
  throw new Error('CapSolver timeout');
}

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}); window.chrome={runtime:{}}; });

  console.log('=== Cargando portal HD ===');
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // Step 1: llenar RFC + ticket
  await page.waitForSelector('#rfc', { timeout: 20000 });
  await page.fill('#rfc', RFC);
  await page.fill('#ticket', TICKET);
  console.log('[STEP1] RFC + ticket llenados');
  await page.waitForTimeout(2000);

  // Encontrar siteKey del Turnstile
  const siteKey = await page.evaluate(() => {
    const ts = document.querySelector('[data-sitekey], .cf-turnstile, iframe[src*="challenges.cloudflare.com"]');
    if (ts && ts.dataset && ts.dataset.sitekey) return ts.dataset.sitekey;
    const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (iframe) {
      const m = iframe.src.match(/[?&]k=([^&]+)/);
      if (m) return m[1];
    }
    const all = document.querySelectorAll('[data-sitekey]');
    for (const el of all) return el.dataset.sitekey;
    return null;
  });
  console.log('[CF] siteKey:', siteKey);

  if (!siteKey) {
    await page.screenshot({ path: '/tmp/hd-no-sitekey.png', fullPage: true });
    throw new Error('No se encontró siteKey del Turnstile');
  }

  // Resolver Turnstile
  const sol = await solveTurnstile(siteKey, URL);
  console.log('\n[CAP] Token recibido:', sol.token.substring(0, 30) + '...');
  if (sol.userAgent) console.log('[CAP] UA:', sol.userAgent);

  // Inyectar token en el widget
  await page.evaluate((t) => {
    document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(el => { el.value = t; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); });
    if (window.turnstile && window.turnstile.getResponse) {
      try { window.turnstile.getResponse = () => t; } catch(e) {}
    }
    // Disparar callback si existe
    if (window._turnstileCb) try { window._turnstileCb(t); } catch(e){}
  }, sol.token);

  await page.waitForTimeout(3000);

  // Esperar a que el botón Continuar se habilite
  console.log('[STEP1] Esperando que Continuar se habilite...');
  let enabled = false;
  for (let i = 0; i < 20; i++) {
    const dis = await page.evaluate(() => {
      const b = document.querySelector('button.btn-primary');
      return b ? b.disabled : null;
    });
    if (dis === false) { enabled = true; break; }
    await page.waitForTimeout(1000);
  }
  console.log('[STEP1] Botón habilitado:', enabled);

  if (!enabled) {
    // Intentar marcar el checkbox de Turnstile manualmente
    console.log('[STEP1] Click forzado al iframe Turnstile');
    const iframe = await page.frameLocator('iframe[src*="challenges.cloudflare.com"]').first();
    try {
      await iframe.locator('input[type="checkbox"]').click({ timeout: 5000, force: true });
    } catch(e) { console.log('  iframe click fail:', e.message); }
    await page.waitForTimeout(5000);
  }

  // Click Continuar
  await page.click('button.btn-primary', { timeout: 15000, force: true });
  console.log('[STEP1] Continuar clickeado');
  await page.waitForTimeout(7000);

  // Detectar swal (verificación adicional)
  const swal = await page.$('.swal2-container');
  if (swal) {
    console.log('[STEP1] Swal detectado, contenido:', (await page.textContent('.swal2-container')).substring(0,300));
    await page.screenshot({ path: '/tmp/hd-swal.png' });
  }

  // ====== STEP 2: INSPECCIONAR DOM ======
  console.log('\n=== STEP 2: DOM inspeccion ===');
  await page.screenshot({ path: '/tmp/hd-step2.png', fullPage: true });

  const dom = await page.evaluate(() => {
    const out = {
      url: location.href,
      h1h2h3: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(h => h.textContent.trim()).filter(Boolean).slice(0,10),
      visibleText: (document.body.innerText||'').substring(0, 1500),
      selects: [],
      matSelects: [],
      ngSelects: [],
      pDropdowns: [],
      customDropdowns: [],
      visibleInputs: [],
      buttons: [],
      swalContent: '',
      regimenSpecific: null
    };
    const swal = document.querySelector('.swal2-container');
    if (swal) out.swalContent = swal.innerHTML.substring(0, 4000);

    document.querySelectorAll('select').forEach(s => {
      out.selects.push({
        id:s.id, name:s.name, classes:s.className,
        visible:s.offsetParent!==null,
        opts: Array.from(s.options).slice(0,8).map(o=>({v:o.value, t:o.text.substring(0,60)})),
        optionsCount: s.options.length
      });
    });

    document.querySelectorAll('mat-select').forEach(el => {
      out.matSelects.push({
        id:el.id, classes:el.className, attrs: Array.from(el.attributes).map(a=>a.name+'='+a.value).join(' '),
        visible:el.offsetParent!==null, text:(el.textContent||'').trim().substring(0,100)
      });
    });

    document.querySelectorAll('ng-select').forEach(el => {
      out.ngSelects.push({
        id:el.id, classes:el.className, attrs: Array.from(el.attributes).map(a=>a.name+'='+a.value).join(' '),
        visible:el.offsetParent!==null, text:(el.textContent||'').trim().substring(0,100)
      });
    });

    document.querySelectorAll('p-dropdown, [role="listbox"], [role="combobox"]').forEach(el => {
      out.pDropdowns.push({
        tag:el.tagName, role:el.getAttribute('role'), id:el.id, classes:el.className.substring(0,80),
        visible:el.offsetParent!==null, text:(el.textContent||'').trim().substring(0,100)
      });
    });

    // Buscar dropdowns custom div-based
    document.querySelectorAll('[class*="dropdown"],[class*="select"],[class*="Dropdown"],[class*="Select"]').forEach(el => {
      if (el.offsetParent !== null && el.tagName !== 'OPTION') {
        out.customDropdowns.push({
          tag:el.tagName, classes:el.className.substring(0,100),
          text:(el.textContent||'').trim().substring(0,80)
        });
      }
    });

    document.querySelectorAll('input,textarea').forEach(i => {
      if (i.offsetParent !== null) out.visibleInputs.push({ tag:i.tagName, id:i.id, name:i.name, type:i.type, placeholder:i.placeholder, value:i.value.substring(0,30) });
    });

    document.querySelectorAll('button').forEach(b => {
      if (b.offsetParent !== null) out.buttons.push({ text:(b.textContent||'').trim().substring(0,40), classes:b.className.substring(0,60), disabled:b.disabled });
    });

    // Buscar específicamente regimen
    const all = Array.from(document.querySelectorAll('*'));
    const regimenContainer = all.find(el => {
      const t = el.textContent || '';
      return (t.includes('Régimen') || t.includes('Regimen') || t.includes('régimen')) && el.children.length < 30 && el.offsetParent !== null;
    });
    if (regimenContainer) {
      out.regimenSpecific = {
        tag: regimenContainer.tagName,
        classes: regimenContainer.className,
        innerHTML: regimenContainer.outerHTML.substring(0, 2500)
      };
    }

    return out;
  });

  console.log(JSON.stringify(dom, null, 2));
  console.log('\nScreenshot:', '/tmp/hd-step2.png');

  await browser.close();
})().catch(async e => { console.error('FATAL:', e.message); process.exit(1); });
