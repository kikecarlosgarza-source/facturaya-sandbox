const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const jsUrls = [];
  page.on('response', r => {
    const u = r.url();
    if (u.endsWith('.js') && u.includes('homedepot')) jsUrls.push(u);
  });

  await page.goto('https://facturacion.homedepot.com.mx:2053/FacturacionWeb/', { waitUntil: 'networkidle', timeout: 60000 });
  console.log('JS files capturados:', jsUrls.length);
  jsUrls.forEach(u => console.log('  -', u.split('/').pop()));

  // Descargar todos los bundles JS
  const fs = require('fs');
  for (const url of jsUrls) {
    try {
      const txt = await page.evaluate(async (u) => { const r = await fetch(u); return await r.text(); }, url);
      const name = url.split('/').pop().split('?')[0];
      fs.writeFileSync('/tmp/hd-' + name, txt);
      console.log('OK', name, txt.length, 'bytes');
    } catch(e) { console.log('FAIL', url, e.message); }
  }

  await browser.close();
})();
