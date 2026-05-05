const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport:{width:1280,height:900} });
  const page = await ctx.newPage();

  await page.goto('https://facturacion.homedepot.com.mx:2053/FacturacionWeb/#/portalweb', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(8000);

  // Esperar a que el Turnstile aparezca
  console.log('Buscando widget Turnstile...');
  for (let i = 0; i < 15; i++) {
    const found = await page.evaluate(() => {
      const ts1 = document.querySelector('.cf-turnstile, [data-sitekey]');
      const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
      return { hasDiv: !!ts1, hasIframe: !!iframe, iframeSrc: iframe?.src?.substring(0,200) };
    });
    if (found.hasDiv || found.hasIframe) { console.log('Encontrado en intento', i, found); break; }
    await page.waitForTimeout(1500);
  }

  // Inspeccionar TODO div con data-sitekey o atributos relacionados
  const r = await page.evaluate(() => {
    const out = { divs: [], iframes: [], sitekeyEls: [], turnstileScripts: [] };
    document.querySelectorAll('[data-sitekey]').forEach(el => out.sitekeyEls.push({ tag:el.tagName, id:el.id, classes:el.className, sitekey:el.dataset.sitekey, allDataset: Object.assign({}, el.dataset) }));
    document.querySelectorAll('div[class*="turnstile"], div[class*="Turnstile"], div[class*="cf-"], div.cf-turnstile').forEach(el => out.divs.push({ classes:el.className, attrs: Array.from(el.attributes).map(a=>a.name+'='+a.value).join('|'), dataset: Object.assign({}, el.dataset) }));
    document.querySelectorAll('iframe').forEach(el => out.iframes.push({ src: el.src?.substring(0,300), name: el.name, id: el.id }));
    document.querySelectorAll('script[src*="turnstile"], script[src*="challenges.cloudflare"]').forEach(s => out.turnstileScripts.push(s.src));
    return out;
  });
  console.log(JSON.stringify(r, null, 2));

  await browser.close();
})();
