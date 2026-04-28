const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

const HEADERS = {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
};

function parsearRespuestaJSON(content) {
      const text = content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');
      const limpio = text.replace(/```[\w]*\n?/g, '').trim();
      try {
              return JSON.parse(limpio);
      } catch (e) {
              const match = limpio.match(/\{[\s\S]*\}/);
              if (match) return JSON.parse(match[0]);
              throw new Error('Respuesta no es JSON valido: ' + limpio.substring(0, 200));
      }
}

async function analizarTicket(base64Image, mimeType = 'image/jpeg') {
      const systemPrompt = 'Eres un experto en facturacion electronica Mexico CFDI 4.0. Analiza la imagen del ticket.\n\nINSTRUCCIONES:\n1. ESTABLECIMIENTO: nombre del negocio.\n2. TOTAL: monto final.\n3. FECHA: fecha de la compra.\n4. FOLIO: El numero que se usa para solicitar la factura en el portal. Para Home Depot y la mayoria de tiendas, este es el numero largo impreso SOBRE o DEBAJO del codigo de barras (el numero de 15-25 digitos, como 08652005008590402226295). NO el texto de fecha ni sucursal que aparece debajo.\n5. PORTAL: URL del portal de facturacion si aparece en el ticket.\n\nResponde SOLO JSON sin backticks:\n{\n  "establecimiento": "nombre del negocio",\n  "folio": "numero largo del codigo de barras para facturacion (15-25 digitos)",\n  "fecha": "fecha del ticket",\n  "total": 0,\n  "portal_facturacion": "URL del portal o null",\n  "rfc_emisor": "RFC del emisor si aparece",\n  "sistema_facturacion": "wansoft/otro"\n}';

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
                                      text: 'Extrae los datos de este ticket para solicitar factura electronica en Mexico.'
                        }
                              ]
          }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(response.data.content);
}

async function buscarPortal(establecimiento, rfcEmisor = '') {
      const systemPrompt = 'Eres experto en portales de autofacturacion de empresas mexicanas.\nResponde SOLO JSON sin backticks:\n{\n  "encontrado": true,\n  "portal_url": "URL exacta",\n  "nombre_portal": "nombre"\n}';

  const resp = await axios.post(CLAUDE_API, {
          model: MODEL,
          max_tokens: 300,
          messages: [{
                    role: 'user',
                    content: 'Portal de autofacturacion de: "' + establecimiento + '"' + (rfcEmisor ? ' RFC: ' + rfcEmisor : '')
          }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(resp.data.content);
}

module.exports = { analizarTicket, buscarPortal };
