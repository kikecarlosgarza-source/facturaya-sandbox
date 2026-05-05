const { chromium } = require('playwright');
const axios = require('axios');
const db = require('../db/database');
const claudeAgent = require('./claudeAgent');

const TIMEOUT_TOTAL_MS    = 90000;
const NAV_TIMEOUT_MS      = 15000;
const POST_FILL_WAIT_MS   = 1000;
const POST_SUBMIT_WAIT_MS = 5000;
const CLAUDE_MAX_PASOS    = 6;
const PORTAL_LABEL        = 'universal';

const CAPSOLVER_API = 'https://api.capsolver.com';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL  = 'claude-sonnet-4-6';

const FIELD_SELECTORS = {
  folio: [
    "input[name*='folio' i]", "input[id*='folio' i]",
    "input[name*='ticket' i]", "input[id*='ticket' i]",
    "input[placeholder*='folio' i]", "input[placeholder*='ticket' i]"
  ],
  rfc: [
    "input[name*='rfc' i]", "input[id*='rfc' i]", "input[placeholder*='RFC' i]"
  ],
  email: [
    "input[type=email]", "input[name*='email' i]", "input[name*='correo' i]", "input[id*='mail' i]"
  ],
  cp: [
    "input[name*='postal' i]", "input[name*='cp' i]", "input[id*='cp' i]", "input[placeholder*='postal' i]"
  ],
  nombre: [
    "input[name*='razon' i]", "input[name*='nombre' i]", "input[id*='razon' i]", "input[id*='legal' i]"
  ],
  total: [
    "input[name*='total' i]", "input[name*='monto' i]", "input[name*='importe' i]"
  ]
};

const SUBMIT_TEXTS = ['Facturar', 'FACTURAR', 'Generar', 'Emitir', 'Enviar', 'Solicitar', 'Continuar'];
const SUCCESS_KEYWORDS = ['factura generada', 'cfdi generado', 'folio fiscal', 'enviado a tu correo', 'descarga', 'éxito', 'exitoso', 'xml', 'pdf'];

// Persistencia de patrones exitosos. Insertamos con active=1 directo (no pasa por testRunner
// porque patch_js es JSON descriptor, no JS ejecutable — testRunner lo marcaría failed).
const insertPattern = db.prepare(`
  INSERT INTO portal_scripts (portal, step, patch_js, descripcion, confidence, active)
  VALUES (?, ?, ?, ?, ?, 1)
`);

// Lookup de parches activos. Matchea por brand (portal LIKE '%heb%') o por URL
// pattern embebido en el campo step (que claudeAgent serializa como JSON).
const findActivePatches = db.prepare(`
  SELECT id, patch_js, descripcion, confidence
  FROM portal_scripts
  WHERE (portal LIKE ? OR step LIKE ?) AND active = 1
  ORDER BY confidence DESC, id DESC
  LIMIT 5
`);

function urlPattern(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname;
  } catch { return url; }
}

// Extrae el "brand" de una URL para hacer match contra el campo portal:
// "facturacion.heb.com.mx" → "heb", "homedepot.com.mx" → "homedepot".
function brandFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    const tlds = new Set(['com','org','net','gob','edu','mx','us','co']);
    while (parts.length > 1 && tlds.has(parts[parts.length - 1].toLowerCase())) {
      parts.pop();
    }
    return parts[parts.length - 1] || host;
  } catch { return ''; }
}

async function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${label} >${ms}ms`)), ms))
  ]);
}

// Wrapper para page.evaluate que tolera navegaciones. Algunos portales (HEB)
// redirigen internamente tras el load inicial, destruyendo el execution context
// y rompiendo cualquier evaluate en vuelo. Si detectamos ese error, esperamos a
// que la nueva navegación termine y reintentamos una vez; si vuelve a fallar
// devolvemos defaultValue para que el caller pueda decidir qué hacer.
async function safeEvaluate(page, fn, arg, defaultValue = null) {
  try {
    return await page.evaluate(fn, arg);
  } catch (e) {
    if (!/Execution context was destroyed|context was destroyed/i.test(e.message || '')) {
      throw e;
    }
    try {
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      return await page.evaluate(fn, arg);
    } catch (e2) {
      console.log('[universal] safeEvaluate fallback tras navegación:', e2.message);
      return defaultValue;
    }
  }
}

async function findFirstSelector(page, selectors) {
  for (const s of selectors) {
    try {
      const el = await page.$(s);
      if (el) return s;
    } catch {}
  }
  return null;
}

async function rellenarHeuristico(page, perfil, ticketData) {
  const usados = {};
  const valores = {
    folio: String(ticketData.folio || ticketData.codigo_facturacion || ''),
    rfc:    perfil.rfc,
    email:  perfil.email,
    cp:     perfil.cp,
    nombre: perfil.nombre_sat || perfil.nombre,
    total:  ticketData.total ? String(ticketData.total) : ''
  };

  for (const campo of Object.keys(FIELD_SELECTORS)) {
    if (!valores[campo]) continue;
    const sel = await findFirstSelector(page, FIELD_SELECTORS[campo]);
    if (sel) {
      try {
        await page.fill(sel, valores[campo]);
        usados[campo] = sel;
      } catch {}
    }
  }

  // Selects de régimen y uso CFDI por código SAT
  for (const [campo, val] of [['regimen', perfil.regimen], ['uso_cfdi', perfil.uso_cfdi]]) {
    if (!val) continue;
    const sel = await findFirstSelector(page, [
      `select[name*='${campo}' i]`, `select[id*='${campo}' i]`,
      campo === 'uso_cfdi' ? "select[name*='cfdi' i]" : `select[name*='${campo}' i]`
    ]);
    if (sel) {
      try {
        await page.selectOption(sel, val);
        usados[campo] = sel;
      } catch {
        // Fallback para selectpickers custom
        try {
          await safeEvaluate(page, ({s, v}) => {
            const el = document.querySelector(s);
            if (el) {
              const opt = Array.from(el.options).find(o => o.value === v || o.text.includes(v));
              if (opt) {
                el.value = opt.value;
                el.dispatchEvent(new Event('change', {bubbles: true}));
              }
            }
          }, {s: sel, v: val});
          usados[campo] = sel;
        } catch {}
      }
    }
  }

  return usados;
}

async function detectarYResolverCaptcha(page, url) {
  const info = await safeEvaluate(page, () => {
    const cf = document.querySelector('.cf-turnstile, [data-sitekey][class*="turnstile"]');
    if (cf) return { tipo: 'turnstile', sitekey: cf.dataset.sitekey || null };
    const cfIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
    if (cfIframe) {
      const m = cfIframe.src.match(/[?&]k=([^&]+)/);
      return { tipo: 'turnstile', sitekey: m ? m[1] : null };
    }
    const re = document.querySelector('.g-recaptcha[data-sitekey]');
    if (re) return { tipo: 'recaptcha', sitekey: re.dataset.sitekey };
    const hc = document.querySelector('.h-captcha[data-sitekey]');
    if (hc) return { tipo: 'hcaptcha', sitekey: hc.dataset.sitekey };
    // [data-sitekey] sin clase específica — probable Turnstile
    const generic = document.querySelector('[data-sitekey]');
    if (generic) return { tipo: 'turnstile', sitekey: generic.dataset.sitekey };
    return { tipo: 'none', sitekey: null };
  }, null, { tipo: 'none', sitekey: null });

  if (info.tipo === 'none') return { tipo: 'none' };
  if (!info.sitekey) return { tipo: info.tipo, error: 'sitekey no encontrado en DOM' };

  const capKey = process.env.CAPSOLVER_API_KEY;
  if (!capKey) return { tipo: info.tipo, error: 'CAPSOLVER_API_KEY no configurada' };

  const taskTypes = {
    turnstile: 'AntiTurnstileTaskProxyLess',
    recaptcha: 'ReCaptchaV2TaskProxyLess',
    hcaptcha:  'HCaptchaTaskProxyLess'
  };

  try {
    const create = await axios.post(`${CAPSOLVER_API}/createTask`, {
      clientKey: capKey,
      task: { type: taskTypes[info.tipo], websiteURL: url, websiteKey: info.sitekey }
    }, { timeout: 15000 });
    if (create.data.errorId) return { tipo: info.tipo, error: 'CapSolver: ' + create.data.errorDescription };

    const taskId = create.data.taskId;
    let token = null;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 4000));
      const res = await axios.post(`${CAPSOLVER_API}/getTaskResult`, { clientKey: capKey, taskId }, { timeout: 15000 });
      if (res.data.status === 'ready') {
        token = res.data.solution?.token || res.data.solution?.gRecaptchaResponse;
        break;
      }
      if (res.data.errorId) return { tipo: info.tipo, error: 'CapSolver: ' + res.data.errorDescription };
    }
    if (!token) return { tipo: info.tipo, error: 'CapSolver timeout' };

    // Inyectar el token según el tipo de captcha
    await safeEvaluate(page, ({tipo, t}) => {
      if (tipo === 'turnstile') {
        document.querySelectorAll('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]').forEach(el => {
          el.value = t;
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
        });
        if (window.turnstile) {
          try { window.turnstile.getResponse = () => t; } catch {}
        }
      } else if (tipo === 'recaptcha') {
        document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => { el.value = t; });
        try {
          if (window.___grecaptcha_cfg) {
            const clients = window.___grecaptcha_cfg.clients;
            for (const k of Object.keys(clients || {})) {
              const c = clients[k];
              for (const k2 of Object.keys(c || {})) {
                if (c[k2] && typeof c[k2].callback === 'function') { c[k2].callback(t); break; }
              }
            }
          }
        } catch {}
      } else if (tipo === 'hcaptcha') {
        document.querySelectorAll('textarea[name="h-captcha-response"]').forEach(el => { el.value = t; });
      }
    }, { tipo: info.tipo, t: token });

    await page.waitForTimeout(1000);
    return { tipo: info.tipo, resuelto: true };
  } catch (e) {
    return { tipo: info.tipo, error: e.message };
  }
}

async function findSubmit(page) {
  for (const txt of SUBMIT_TEXTS) {
    const sel = `button:has-text("${txt}")`;
    try {
      if (await page.$(sel)) return sel;
    } catch {}
  }
  if (await page.$('button[type=submit], input[type=submit]')) {
    return 'button[type=submit], input[type=submit]';
  }
  return null;
}

async function verificarExito(page) {
  const text = (await page.textContent('body').catch(() => '')) || '';
  const lower = text.toLowerCase();
  return SUCCESS_KEYWORDS.some(k => lower.includes(k));
}

// Fallback inspirado en el procesarConIA original (claudeService.js previo a la refactorización):
// loop de screenshots + Claude que decide siguiente paso. Aplica cuando el heurístico falla.
async function fallbackIA(page, perfil, ticketData) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { success: false, mensaje: 'Universal: heurístico falló y ANTHROPIC_API_KEY no configurada' };
  }

  const HEADERS = {
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json'
  };

  for (let paso = 0; paso < CLAUDE_MAX_PASOS; paso++) {
    const ss = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    if (!ss) return { success: false, mensaje: 'Universal: no se pudo capturar screenshot' };
    const b64 = ss.toString('base64');

    const prompt = `Eres un agente que llena formularios de facturación electrónica en México.
Datos del receptor: RFC=${perfil.rfc}, Nombre=${perfil.nombre_sat || perfil.nombre}, CP=${perfil.cp}, Email=${perfil.email}, Régimen=${perfil.regimen || '612'}, UsoCFDI=${perfil.uso_cfdi || 'G03'}.
Datos del ticket: Folio=${ticketData.folio || ''}, Total=${ticketData.total || ''}, Establecimiento=${ticketData.establecimiento || ''}.

Analiza la pantalla y dime el siguiente paso. Responde SOLO con JSON sin backticks:
{"accion": "click|fill|select|wait|done|error", "selector": "css selector", "valor": "valor a escribir si fill/select", "descripcion": "qué haces"}

Si ya se generó la factura responde {"accion":"done","descripcion":"factura generada"}.
Si hay error irrecuperable responde {"accion":"error","descripcion":"causa"}.`;

    let resp;
    try {
      resp = await axios.post(ANTHROPIC_API, {
        model: CLAUDE_MODEL,
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: prompt }
          ]
        }]
      }, { headers: HEADERS, timeout: 30000 });
    } catch (e) {
      return { success: false, mensaje: 'Universal: error Claude API - ' + e.message };
    }

    const texto = resp.data.content[0]?.text || '';
    let ins;
    try { ins = JSON.parse(texto.replace(/```json|```/g, '').trim()); }
    catch { return { success: false, mensaje: 'Universal: respuesta IA sin JSON válido' }; }

    console.log(`[universal IA paso ${paso}]`, ins.accion, '-', ins.descripcion);

    if (ins.accion === 'done')  return { success: true, mensaje: 'Universal: factura generada (vía IA)', via: 'ia' };
    if (ins.accion === 'error') return { success: false, mensaje: 'Universal IA: ' + ins.descripcion };
    if (ins.accion === 'wait')  { await page.waitForTimeout(2000); continue; }

    try {
      if (ins.accion === 'click')       await page.click(ins.selector);
      else if (ins.accion === 'fill')   await page.fill(ins.selector, ins.valor || '');
      else if (ins.accion === 'select') await page.selectOption(ins.selector, ins.valor);
    } catch (e) {
      console.log(`[universal IA paso ${paso}] acción falló:`, e.message);
    }

    await page.waitForTimeout(1500);
  }
  return { success: false, mensaje: `Universal IA: no se completó en ${CLAUDE_MAX_PASOS} pasos` };
}

// Replay de un macro grabado por el agente visual (Computer Use). Cada paso
// trae coordenada + selector inferido al momento de grabar. Preferimos selector
// (estable ante shifts de layout); coord es fallback cuando el selector ya no
// matchea. Los placeholders {{rfc}}, {{folio}}, etc. se sustituyen por los
// valores de este perfil/ticket antes de teclear.
async function replayMacro(page, macro, perfil, ticketData) {
  const subs = {
    '{{folio}}':    String(ticketData.folio || ticketData.codigo_facturacion || ''),
    '{{rfc}}':      perfil.rfc || '',
    '{{nombre}}':   perfil.nombre_sat || perfil.nombre || '',
    '{{cp}}':       perfil.cp || '',
    '{{email}}':    perfil.email || '',
    '{{regimen}}':  perfil.regimen || '612',
    '{{uso_cfdi}}': perfil.uso_cfdi || 'G03',
    '{{total}}':    String(ticketData.total || ''),
    '{{fecha}}':    String(ticketData.fecha_compra || ticketData.fecha || '')
  };

  function applySubs(text) {
    let out = String(text || '');
    for (const [ph, val] of Object.entries(subs)) {
      if (out.includes(ph)) out = out.split(ph).join(val);
    }
    return out;
  }

  for (const step of macro.steps) {
    const t = step.type;
    if (t === 'left_click' || t === 'right_click' || t === 'double_click') {
      let clicked = false;
      if (step.selector) {
        try {
          if (t === 'double_click') {
            await page.dblclick(step.selector, { timeout: 2000 });
          } else if (t === 'right_click') {
            await page.click(step.selector, { button: 'right', timeout: 2000 });
          } else {
            await page.click(step.selector, { timeout: 2000 });
          }
          clicked = true;
        } catch {}
      }
      if (!clicked && Array.isArray(step.coord)) {
        const [x, y] = step.coord;
        if (t === 'double_click') await page.mouse.dblclick(x, y);
        else if (t === 'right_click') await page.mouse.click(x, y, { button: 'right' });
        else await page.mouse.click(x, y);
      }
    } else if (t === 'type') {
      await page.keyboard.type(applySubs(step.text), { delay: 50 });
    } else if (t === 'key') {
      await page.keyboard.press(step.key);
    } else if (t === 'scroll' && Array.isArray(step.coord)) {
      await page.mouse.move(step.coord[0], step.coord[1]);
      await page.mouse.wheel(0, step.direction === 'down' ? 300 : -300);
    }
    await page.waitForTimeout(step.wait || 500);
  }
}

async function ejecutarConPage(page, url, perfil, ticketData) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS }).catch(() => {});

  // HEB y otros portales redirigen internamente tras el goto inicial; un segundo
  // waitForLoadState deja que esas navegaciones se asienten antes de tocar el DOM.
  await page.waitForLoadState('networkidle', { timeout: NAV_TIMEOUT_MS }).catch(() => {});

  // Esperar a que aparezca al menos un input antes de intentar detectar campos.
  // Si el form se renderiza tarde (SPA, lazy load), networkidle puede resolverse
  // antes de que el DOM tenga los inputs. Si timeout, seguimos con lo que haya.
  try {
    await page.waitForSelector('input', { timeout: 15000 });
  } catch (e) {
    console.log('[universal] waitForSelector(input) timeout — sigo con campos disponibles');
  }

  // Detectar archetypes problemáticos antes de intentar nada
  const sitState = await safeEvaluate(page, () => ({
    hasPasswordField: !!document.querySelector('input[type=password]'),
    visibleInputs:    document.querySelectorAll('input:not([type=hidden]):not([type=submit])').length
  }), null, { hasPasswordField: false, visibleInputs: 0 });

  if (sitState.hasPasswordField) {
    return { success: false, mensaje: 'Universal: portal requiere login (password field detectado)' };
  }
  if (sitState.visibleInputs === 0) {
    // Quizá el form aún se está renderizando, o un modal/banner bloquea los
    // inputs. Damos otros 10s, capturamos HTML y pedimos a Claude un parche
    // que destrabe la página antes de abortar.
    console.log('[universal] sin inputs visibles — esperando 10s y consultando Claude');
    await page.waitForTimeout(10000);

    let html = '';
    try { html = await page.content(); } catch {}

    let fix = null;
    try {
      fix = await claudeAgent.analyzeAndFix({
        portal: PORTAL_LABEL,
        step: { action: 'no_inputs_visibles', url_pattern: urlPattern(url) },
        error: 'No se detectaron inputs visibles tras networkidle + waitForSelector',
        html
      });
    } catch (e) {
      console.log('[universal] claudeAgent falló:', e.message);
    }

    const code = (fix?.patch || '').trim();
    if (!code || code.startsWith('{')) {
      return { success: false, mensaje: 'Universal: no se detectaron inputs visibles (Claude no generó parche aplicable)' };
    }

    try {
      console.log(`[universal] parche inline de Claude (conf=${fix.confidence}): ${fix.descripcion}`);
      await page.evaluate(code);
      await page.waitForTimeout(POST_FILL_WAIT_MS);
    } catch (e) {
      return { success: false, mensaje: 'Universal: parche inline falló - ' + e.message };
    }
    // Parche aplicado — caemos al flujo normal (captcha → patches activos → heurístico).
  }

  // Captcha primero — algunos portales bloquean submit hasta resolver
  const captcha = await detectarYResolverCaptcha(page, url);
  if (captcha.error) {
    console.log('[universal] captcha no se pudo resolver:', captcha.error);
    // continuar igual; quizá el portal acepta sin captcha
  }

  const urlPat = urlPattern(url);
  const brand  = brandFromUrl(url);

  // Replay de macros del agente visual antes que cualquier otra estrategia.
  // Si Computer Use logró facturar este portal antes, dejó un macro JSON
  // reproducible en portal_scripts (step='agente_visual_exitoso').
  try {
    const macros = db.prepare(`
      SELECT id, patch_js, descripcion, confidence
      FROM portal_scripts
      WHERE step = 'agente_visual_exitoso' AND active = 1
        AND (portal LIKE ? OR patch_js LIKE ?)
      ORDER BY confidence DESC, id DESC
      LIMIT 3
    `).all(`%${brand}%`, `%${urlPat}%`);

    for (const m of macros) {
      let macro;
      try { macro = JSON.parse(m.patch_js); } catch { continue; }
      if (!macro || macro.version !== 1 || !Array.isArray(macro.steps)) continue;

      try {
        console.log(`[universal] replay macro #${m.id} (conf=${m.confidence}, ${macro.steps.length} pasos)`);
        await replayMacro(page, macro, perfil, ticketData);
        if (await verificarExito(page)) {
          return {
            success: true,
            mensaje: `Universal: factura generada (macro agente visual #${m.id})`,
            via: 'macro',
            macroId: m.id
          };
        }
      } catch (e) {
        console.log(`[universal] macro #${m.id} falló:`, e.message);
      }
    }
  } catch (e) {
    console.log('[universal] error consultando macros:', e.message);
  }

  // Aplicador de parches: antes del heurístico, busca parches JS ejecutables
  // (no JSON descriptors) activos para esta URL/brand y aplícalos. Cierra el
  // ciclo "detectar fallo → claudeAgent genera parche → aplicar parche".
  try {
    const patches = findActivePatches.all(`%${brand}%`, `%${urlPat}%`);
    for (const p of patches) {
      // patch_js que empieza con '{' es JSON descriptor (selectores serializados),
      // no código ejecutable — saltarlo
      const code = (p.patch_js || '').trim();
      if (!code || code.startsWith('{')) continue;

      try {
        console.log(`[universal] aplicando parche #${p.id} (conf=${p.confidence}): ${p.descripcion}`);
        await page.evaluate(code);
        await page.waitForTimeout(POST_SUBMIT_WAIT_MS);
        if (await verificarExito(page)) {
          return {
            success: true,
            mensaje: `Universal: factura generada (parche #${p.id})`,
            via: 'parche',
            patchId: p.id
          };
        }
      } catch (e) {
        console.log(`[universal] parche #${p.id} falló:`, e.message);
      }
    }
  } catch (e) {
    console.log('[universal] error consultando parches:', e.message);
  }

  // Heurístico: rellenar campos detectados
  const usados = await rellenarHeuristico(page, perfil, ticketData);
  await page.waitForTimeout(POST_FILL_WAIT_MS);

  // Submit
  const submitSel = await findSubmit(page);
  if (!submitSel) {
    console.log('[universal] heurístico no encontró botón submit — fallback IA');
    return await fallbackIA(page, perfil, ticketData);
  }

  try {
    await page.click(submitSel);
  } catch (e) {
    return { success: false, mensaje: 'Universal: click submit falló - ' + e.message };
  }
  await page.waitForTimeout(POST_SUBMIT_WAIT_MS);

  if (await verificarExito(page)) {
    return {
      success: true,
      mensaje: 'Universal: factura generada (heurístico)',
      via: 'heuristico',
      usados,
      submitSel,
      captcha: captcha.tipo
    };
  }

  // Heurístico submitteó pero no detectamos éxito — intentar IA con la página post-submit
  console.log('[universal] heurístico submit hecho pero éxito no detectado — fallback IA');
  return await fallbackIA(page, perfil, ticketData);
}

async function ejecutar(perfil, ticketData) {
  const url = ticketData.portal_url || ticketData.url_facturacion || ticketData.codigo_facturacion;
  if (!url || !/^https?:\/\//.test(url)) {
    return { success: false, mensaje: 'Universal: ticket sin portal_url válido' };
  }

  let browser;
  let resultado = { success: false, mensaje: 'Universal: no completó' };
  let lastHtml = '';

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

    try {
      resultado = await withTimeout(
        ejecutarConPage(page, url, perfil, ticketData),
        TIMEOUT_TOTAL_MS,
        'handlerUniversal'
      );
    } catch (e) {
      resultado = { success: false, mensaje: 'Universal: ' + e.message };
    }

    // Capturar screenshot final + html para diagnóstico
    try {
      const ss = await page.screenshot({ type: 'jpeg', quality: 80 });
      resultado.screenshot = ss.toString('base64');
    } catch {}
    try { lastHtml = await page.content(); } catch {}

    // Persistir patrón si éxito por heurístico (la IA no produce un patrón replicable)
    if (resultado.success && resultado.via === 'heuristico' && resultado.usados) {
      try {
        const pattern = {
          url_pattern: urlPattern(url),
          selectors_used: { ...resultado.usados, submit: resultado.submitSel },
          captcha_type: resultado.captcha || 'none',
          wait_after_submit_ms: POST_SUBMIT_WAIT_MS
        };
        insertPattern.run(
          PORTAL_LABEL,
          `universal_pattern:${pattern.url_pattern}`,
          JSON.stringify(pattern),
          `Patrón universal exitoso para ${pattern.url_pattern}`,
          0.7
        );
      } catch (e) {
        console.warn('[universal] no se pudo persistir patrón:', e.message);
      }
    }

    // Reporte de fallo a Claude para diagnóstico
    if (!resultado.success) {
      claudeAgent.analyzeAndFix({
        portal: PORTAL_LABEL,
        step: { action: 'handler_universal_failed', url_pattern: urlPattern(url) },
        error: resultado.mensaje,
        html: lastHtml
      }).catch(() => {});
    }

    return resultado;
  } catch (e) {
    return { success: false, mensaje: 'Universal: ' + e.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { ejecutar };
