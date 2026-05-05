const axios = require('axios');
const db    = require('../db/database');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01'
};

const insertScript = db.prepare(`
  INSERT INTO portal_scripts (portal, step, patch_js, descripcion, confidence, active)
  VALUES (?, ?, ?, ?, ?, 1)
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
  } catch (dbErr) {
    console.warn('[claudeAgent] no se pudo persistir el parche:', dbErr.message);
  }

  return fix;
}

module.exports = { analyzeAndFix };
