// Inspector de portales: visita una URL y dump form fields, FAQ links,
// captcha, headings. Salida JSON a stdout.
const { chromium } = require('playwright');

(async () => {
  const url = process.argv[2];
  if (!url) { console.error('Usage: node portal-inspector.js <url>'); process.exit(1); }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-blink-features=AutomationControlled']
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 }
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    try { await page.waitForSelector('input,select,form', { timeout: 5000 }); } catch {}

    const result = await page.evaluate(() => {
      const labelOf = (el) => {
        if (!el) return null;
        try {
          if (el.labels && el.labels[0]) return el.labels[0].textContent.trim().substring(0, 80);
          const id = el.id;
          if (id) {
            const lab = document.querySelector('label[for="' + id + '"]');
            if (lab) return lab.textContent.trim().substring(0, 80);
          }
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.substring(0, 80);
        } catch {}
        return null;
      };

      const inputs = Array.from(document.querySelectorAll('input:not([type=hidden]):not([type=submit])')).map(i => ({
        name: i.name || null,
        id:   i.id || null,
        placeholder: i.placeholder || null,
        type: i.type,
        label: labelOf(i)
      }));
      const selects = Array.from(document.querySelectorAll('select')).map(s => ({
        name: s.name || null,
        id: s.id || null,
        label: labelOf(s),
        options: Array.from(s.options).slice(0, 6).map(o => o.text.trim()).filter(Boolean)
      }));
      const textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
        name: t.name || null, id: t.id || null, label: labelOf(t)
      }));
      const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'))
        .map(b => (b.textContent || b.value || '').trim().substring(0, 60))
        .filter(Boolean).slice(0, 12);

      const faqLinks = Array.from(document.querySelectorAll('a')).filter(a => {
        const t = (a.textContent || '').toLowerCase();
        return t.includes('ayuda') || t.includes('faq') || t.includes('instruccion') ||
               t.includes('preguntas') || t.includes('como factur') || t.includes('cómo factur') ||
               t.includes('pasos');
      }).slice(0, 5).map(a => ({
        text: a.textContent.trim().substring(0, 60),
        href: a.href
      }));

      const captcha = {
        recaptcha: !!document.querySelector('.g-recaptcha, [class*=recaptcha]'),
        hcaptcha:  !!document.querySelector('.h-captcha, [class*=hcaptcha]'),
        turnstile: !!document.querySelector('.cf-turnstile, [class*=turnstile], iframe[src*="cloudflare.com/cdn-cgi"]'),
        sitekey:   document.querySelector('[data-sitekey]') ? document.querySelector('[data-sitekey]').dataset.sitekey : null
      };

      const hasPassword = !!document.querySelector('input[type=password]');
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .slice(0, 6).map(h => h.textContent.trim().substring(0, 120)).filter(Boolean);

      const bodySnippet = (document.body && document.body.innerText) ? document.body.innerText.replace(/\s+/g, ' ').trim().substring(0, 600) : '';

      return {
        finalUrl: location.href,
        title: document.title,
        headings,
        inputs,
        selects,
        textareas,
        buttons,
        faqLinks,
        captcha,
        hasPassword,
        bodySnippet
      };
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(2);
  } finally {
    await browser.close();
  }
})();
