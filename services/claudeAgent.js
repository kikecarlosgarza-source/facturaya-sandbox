const axios = require('axios');
const db    = require('../db/database');
const testRunner = require('./testRunner');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01'
};

const insertScript = db.prepare(`
  INSERT INTO portal_scripts (portal, step, patch_js, descripcion, confidence, active)
  VALUES (?, ?, ?, ?, ?, 0)
`);

/**
 * Analiza un paso fallido del flujo de un portal, pide a Anthropic un parche JS,
 * lo persiste en portal_scripts con active=1 y lo devuelve al caller.
 *
 * El INSERT está envuelto en try/catch — si la BD falla, igual devolvemos el fix.
 */
async function analyzeAndFix({ portal, step, error, html }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }

  const systemPrompt = `Eres un experto en automatización con Playwright para portales de facturación electrónica de México. Recibes un paso de un flujo declarativo que falló junto con el HTML actual del portal. Genera un parche JavaScript que, ejecutado dentro de page.evaluate(), recupere el paso fallido (encuentre el selector correcto, dispare el evento que faltó, cierre un modal que bloquea la interacción, etc.).

Responde SOLO con JSON sin backticks:
{
  "descripcion": "una línea explicando qué hace el parche",
  "patch": "código JS válido para page.evaluate(); document y window están disponibles",
  "confidence": 0.0
}

confidence es un número entre 0 y 1 que refleja qué tan seguro estás de que el parche funcionará en el portal actual.`;

  const userMsg = `Portal: ${portal || 'desconocido'}
Paso fallido: ${JSON.stringify(step)}
Error: ${error}

HTML (truncado a 6000 chars):
${(html || '').slice(0, 6000)}`;

  const resp = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  }, { headers: HEADERS, timeout: 30000 });

  const text = resp.data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respuesta de Claude sin JSON');
  const fix = JSON.parse(match[0]);

  try {
    const info = insertScript.run(
      portal || null,
      step ? JSON.stringify(step) : null,
      fix.patch || '',
      fix.descripcion || null,
      typeof fix.confidence === 'number' ? fix.confidence : null
    );
    fix.id = info.lastInsertRowid;
    testRunner.validateAndActivate(info.lastInsertRowid)
      .catch(err => console.warn(`[testRunner] validateAndActivate falló id=${info.lastInsertRowid}:`, err.message));
  } catch (dbErr) {
    console.warn('[claudeAgent] no se pudo persistir el parche:', dbErr.message);
  }

  return fix;
}

/**
 * Analiza una llamada HTTP fallida a la API de un portal de facturación
 * y devuelve un diagnóstico estructurado.
 *
 * A diferencia de analyzeAndFix, no produce JS ejecutable. Devuelve un descriptor
 * (diagnosis_type, suggested_endpoint, suggested_request, notes) que se persiste
 * en portal_scripts.patch_js como JSON. El campo step se prefija con "api:<endpoint>"
 * para distinguirlo de los parches DOM.
 */
async function analyzeApiFailure({ portal, endpoint, request, responseStatus, responseBody, error }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }

  const systemPrompt = `Eres un experto en APIs de portales de facturación electrónica de México (Home Depot, Petro 7, OXXO, Wansoft, Konesh, Facturama). Recibes una llamada HTTP que falló junto con su respuesta y diagnosticas la causa más probable.

Categorías de diagnóstico:
- endpoint_changed: la URL ya no responde / 404 / redirección
- validation_added: el backend ahora exige un campo o formato distinto
- field_renamed: un campo del request cambió de nombre o tipo
- field_removed: el backend ya no acepta un campo que enviábamos
- auth_expired: token o sesión expiró
- transient_error: error temporal (5xx genérico, timeout, rate limit)
- contract_changed: la respuesta cambió de forma y el cliente no la entiende
- unknown: no se puede diagnosticar con la información disponible

Responde SOLO con JSON sin backticks:
{
  "descripcion": "diagnóstico en una línea",
  "diagnosis_type": "una de las categorías de arriba",
  "suggested_endpoint": "URL nueva si aplica, si no null",
  "suggested_request": null,
  "notes": "explicación más larga: qué cambiar en el código del cliente",
  "confidence": 0.0
}

Si la categoría es transient_error o unknown, deja suggested_endpoint y suggested_request en null y confidence bajo (≤ 0.3).`;

  const fmt = (x) => typeof x === 'string'
    ? x.slice(0, 4000)
    : JSON.stringify(x ?? null, null, 2).slice(0, 4000);

  const userMsg = `Portal: ${portal || 'desconocido'}
Endpoint: ${endpoint || '(no proporcionado)'}
Request body:
${fmt(request)}
Response status: ${responseStatus ?? '(sin código)'}
Response body:
${fmt(responseBody)}
Error capturado: ${error}`;

  const resp = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  }, { headers: HEADERS, timeout: 30000 });

  const text = resp.data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Respuesta de Claude sin JSON');
  const fix = JSON.parse(match[0]);

  // Persistir en portal_scripts. patch_js guarda el descriptor JSON (no es JS).
  // step="api:<endpoint>" distingue del modo DOM.
  try {
    const stepLabel = `api:${endpoint || 'unknown'}`;
    const patchPayload = JSON.stringify({
      diagnosis_type:     fix.diagnosis_type     || 'unknown',
      suggested_endpoint: fix.suggested_endpoint || null,
      suggested_request:  fix.suggested_request  || null,
      notes:              fix.notes              || null
    });
    const info = insertScript.run(
      portal || null,
      stepLabel,
      patchPayload,
      fix.descripcion || null,
      typeof fix.confidence === 'number' ? fix.confidence : null
    );
    fix.id = info.lastInsertRowid;
    testRunner.validateAndActivate(info.lastInsertRowid)
      .catch(err => console.warn(`[testRunner] validateAndActivate falló id=${info.lastInsertRowid}:`, err.message));
  } catch (dbErr) {
    console.warn('[claudeAgent] no se pudo persistir el diagnóstico API:', dbErr.message);
  }

  return fix;
}

module.exports = { analyzeAndFix, analyzeApiFailure };
