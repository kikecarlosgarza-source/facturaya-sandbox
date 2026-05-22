// Inspector Walmart México — flujo CONSULTA → radio PDF → iframe binario.
//
// Hallazgo del usuario: el flujo radConsultar lleva a una pantalla con dos
// radios "Enviar a correo electrónico" / "PDF". Seleccionando PDF + submit,
// el portal navega a /frmConsultaFactura.aspx que embebe un iframe
// /frmReportPDF2.aspx con el PDF binario del CFDI ya emitido.
//
// Objetivo de esta corrida: descubrir IDs/URLs/headers/cookies del flujo,
// capturar el PDF binario a /tmp/walmart-pdf-capture.pdf y verificar el
// header %PDF.
//
// Ticket: #2 (TC=52569190520843835983 TR=07891), ya facturado por nosotros.
//
// Outputs:
//   /tmp/walmart-pdf-capture.pdf             ← PDF binario si se logra
//   /tmp/walmart-frmConsultaFactura.html     ← DOM de la pantalla con iframe
//   /tmp/walmart-network-trace.json          ← todos los req/res
//   /tmp/walmart-network/                    ← binarios capturados por listener
//   /tmp/walmart-inspect/                    ← screenshots + DOM dumps por paso
//
// NO toca el handler. NO timbra factura nueva. Puede enviar email duplicado.
//
// Ejecutar: node tests/walmart.inspect-step5.js

const fs = require('fs');
const path = require('path');
const { launchStealthBrowser, closeBrowser } = require('../services/koneshBrowser');

const PORTAL_URL = 'https://facturacion.walmartmexico.com.mx/';
const TIMEOUT_NAV = 30000;
const TIMEOUT_EL = 15000;
const OUT_DIR = '/tmp/walmart-inspect';
const NET_BIN_DIR = '/tmp/walmart-network';
const NETLOG_PATH = '/tmp/walmart-network-trace.json';
const PDF_PATH = '/tmp/walmart-pdf-capture.pdf';
const CONSULTA_HTML_PATH = '/tmp/walmart-frmConsultaFactura.html';

const ticket = {
  rfc:     'GAME860412CY6',
  cp:      '66230',
  tc:      '52569190520843835983',
  tr:      '07891',
  razon:   'ENRIQUE CARLOS GARZA MONTEMAYOR',
  email:   'kikecarlosgarza@gmail.com',
  regimen: '612',
  uso:     'G03',
  payment: '04'
};

for (const d of [OUT_DIR, NET_BIN_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const consoleLog = [];
const pageErrors = [];
const netLog = [];
let currentPhase = 'init';

const INTERESTING_URL = /(xml|pdf|descarg|download|factura|cfdi|invoice|comprobante|timbre|uuid|consulta|reenv|reimpresi|report)/i;
const INTERESTING_CT  = /(application\/xml|text\/xml|application\/pdf|application\/zip|application\/octet-stream)/i;
const ASSET_RE        = /\.(css|jpg|jpeg|png|gif|svg|ico|woff2?|ttf|map)(\?|$)/i;

function fmt(s, n = 200) { return String(s || '').replace(/\s+/g, ' ').trim().substring(0, n); }

function persistNetLog() {
  try { fs.writeFileSync(NETLOG_PATH, JSON.stringify(netLog, null, 2)); } catch (_) {}
}

async function dumpState(page, label, err) {
  const pngPath  = path.join(OUT_DIR, `${label}.png`);
  const htmlPath = path.join(OUT_DIR, `${label}.html`);
  let url = '?', title = '?';
  try { url = page.url(); } catch (_) {}
  try { title = await page.title(); } catch (_) {}
  try { await page.screenshot({ path: pngPath, fullPage: true }); } catch (_) {}
  let html = '';
  try { html = await page.evaluate(() => document.documentElement.outerHTML); } catch (_) {}
  try { fs.writeFileSync(htmlPath, html); } catch (_) {}

  let v = {};
  try {
    v = await page.evaluate(() => {
      const out = { headings: [], errorBoxes: [], buttons: [], inputs: [], radios: [], iframes: [], mainText: '' };
      out.mainText = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 1500);
      for (const h of document.querySelectorAll('h1,h2,h3,h4')) { const t=(h.textContent||'').trim(); if (t) out.headings.push(h.tagName+': '+t.substring(0,150)); }
      for (const e of document.querySelectorAll('[id*="Error"],[id*="divMsg"],[class*="error"],[role="alert"]')) {
        if (e.offsetParent === null) continue;
        const t = (e.textContent||'').trim(); if (t) out.errorBoxes.push('#'+(e.id||'(no-id)')+': '+t.substring(0,300));
      }
      for (const b of document.querySelectorAll('button, input[type=submit], input[type=button], input[type=image]')) {
        out.buttons.push({ tag:b.tagName.toLowerCase(), type:b.type, id:b.id||'', name:b.name||'',
          value:b.value||'', text:(b.textContent||'').trim().substring(0,60),
          visible:b.offsetParent!==null, disabled:b.disabled });
      }
      for (const t of document.querySelectorAll('input[type=text], input[type=email], input:not([type])')) {
        out.inputs.push({ id:t.id, name:t.name, value:t.value, placeholder:t.placeholder, visible:t.offsetParent!==null });
      }
      for (const r of document.querySelectorAll('input[type=radio]')) {
        out.radios.push({ id:r.id, name:r.name, value:r.value, checked:r.checked, visible:r.offsetParent!==null,
          label:(document.querySelector(`label[for="${r.id}"]`)?.textContent || '').trim().substring(0,80) });
      }
      for (const f of document.querySelectorAll('iframe')) {
        out.iframes.push({ id:f.id||'', name:f.name||'', src:f.src||'', width:f.width, height:f.height });
      }
      return out;
    });
  } catch (_) {}

  console.log(`\n════════ DUMP @ ${label} ════════`);
  if (err) console.log('Excepción :', err.message);
  console.log('URL       :', url);
  console.log('Title     :', title);
  console.log('Screenshot:', pngPath);
  console.log('HTML      :', htmlPath, `(${html.length} bytes)`);
  if (v.headings?.length) { console.log('\n── Encabezados ──'); for (const h of v.headings) console.log('  '+h); }
  if (v.errorBoxes?.length) { console.log('\n── Alertas/Errores ──'); for (const e of v.errorBoxes) console.log('  '+e); }
  if (v.buttons?.length) {
    console.log('\n── Buttons visibles ──');
    for (const b of v.buttons.filter(x=>x.visible)) console.log(' ', JSON.stringify(b));
  }
  if (v.inputs?.length) { console.log('\n── Inputs visibles ──'); for (const t of v.inputs.filter(x=>x.visible)) console.log(' ', JSON.stringify(t)); }
  if (v.radios?.length) { console.log('\n── RADIOS ──'); for (const r of v.radios) console.log(' ', JSON.stringify(r)); }
  if (v.iframes?.length) { console.log('\n── IFRAMES ──'); for (const f of v.iframes) console.log(' ', JSON.stringify(f)); }
  if (v.mainText) console.log('\n── Body text (1500) ──\n  '+v.mainText);
  persistNetLog();
}

async function step(page, label, fn) {
  console.log(`\n[INSPECT] ${label} — url antes: ${page.url()}`);
  currentPhase = label;
  try { await fn(); console.log(`[INSPECT] ${label} OK — url después: ${page.url()}`); persistNetLog(); }
  catch (e) { console.error(`[INSPECT] ${label} FAIL — ${e.message.split('\n')[0]}`); await dumpState(page, `step-error-${label}`, e); persistNetLog(); throw e; }
}

(async () => {
  let browser, context;
  try {
    const launched = await launchStealthBrowser({ viewport: { width: 1280, height: 800 } });
    browser = launched.browser;
    context = launched.context;
    const page = launched.page;
    context.setDefaultTimeout(TIMEOUT_EL);
    context.setDefaultNavigationTimeout(TIMEOUT_NAV);

    page.on('console', msg => consoleLog.push({ type: msg.type(), text: fmt(msg.text(), 300) }));
    page.on('pageerror', err => pageErrors.push(fmt(err.message, 300)));
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.log(`  [nav] → ${f.url()}`); });

    page.on('request', req => {
      const url = req.url();
      let postDataPreview = '';
      try { const pd = req.postData(); if (pd) postDataPreview = pd.substring(0, 500); } catch (_) {}
      netLog.push({ phase: currentPhase, ts: Date.now(), kind: 'request',
        method: req.method(), url, type: req.resourceType(),
        postDataPreview, isAsset: ASSET_RE.test(url),
        isInteresting: INTERESTING_URL.test(url) && !ASSET_RE.test(url) });
    });

    page.on('response', async res => {
      const url = res.url();
      const status = res.status();
      const headers = res.headers();
      const contentType = headers['content-type'] || '';
      const contentLength = headers['content-length'] || '';
      const contentDisposition = headers['content-disposition'] || '';
      const isAsset = ASSET_RE.test(url);
      const isInteresting = (INTERESTING_URL.test(url) && !isAsset) || INTERESTING_CT.test(contentType) || /attachment/i.test(contentDisposition);
      let bodySizeBytes = -1, bodyPreview = '', savedTo = '';
      if (isInteresting && status >= 200 && status < 400) {
        try {
          const buf = await res.body();
          bodySizeBytes = buf.length;
          if (INTERESTING_CT.test(contentType) || /attachment/i.test(contentDisposition)) {
            const safeName = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]/gi, '_').substring(0, 90);
            const ext = /pdf/i.test(contentType) ? '.pdf' : /xml/i.test(contentType) ? '.xml' : /zip/i.test(contentType) ? '.zip' : '.bin';
            savedTo = path.join(NET_BIN_DIR, `${Date.now()}_${safeName}${ext}`);
            fs.writeFileSync(savedTo, buf);
          } else if (!isAsset) {
            bodyPreview = buf.toString('utf8').substring(0, 500).replace(/\s+/g, ' ').trim();
          }
        } catch (_) {}
      }
      netLog.push({ phase: currentPhase, ts: Date.now(), kind: 'response',
        method: res.request().method(), url, status, contentType, contentLength,
        contentDisposition, bodySizeBytes, bodyPreview, savedTo, isAsset, isInteresting });
    });

    // ── B1: navegar a Default + click "Obtener factura" ──
    await step(page, 'B1-default', async () => {
      await page.goto(PORTAL_URL, { waitUntil: 'networkidle' });
      try {
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button')).find(b => /aceptar/i.test(b.textContent || ''));
          if (btn) btn.click();
        });
        await page.waitForTimeout(500);
      } catch (_) {}
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT_NAV }),
        page.evaluate(() => {
          const link = document.querySelector('a[href="frmDatos.aspx"]');
          if (link) link.click();
        })
      ]);
    });

    // ── B2: click radConsultar PRIMERO (cambia el form a modo "Consultar") ──
    await step(page, 'B2-radConsultar', async () => {
      const exists = await page.$('#ctl00_ContentPlaceHolder1_radConsultar');
      if (!exists) throw new Error('radConsultar no presente');
      const navP = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => null);
      await page.click('#ctl00_ContentPlaceHolder1_radConsultar');
      await navP;
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => null);
      await page.waitForTimeout(5000);
      await dumpState(page, 'B2-after-radConsultar', null);
    });

    // ── B3: fill txtTCFact con el TC# (input único del modo Consultar) ──
    await step(page, 'B3-fill-txtTCFact', async () => {
      // El placeholder dice "Número de Ticket o factura" — probamos con TC#.
      await page.waitForSelector('#ctl00_ContentPlaceHolder1_txtTCFact', { state: 'visible', timeout: TIMEOUT_EL });
      await page.fill('#ctl00_ContentPlaceHolder1_txtTCFact', ticket.tc);
      await page.waitForTimeout(500);
      console.log(`[INSPECT] txtTCFact relleno con TC# ${ticket.tc}`);
    });

    // ── B4: click btnAceptar (Continuar) — debería navegar a la pantalla con radios Email/PDF
    await step(page, 'B4-continuar', async () => {
      const exists = await page.$('#ctl00_ContentPlaceHolder1_btnAceptar');
      if (!exists) throw new Error('btnAceptar (Continuar) no presente');
      const navP = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => null);
      await page.click('#ctl00_ContentPlaceHolder1_btnAceptar');
      await navP;
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(8000);
      await dumpState(page, 'B4-after-continuar', null);
    });

    // ── B5: en la nueva pantalla, listar radios + seleccionar el "PDF" + submit
    await step(page, 'B5-select-PDF-and-submit', async () => {
      const radios = await page.evaluate(() => {
        return [...document.querySelectorAll('input[type=radio]')]
          .filter(r => r.offsetParent !== null)
          .map(r => ({ id: r.id, name: r.name, value: r.value, checked: r.checked,
            label: (document.querySelector(`label[for="${r.id}"]`)?.textContent || '').trim().substring(0, 80) }));
      });
      console.log('\n[INSPECT] Radios visibles en pantalla post-Continuar:');
      for (const r of radios) console.log(' ', JSON.stringify(r));

      const pdfRadio = radios.find(r => /pdf|impresi|imprim/i.test(r.label + ' ' + r.value + ' ' + r.id + ' ' + r.name));
      if (!pdfRadio) throw new Error('Radio PDF no encontrado entre: ' + JSON.stringify(radios));
      console.log(`\n[INSPECT] Seleccionando radio PDF: id=${pdfRadio.id} value="${pdfRadio.value}" label="${pdfRadio.label}"`);
      await page.check(`#${pdfRadio.id}`);
      await page.waitForTimeout(800);

      const submits = await page.evaluate(() => {
        return [...document.querySelectorAll('input[type=submit], input[type=button]')]
          .filter(b => b.offsetParent !== null && !b.disabled)
          .map(b => ({ id: b.id, name: b.name, value: b.value }));
      });
      console.log('\n[INSPECT] Submits visibles:');
      for (const s of submits) console.log(' ', JSON.stringify(s));

      // Priorizar "Facturar" > "Continuar" > "Aceptar" > "Generar"
      const order = ['facturar', 'continuar', 'aceptar', 'generar'];
      let target = null;
      for (const kw of order) {
        target = submits.find(s => new RegExp(kw, 'i').test(s.value));
        if (target) break;
      }
      if (!target) throw new Error('No se encontró submit válido entre: ' + JSON.stringify(submits));
      console.log(`\n[INSPECT] Clickeando submit: ${JSON.stringify(target)}`);
      const navP = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 45000 }).catch(() => null);
      await page.click(`#${target.id}`);
      await navP;
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      await page.waitForTimeout(10000);
      await dumpState(page, 'B5-after-PDF-submit', null);
    });

    // ── B6: capturar iframe + descargar PDF binary con cookies de la sesión
    await step(page, 'B6-capture-pdf-iframe', async () => {
      const finalUrl = page.url();
      console.log(`[INSPECT] URL final: ${finalUrl}`);

      // Dump HTML de la pantalla con el iframe
      try {
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        fs.writeFileSync(CONSULTA_HTML_PATH, html);
        console.log(`[INSPECT] HTML de frmConsultaFactura → ${CONSULTA_HTML_PATH} (${html.length} bytes)`);
      } catch (e) {
        console.log('[INSPECT] dump HTML falló:', e.message);
      }

      // Listar todos los iframes
      const iframes = await page.evaluate(() => {
        return [...document.querySelectorAll('iframe')].map(f => ({
          id: f.id || '', name: f.name || '', src: f.src || '',
          width: f.width || '', height: f.height || ''
        }));
      });
      console.log('\n[INSPECT] IFRAMES encontrados:');
      if (!iframes.length) console.log('  (ninguno)');
      for (const f of iframes) console.log(' ', JSON.stringify(f));

      // Buscar el iframe del PDF (src con "PDF", "Report", "frmReport")
      const pdfIframe = iframes.find(f => /pdf|report/i.test(f.src + ' ' + f.id + ' ' + f.name)) || iframes[0];
      if (!pdfIframe || !pdfIframe.src) {
        console.log('[INSPECT] no se encontró iframe con src de PDF/Report.');
        return;
      }
      console.log(`\n[INSPECT] iframe target: ${JSON.stringify(pdfIframe)}`);

      // GET con cookies de la sesión Playwright
      try {
        const apiRequest = context.request;
        console.log(`[INSPECT] GET ${pdfIframe.src}`);
        const res = await apiRequest.get(pdfIframe.src, { timeout: 60000 });
        const status = res.status();
        const headers = res.headers();
        const ct = headers['content-type'] || '';
        const cl = headers['content-length'] || '';
        const cd = headers['content-disposition'] || '';
        const body = await res.body();
        console.log(`[INSPECT] response: status=${status} ct="${ct}" len=${cl} disp="${cd}" bodySize=${body.length}B`);

        fs.writeFileSync(PDF_PATH, body);
        console.log(`[INSPECT] PDF binary → ${PDF_PATH}`);

        const firstBytes = body.slice(0, 8).toString('ascii');
        const isPdf = firstBytes.startsWith('%PDF-');
        console.log(`[INSPECT] primeros 8 bytes: "${firstBytes}"`);
        console.log(`[INSPECT] ¿es PDF válido (%PDF- header)? ${isPdf ? 'SÍ ✓' : 'NO ✗'}`);

        // Cookies de la sesión usadas
        const cookies = await context.cookies(pdfIframe.src);
        console.log('\n[INSPECT] Cookies usadas en el GET:');
        for (const c of cookies) console.log(`  ${c.name}=${c.value.substring(0, 60)}${c.value.length > 60 ? '...' : ''} (domain=${c.domain})`);
      } catch (e) {
        console.log('[INSPECT] GET iframe falló:', e.message);
      }
    });

    // ── RESUMEN
    persistNetLog();
    console.log('\n\n╔════════ RESUMEN ════════');
    console.log(`netLog entries:          ${netLog.length}`);
    console.log(`PDF capture:             ${fs.existsSync(PDF_PATH) ? PDF_PATH + ' (' + fs.statSync(PDF_PATH).size + 'B)' : 'NO GENERADO'}`);
    console.log(`frmConsultaFactura HTML: ${fs.existsSync(CONSULTA_HTML_PATH) ? CONSULTA_HTML_PATH + ' (' + fs.statSync(CONSULTA_HTML_PATH).size + 'B)' : 'NO GENERADO'}`);
    const binFiles = fs.readdirSync(NET_BIN_DIR);
    console.log(`Binarios en ${NET_BIN_DIR}: ${binFiles.length} archivo(s)`);
    for (const f of binFiles) console.log(`  ${f} (${fs.statSync(path.join(NET_BIN_DIR, f)).size}B)`);
    console.log('\n[INSPECT] FIN.');

  } catch (e) {
    console.error('\n[INSPECT] EXCEPCIÓN no recuperable:', e.message.split('\n')[0]);
    persistNetLog();
    process.exit(1);
  } finally {
    await closeBrowser(browser);
    persistNetLog();
  }
})();
