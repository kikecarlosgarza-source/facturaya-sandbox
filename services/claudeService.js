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
        const systemPrompt = `Eres un experto en facturacion electronica Mexico CFDI 4.0. Analiza la imagen del ticket.

        INSTRUCCIONES:
        1. ESTABLECIMIENTO: nombre del negocio.
        2. TOTAL: monto final a pagar.
        3. FECHA: fecha de la compra (formato DD/MM/YYYY o como aparezca).
            4. FOLIO: El numero que se usa para solicitar la factura en el portal. Para Home Depot es el numero largo impreso SOBRE el codigo de barras (15-25 digitos, ejemplo: 08652005008590402226295). IMPORTANTE: devuelvelo SIN espacios, como un solo numero continuo sin separaciones.
        5. PORTAL: URL del portal de facturacion si aparece en el ticket.
        6. NO_ESTACION: Para gasolineras (Petro 7, Petromax, OXXO Gas), el numero de estacion o sucursal que aparece en el ticket.
        7. WEB_ID: Para Petro 7/Petromax, el Web ID que aparece en el ticket (numero corto, generalmente 4-6 digitos).

        Responde SOLO JSON sin backticks:
        {
          "establecimiento": "nombre del negocio",
            "folio": "numero del folio/codigo para facturacion",
              "fecha": "fecha del ticket",
                "total": 0,
                  "portal_facturacion": "URL del portal o null",
                    "rfc_emisor": "RFC del emisor si aparece",
                      "no_estacion": "numero de estacion para gasolineras o null",
                        "web_id": "Web ID para Petro 7 o null",
                          "sistema_facturacion": "wansoft/otro"
                          }`;

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
                                              text: 'Extrae todos los datos de este ticket para solicitar factura electronica en Mexico.'
                              }
                                    ]
            }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(response.data.content);
}

module.exports = { analizarTicket };
