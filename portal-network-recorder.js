// Recorder pasivo de tráfico HTTP de un portal. NO interactúa con el form.
// Uso:
//   node portal-network-recorder.js <url> <output.json> [waitSeconds=10]
//
// Output: JSON con array de requests {method, url, resourceType, headers,
// requestBody, status, responseHeaders, responseBody}. Bodies truncados
// a 4000 chars para mantener archivos manejables. Errores no abortan
// el script — siguen grabando otros requests.
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const url = process.argv[2];
  const out = process.argv[3];
  const waitSeconds = Number(process.argv[4] || 10);
  if (!url || !out) { console.error('Usage: node portal-network-recorder.js <url> <output.json> [waitSeconds]'); process.exit(1); }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--ignore-certificate-errors']
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();

  const calls = new Map();  // request.url() + uniq → record
  let counter = 0;

  page.on('request', (req) => {
    const id = (++counter) + ' ' + req.url();
    let body = null;
    try { body = req.postData(); } catch {}
    calls.set(id, {
      n: counter,
      method: req.method(),
      url: req.url(),
      resourceType: req.resourceType(),
      headers: req.headers(),
      requestBody: body ? body.substring(0, 4000) : null,
      requestBodyTruncated: !!(body && body.length > 4000)
    });
  });

  page.on('response', async (resp) => {
    try {
      const req = resp.request();
      // Find the matching record (último con esa URL no respondido aún)
      let record = null;
      for (const [k, v] of [...calls.entries()].reverse()) {
        if (v.url === req.url() && v.status === undefined) { record = v; break; }
      }
      if (!record) return;
      record.status = resp.status();
      record.responseHeaders = resp.headers();
      // Solo capturar body para text-ish: skip images, fonts, media.
      const ct = (resp.headers()['content-type'] || '').toLowerCase();
      const skip = /image|font|video|audio|octet-stream/.test(ct);
      if (!skip) {
        try {
          const text = await resp.text();
          record.responseBody = text.substring(0, 4000);
          record.responseBodyTruncated = text.length > 4000;
        } catch (e) {
          record.responseBodyError = e.message.substring(0, 120);
        }
      } else {
        record.responseBody = `[skipped ${ct}]`;
      }
    } catch {}
  });

  let navError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    navError = e.message;
  }

  // Esperar el tiempo solicitado para capturar requests post-load (XHRs lazy)
  await page.waitForTimeout(waitSeconds * 1000);

  const records = [...calls.values()].sort((a, b) => a.n - b.n);
  const summary = {
    inspected_at: new Date().toISOString(),
    requested_url: url,
    final_url: page.url(),
    nav_error: navError,
    total_requests: records.length,
    by_resource_type: records.reduce((acc, r) => { acc[r.resourceType] = (acc[r.resourceType] || 0) + 1; return acc; }, {}),
    by_host: records.reduce((acc, r) => {
      try { const h = new URL(r.url).host; acc[h] = (acc[h] || 0) + 1; } catch {}
      return acc;
    }, {}),
    requests: records
  };

  fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log(`[${out}] ${records.length} requests, final_url=${page.url()}`);

  await browser.close();
})();
