// Driver con interacción de form para 4 portales. Captura TODA la red,
// hace los fills indicados, NO hace clic en el submit final.
// Uso: node portal-driver-record.js <heb|alsea|benavides|hd>
const { chromium } = require('playwright');
const fs = require('fs');

const PORTAL = process.argv[2];
if (!PORTAL) { console.error('Usage: node portal-driver-record.js <heb|alsea|benavides|hd>'); process.exit(1); }

const OUT = `/Users/fival020/Desktop/facturasat-fixed/backend/expansion/apis/${PORTAL}_full.json`;

// Datos del usuario (datos sintéticos genéricos del SAT)
const PERFIL = {
  rfc: 'XAXX010101000',
  nombre: 'PUBLICO EN GENERAL',
  cp: '01000',
  email: 'test@example.com',
  regimen: '616',  // Sin obligaciones fiscales (público en general)
  uso_cfdi: 'S01'  // Sin efectos fiscales
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 1100 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  const calls = [];
  let n = 0;
  page.on('request', (req) => {
    let body = null; try { body = req.postData(); } catch {}
    calls.push({
      n: ++n, method: req.method(), url: req.url(), resourceType: req.resourceType(),
      headers: req.headers(),
      requestBody: body ? body.substring(0, 6000) : null,
      requestBodyTruncated: !!(body && body.length > 6000)
    });
  });
  page.on('response', async (resp) => {
    try {
      const r = [...calls].reverse().find(x => x.url === resp.request().url() && x.status === undefined);
      if (!r) return;
      r.status = resp.status();
      r.responseHeaders = resp.headers();
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      if (!/image|font|video|audio|octet-stream/.test(ct)) {
        try {
          const t = await resp.text();
          r.responseBody = t.substring(0, 6000);
          r.responseBodyTruncated = t.length > 6000;
        } catch (e) { r.responseBodyError = e.message.substring(0, 120); }
      } else {
        r.responseBody = `[skipped ${ct}]`;
      }
    } catch {}
  });

  let driverError = null;
  let driverNote = null;
  try {
    if (PORTAL === 'heb')        await driveHeb(page);
    else if (PORTAL === 'alsea') await driveAlsea(page);
    else if (PORTAL === 'benavides') await driveBenavides(page);
    else if (PORTAL === 'hd')    await driveHomeDepot(page);
    else throw new Error('portal desconocido: ' + PORTAL);
  } catch (e) {
    driverError = e.message;
    console.error(`[${PORTAL}] driver error:`, e.message);
  }

  // Capturar requests trailing (XHR async post-click)
  await page.waitForTimeout(8000);

  fs.writeFileSync(OUT, JSON.stringify({
    portal: PORTAL,
    inspected_at: new Date().toISOString(),
    final_url: page.url(),
    driver_error: driverError,
    driver_note: driverNote,
    perfil_used: PERFIL,
    total_requests: calls.length,
    by_resource_type: calls.reduce((acc, r) => { acc[r.resourceType] = (acc[r.resourceType] || 0) + 1; return acc; }, {}),
    by_host: calls.reduce((acc, r) => { try { const h = new URL(r.url).host; acc[h] = (acc[h] || 0) + 1; } catch {} return acc; }, {}),
    requests: calls
  }, null, 2));
  console.log(`[${PORTAL}] saved ${calls.length} requests → ${OUT}`);
  await browser.close();
})();

// ── HEB ────────────────────────────────────────────────────────────
async function driveHeb(page) {
  await page.goto('https://facturacion.heb.com.mx', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  // Por inspección sabemos los inputs son mat-input-N en el orden:
  // 0=Sucursal (autocomplete), 1=Ticket, 2=Fecha, 3=Venta
  const inputs = await page.$$('input.mat-input-element, input[id^="mat-input"]');
  if (inputs.length < 4) throw new Error(`HEB esperaba 4 mat-inputs, encontró ${inputs.length}`);

  // Sucursal: typing 285 dispara autocomplete
  await inputs[0].click();
  await inputs[0].fill('285');
  await page.waitForTimeout(1500);
  // Buscar opción del autocomplete que contenga 285
  const opts = await page.$$('mat-option');
  if (opts.length > 0) {
    await opts[0].click();
  }
  await page.waitForTimeout(500);

  // Ticket
  await inputs[1].click();
  await inputs[1].fill('1059611498505261226029968');

  // Fecha — Material datepicker rechaza fill directo ("not editable").
  // Workaround: focus + keyboard.type (simula tipeo real). Después Escape
  // para cerrar el overlay del calendario que bloquea clicks subsecuentes.
  await inputs[2].click();
  await page.waitForTimeout(300);
  await page.keyboard.type('26/05/2025', { delay: 50 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // Venta — usar focus directo para evitar problemas con overlays residuales
  await inputs[3].focus();
  await inputs[3].fill('237');
  await page.keyboard.press('Tab');
  await page.waitForTimeout(1000);

  // Click "Agregar ticket" — dispara buscar_ticket / int_ticket_sel APIs
  const agregarBtn = await page.$('button:has-text("Agregar")');
  if (agregarBtn) {
    await agregarBtn.click();
    await page.waitForTimeout(5000);
  }
  // No hacer click en el botón final de timbrar
}

// ── Alsea Starbucks ────────────────────────────────────────────────
async function driveAlsea(page) {
  await page.goto('https://alsea.interfactura.com/?opc=Starbucks', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Si no entró ya en variant Starbucks, click el logo
  const visForm = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form.billing_form')).some(f => f.offsetParent !== null);
  });
  if (!visForm) {
    await page.click('.billing_brand_selection img[src*="logo_starbucks.svg"]');
    await page.waitForTimeout(2000);
  }

  // Fill paso 1
  async function fillAndDispatch(sel, value) {
    await page.fill(sel, value);
    await page.dispatchEvent(sel, 'input');
    await page.dispatchEvent(sel, 'change');
  }
  await fillAndDispatch('#rfc', PERFIL.rfc);
  await fillAndDispatch('#ticket', '286761141');
  await fillAndDispatch('#tienda', '38199');
  await fillAndDispatch('#dtFecha', '05/05/2026');
  await page.waitForTimeout(500);

  // Submit paso 1 — el Enviar del form visible
  await page.evaluate(() => {
    const visForm = Array.from(document.querySelectorAll('form.billing_form')).find(f => f.offsetParent !== null);
    const btn = visForm && visForm.querySelector('button[type=submit]');
    if (btn) btn.click();
  });
  // Esperar paso 2 / modal de error / lo que sea
  await page.waitForTimeout(6000);

  // Si llegó a paso 2 (datos fiscales), llenar pero NO submitear
  const tienePaso2 = await page.evaluate(() =>
    !!document.querySelector('[name="codigoPostal"], [name="regimenFiscal"], [name="correoElectronico"], [formcontrolname="regimenFiscal"]'));
  if (tienePaso2) {
    // Best-effort fill paso 2
    try {
      await page.fill('[name="codigoPostal"], #codigoPostal', PERFIL.cp).catch(() => {});
      await page.fill('[name="correoElectronico"], #correoElectronico', PERFIL.email).catch(() => {});
      await page.selectOption('[name="regimenFiscal"], #regimenFiscal', PERFIL.regimen).catch(() => {});
      await page.selectOption('[name="usoCfdi"], #usoCfdi', PERFIL.uso_cfdi).catch(() => {});
    } catch {}
  }
  // No submitear paso 2
}

// ── Benavides ──────────────────────────────────────────────────────
async function driveBenavides(page) {
  await page.goto('https://e-facturate.com/benavides/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Inspección runtime: buscar inputs visibles y llenar best-effort
  const fields = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit])'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({ id: i.id, name: i.name, placeholder: i.placeholder, type: i.type }));
  });
  console.log('[benavides] visible inputs:', JSON.stringify(fields));

  // Mapeo heurístico — Benavides usa ASP.NET con campos típicos
  const map = [
    { keys: ['tienda','sucursal','store'], value: 'M214' },
    { keys: ['ticket','folio','transac'],  value: '14026804195588' },
    { keys: ['fecha','date'],               value: '05/05/2026' },
    { keys: ['total','monto','importe'],    value: '40.00' },
    { keys: ['rfc'],                        value: PERFIL.rfc },
    { keys: ['email','correo','mail'],      value: PERFIL.email }
  ];
  for (const f of fields) {
    const txt = ((f.id || '') + ' ' + (f.name || '') + ' ' + (f.placeholder || '')).toLowerCase();
    for (const m of map) {
      if (m.keys.some(k => txt.includes(k))) {
        const sel = f.id ? `#${CSS.escape ? CSS.escape(f.id) : f.id}` : `[name="${f.name}"]`;
        try { await page.fill(sel, m.value); } catch {}
        break;
      }
    }
  }
  await page.waitForTimeout(2000);
  // No clickeamos submit
}

// ── Home Depot ─────────────────────────────────────────────────────
async function driveHomeDepot(page) {
  // Sin folio del usuario, solo navegar y dejar que la SPA cargue.
  await page.goto('https://facturacion.homedepot.com.mx', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(8000);
}
