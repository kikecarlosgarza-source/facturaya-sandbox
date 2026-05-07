// Helper compartido para portales protegidos por DataDome u otro anti-bot
// que requiere ejecutar JS legítimo en un browser real (e7-eleven.com.mx,
// futuros candidatos). Usa playwright-extra + puppeteer-extra-plugin-stealth
// para aplicar ~17 evasiones (webdriver, navigator.plugins, navigator.languages,
// navigator.permissions, webgl vendor/renderer, chrome.runtime, window.chrome,
// iframe.contentWindow, etc.) sobre chromium headless.
//
// Compatibilidad: el contenedor de Render corre la imagen
// mcr.microsoft.com/playwright:v1.40.0-jammy, así que User-Agent Linux es
// consistente con navigator.platform real (evita inconsistencias que
// DataDome detecta vía cross-checks UA <-> platform).

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

let stealthRegistered = false;
function registerStealthOnce() {
  if (stealthRegistered) return;
  chromium.use(StealthPlugin());
  stealthRegistered = true;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled'
];

async function launchStealthBrowser(opts = {}) {
  registerStealthOnce();

  const {
    headless = true,
    userAgent = DEFAULT_USER_AGENT,
    locale = 'es-MX',
    timezoneId = 'America/Mexico_City',
    viewport = { width: 1280, height: 1200 },
    extraArgs = []
  } = opts;

  const browser = await chromium.launch({
    headless,
    args: [...DEFAULT_ARGS, ...extraArgs]
  });

  const context = await browser.newContext({
    userAgent,
    locale,
    timezoneId,
    viewport,
    extraHTTPHeaders: {
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.5'
    }
  });

  const page = await context.newPage();
  return { browser, context, page };
}

async function closeBrowser(browser) {
  if (!browser) return;
  try {
    await browser.close();
  } catch (e) {
    console.warn('[koneshBrowser] close error (non-fatal):', e.message);
  }
}

module.exports = { launchStealthBrowser, closeBrowser };
