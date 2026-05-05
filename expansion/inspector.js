const { chromium } = require('playwright');

const NAV_TIMEOUT_MS = 5000;
const POST_LOAD_WAIT_MS = 2000;
const HTML_MAX_CHARS = 15000;

function derivarCandidatosURL(target) {
  if (target.url_facturacion) return [target.url_facturacion];

  const baseId = target.id.replace(/_/g, '');
  const dashId = target.id.replace(/_/g, '-');
  const dominios = Array.from(new Set([baseId, dashId]));
  const tlds = ['.com.mx', '.mx'];
  const paths = ['/facturacion', '/factura', '/portal-fiscal'];

  const candidatos = [];
  for (const dom of dominios) {
    for (const tld of tlds) {
      for (const p of paths) {
        candidatos.push(`https://${dom}${tld}${p}`);
      }
    }
  }
  return candidatos;
}

async function inspectPortal(target) {
  const result = {
    id: target.id,
    url_encontrada: null,
    html_limpio: '',
    campos: [],
    captcha: 'none',
    tecnologia: 'unknown',
    titulo: null,
    status: 'not_found',
    error: null
  };

  const candidatos = derivarCandidatosURL(target);
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors']
    });
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await ctx.newPage();

    // Probar candidatos en orden, primer 2xx/3xx gana
    for (const u of candidatos) {
      try {
        const resp = await page.goto(u, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        if (resp && resp.status() < 400) { result.url_encontrada = u; break; }
      } catch (e) { /* siguiente candidato */ }
    }

    if (!result.url_encontrada) {
      result.error = `Ninguna de ${candidatos.length} URLs candidatas respondió 2xx/3xx`;
      return result;
    }

    // Esperar que SPAs hidraten antes de inspeccionar
    await page.waitForTimeout(POST_LOAD_WAIT_MS);

    result.titulo = await page.title().catch(() => null);

    result.html_limpio = await page.evaluate(() => {
      const clone = document.documentElement.cloneNode(true);
      clone.querySelectorAll('script, style, link[rel="stylesheet"], noscript').forEach(el => el.remove());
      clone.querySelectorAll('[style]').forEach(el => el.removeAttribute('style'));
      return clone.outerHTML;
    });
    if (result.html_limpio.length > HTML_MAX_CHARS) {
      result.html_limpio = result.html_limpio.slice(0, HTML_MAX_CHARS);
    }

    result.campos = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input, select, textarea, button'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({
          tipo: el.tagName === 'INPUT' ? `input:${el.type || 'text'}` : el.tagName.toLowerCase(),
          name: el.name || null,
          id: el.id || null,
          placeholder: el.placeholder || null
        }))
    );

    result.captcha = await page.evaluate(() => {
      if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]')) return 'turnstile';
      if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]')) return 'recaptcha';
      if (document.querySelector('.h-captcha, iframe[src*="hcaptcha.com"]')) return 'hcaptcha';
      // [data-sitekey] genérico — probable Turnstile sin clase explícita
      if (document.querySelector('[data-sitekey]')) return 'turnstile';
      return 'none';
    });

    result.tecnologia = await page.evaluate(() => {
      if (window.__NEXT_DATA__ || document.getElementById('__next')) return 'spa';
      if (window.__NUXT__) return 'spa';
      if (window.angular || document.querySelector('[ng-app], [ng-controller]')) return 'spa';
      const root = document.getElementById('root') || document.getElementById('app');
      if (root && document.querySelectorAll('script[src]').length > 5) return 'spa';
      if (document.querySelectorAll('form input').length > 2) return 'html_simple';
      if ((document.body?.innerText || '').trim().length > 500) return 'html_simple';
      return 'unknown';
    });

    result.status = 'ok';
    return result;
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
    return result;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { inspectPortal };
