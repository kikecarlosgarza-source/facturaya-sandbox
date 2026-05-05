const { chromium } = require('playwright');
const db = require('../db/database');

// URLs públicas donde el navegador puede aterrizar para validación.
// API-mode patches (step=api:*) no se validan aquí — se saltan.
const PORTAL_URLS = {
  'home depot': 'https://facturacion.homedepot.com.mx/FacturacionWeb/',
  'oxxo gas':   'https://facturacion.oxxogas.com',
  'petro':      'https://tarjetapetro-7.com.mx:8443/KPortalExterno/'
};

const NAV_TIMEOUT_MS   = 30000;
const PATCH_TIMEOUT_MS = 10000;

/**
 * Smoke test del parche: lo ejecuta en un navegador headless contra el landing del portal.
 * Detecta sintaxis, excepciones, loops infinitos. NO prueba que arregla el bug original.
 * Para portales que requieren login (OXXO Gas), el parche corre en la página de login —
 * útil para detectar errores obvios, no para validar fixes post-login.
 */
async function validatePatch({ portal, step, patch_js }) {
  const start = Date.now();

  if (typeof step === 'string' && step.startsWith('api:')) {
    return {
      passed: false,
      skipped: true,
      error: 'API-mode patch — no validable en browser',
      duration: Date.now() - start
    };
  }

  const url = PORTAL_URLS[portal];
  if (!url) {
    return {
      passed: false,
      skipped: true,
      error: `No hay URL de validación configurada para portal '${portal}'`,
      duration: Date.now() - start
    };
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors']
    });
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

    // IIFE wrapper para soportar múltiples statements en patch_js.
    // Promise.race mata la ejecución si el parche cuelga.
    await Promise.race([
      page.evaluate(`(function(){ ${patch_js} })()`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`patch_js timeout >${PATCH_TIMEOUT_MS}ms`)), PATCH_TIMEOUT_MS)
      )
    ]);

    return { passed: true, duration: Date.now() - start };
  } catch (e) {
    return { passed: false, error: e.message, duration: Date.now() - start };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

const selectPatch = db.prepare(`SELECT id, portal, step, patch_js FROM portal_scripts WHERE id = ?`);
const updateValidation = db.prepare(`UPDATE portal_scripts SET active = ?, validation_error = ? WHERE id = ?`);

/**
 * Lee el parche por id, lo valida, y actualiza active + validation_error.
 * - passed: active=1, validation_error=NULL
 * - skipped (API-mode o portal sin URL): active=1, validation_error=nota
 * - failed: active=0, validation_error=mensaje del error
 */
async function validateAndActivate(patchId) {
  const patch = selectPatch.get(patchId);
  if (!patch) return { passed: false, error: 'patch no encontrado', duration: 0 };

  const result = await validatePatch(patch);

  // Skipped patches stay active (no se pueden validar pero no están "rotos").
  // Passed patches activate. Failed patches deactivate.
  const shouldActivate = result.passed || result.skipped;
  updateValidation.run(
    shouldActivate ? 1 : 0,
    result.error || null,
    patchId
  );

  return result;
}

module.exports = { validatePatch, validateAndActivate };
