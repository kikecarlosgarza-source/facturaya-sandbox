const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';
const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01'
};

const MAPPED_DIR = path.join(__dirname, 'mapped');

async function mapPortal(inspectionResult) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }
  if (inspectionResult.status !== 'ok') {
    return { id: inspectionResult.id, status: 'skipped', razon: `inspector status=${inspectionResult.status}` };
  }

  // Inspector ya detectó si necesita handler dedicado; sobreescribimos type aunque Claude diga lo contrario.
  const requiereHandler = inspectionResult.captcha !== 'none' || inspectionResult.tecnologia === 'spa';

  const systemPrompt = `Eres un experto en automatización de portales de facturación electrónica de México con Playwright. Recibes el HTML limpio de un portal y la lista de campos visibles, y generas un objeto de configuración compatible con portals.json del proyecto facturasat.

Acciones soportadas en flow[]:
- {"action":"navigate","target":"ticket_url" | "<url>"}
- {"action":"fill","selector":"<css>","value":"<plantilla>"}
- {"action":"select","selector":"<css>","value":"<valor>"}
- {"action":"click","selector":"<css>"}
- {"action":"wait","ms":<ms>}
- {"action":"wait_selector","selector":"<css>"}
- {"action":"wait_success"}

Plantillas válidas en value: {{rfc}}, {{email}}, {{nombre}}, {{cp}}, {{regimen}}, {{uso_cfdi}}, {{folio}}, {{total}}, {{fecha}}, {{tienda}}, {{codigo}}.

Responde SOLO con JSON sin backticks. Estructura exacta:
{
  "id": "<id del portal>",
  "name": "<nombre legible>",
  "url_pattern": "<dominio.com/path>",
  "detection": {
    "ticket_keywords": ["palabra1", "palabra2"],
    "rfc_keywords": [],
    "url_in_ticket": false
  },
  "automation": {
    "type": "direct_url" | "requires_handler",
    "base_url": "<URL del portal>",
    "flow": [...]
  },
  "notas_arquitecto": "una línea con confianza/limitaciones"
}

Reglas:
- Captcha presente o tecnología SPA → type:"requires_handler", flow:[].
- HTML simple sin captcha → flow[] con orden lógico: folio/ticket → RFC → email → nombre/razón social → CP → régimen → uso CFDI → submit → wait_success.
- url_pattern: dominio + path principal (ej. "petro7.mx/facturacion").
- Selectores CSS específicos (id > name > attribute), evita selectores genéricos tipo "input[type=text]".`;

  const userMsg = `Portal: ${inspectionResult.id}
URL encontrada: ${inspectionResult.url_encontrada}
Título: ${inspectionResult.titulo || '(sin título)'}
Tecnología: ${inspectionResult.tecnologia}
Captcha: ${inspectionResult.captcha}

Campos visibles (${inspectionResult.campos.length}):
${JSON.stringify(inspectionResult.campos, null, 2)}

HTML limpio:
${inspectionResult.html_limpio}`;

  const resp = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 2000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMsg }]
  }, { headers: HEADERS, timeout: 60000 });

  const text = resp.data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .replace(/```[\w]*\n?/g, '')
    .trim();

  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Respuesta de Claude sin JSON: ' + text.slice(0, 200));
  const portalConfig = JSON.parse(m[0]);

  // Override por seguridad: si Inspector detectó algo dinámico, fuerza requires_handler
  if (requiereHandler && portalConfig.automation) {
    portalConfig.automation.type = 'requires_handler';
    portalConfig.automation.flow = portalConfig.automation.flow || [];
  }

  // Persistir
  try { fs.mkdirSync(MAPPED_DIR, { recursive: true }); } catch (e) {}
  const outPath = path.join(MAPPED_DIR, `${inspectionResult.id}.json`);
  fs.writeFileSync(outPath, JSON.stringify(portalConfig, null, 2));

  return { id: inspectionResult.id, status: 'ok', file: outPath, config: portalConfig };
}

module.exports = { mapPortal };
