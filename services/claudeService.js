const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
// FIX: modelo actualizado a claude-sonnet-4-5 (release estable actual)
const MODEL = 'claude-sonnet-4-5-20251001';

const HEADERS = {
  'Content-Type': 'application/json',
  'x-api-key': process.env.ANTHROPIC_API_KEY,
  'anthropic-version': '2023-06-01'
};

/**
 * Extrae el texto de la respuesta y lo parsea como JSON.
 * FIX: maneja el caso donde Claude devuelve texto antes/después del JSON.
 */
function parsearRespuestaJSON(content) {
  const text = content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Limpiar backticks de markdown si los incluye
  const limpio = text.replace(/```[\w]*\n?/g, '').trim();

  try {
    return JSON.parse(limpio);
  } catch (e) {
    // FIX: intentar extraer el objeto JSON si hay texto extra alrededor
    const match = limpio.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Respuesta no es JSON válido: ${limpio.substring(0, 200)}`);
  }
}

/**
 * Analiza la imagen de un ticket y extrae todos los datos relevantes
 * para solicitar una factura electrónica en México.
 */
async function analizarTicket(base64Image, mimeType = 'image/jpeg') {
  const systemPrompt = `Eres un experto en facturación electrónica México CFDI 4.0.
Analiza tickets, recibos y comprobantes de compra y extrae los datos necesarios
para solicitar una factura electrónica.

IMPORTANTE:
- Si el ticket incluye una URL de facturación, extráela EXACTAMENTE como aparece
- CRÍTICO: El campo "codigo_facturacion" es el número de ~17 dígitos que aparece en la frase "con tu código de facturación: XXXXXXXXXXXXXXXXX" en la sección FACTURACIÓN EN LÍNEA. Ese número empieza con la fecha en formato AAMMDD (ej: 260422...). NUNCA uses el Movimiento (6 dígitos) ni la Orden (2-3 dígitos) como codigo_facturacion.
- El campo "folio" debe ser el número de Orden o Movimiento del ticket
- Si el ticket dice "Powered by Wansoft", el sistema_facturacion es "wansoft"
- Detecta el sistema de facturación si es posible (Parrot, Wansoft, EdicomGroup, etc.)

Responde ÚNICAMENTE con JSON válido, sin backticks ni texto adicional:
{
  "establecimiento": "nombre del negocio",
  "rfc_emisor": "RFC si aparece en el ticket",
  "folio": "número de folio/orden completo",
  "fecha": "DD/MM/YYYY",
  "hora": "HH:MM",
  "total": 0.00,
  "subtotal": 0.00,
  "iva": 0.00,
  "forma_pago": "efectivo|tarjeta|otro",
  "descripcion": "descripción breve de los productos/servicios",
  "url_facturacion": "URL exacta del portal de facturación si aparece",
  "codigo_facturacion": "código de facturación si aparece",
  "sistema_facturacion": "parrot|edicom|propio|desconocido",
  "requiere_cuenta": false,
  "confianza": 0.95
}`;

  // Pre-procesamiento: extraer texto raw para regex
  const textResponse = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64Image }
      }, {
        type: 'text',
        text: 'Transcribe EXACTAMENTE el texto de la sección "FACTURACIÓN EN LÍNEA" de este ticket, incluyendo la URL y el número de código de facturación. Solo el texto, sin explicaciones.'
      }]
    }]
  });
  const rawText = textResponse.data?.content?.[0]?.text || '';
  
  // Extraer codigo_facturacion con regex
  const codigoMatch = rawText.match(/c[oó]digo de facturaci[oó]n[:\s]+([0-9]{10,20})/i);
  const urlMatch = rawText.match(/https?:\/\/[\w\./\-]+/i);
  const codigoFromText = codigoMatch ? codigoMatch[1] : null;
  const urlFromText = urlMatch ? urlMatch[0] : null;
  console.log('[TICKET] Codigo extraido por regex:', codigoFromText);
  console.log('[TICKET] URL extraida por regex:', urlFromText);

  const response = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 1000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64Image }
        },
        {
          type: 'text',
          text: 'Extrae todos los datos de este ticket para solicitar factura electrónica en México. Si ves una URL de facturación o código QR, extráelos exactamente.'
        }
      ]
    }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(response.data.content);
}

/**
 * Busca el portal de autofacturación de un establecimiento
 * cuando no viene en el ticket.
 */
async function buscarPortal(establecimiento, rfcEmisor = '') {
  const systemPrompt = `Eres experto en portales de autofacturación de empresas mexicanas.
Conoces exactamente qué portales tienen las principales cadenas comerciales de México.
Responde ÚNICAMENTE con JSON válido sin backticks:
{
  "encontrado": true,
  "portal_url": "URL exacta y vigente del portal",
  "portal_nombre": "nombre oficial del portal",
  "sistema": "parrot|edicom|propio|otro",
  "requiere_cuenta": false,
  "requiere_folio": true,
  "instrucciones": "pasos específicos en 2-3 líneas",
  "campos_necesarios": ["folio", "total", "fecha", "rfc", "email"]
}`;

  // Pre-procesamiento: extraer texto raw para regex
  const textResponse = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [{
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64Image }
      }, {
        type: 'text',
        text: 'Transcribe EXACTAMENTE el texto de la sección "FACTURACIÓN EN LÍNEA" de este ticket, incluyendo la URL y el número de código de facturación. Solo el texto, sin explicaciones.'
      }]
    }]
  });
  const rawText = textResponse.data?.content?.[0]?.text || '';
  
  // Extraer codigo_facturacion con regex
  const codigoMatch = rawText.match(/c[oó]digo de facturaci[oó]n[:\s]+([0-9]{10,20})/i);
  const urlMatch = rawText.match(/https?:\/\/[\w\./\-]+/i);
  const codigoFromText = codigoMatch ? codigoMatch[1] : null;
  const urlFromText = urlMatch ? urlMatch[0] : null;
  console.log('[TICKET] Codigo extraido por regex:', codigoFromText);
  console.log('[TICKET] URL extraida por regex:', urlFromText);

  const response = await axios.post(CLAUDE_API, {
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Establecimiento: "${establecimiento}"${rfcEmisor ? `, RFC: ${rfcEmisor}` : ''}. Dame el portal de autofacturación vigente con su URL exacta.`
    }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(response.data.content);
}

module.exports = { analizarTicket, buscarPortal };

// Decodifica URLs con múltiples capas de encoding (como las que vienen de QR de Wansoft)
function decodificarURL(url) {
  if (!url) return url;
  try {
    let decoded = url;
    let prev = '';
    while (decoded !== prev) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
    return decoded;
  } catch {
    return url;
  }
}

module.exports.decodificarURL = decodificarURL;
