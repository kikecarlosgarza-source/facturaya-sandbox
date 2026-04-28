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
    const systemPrompt = 'Eres un experto en facturacion electronica Mexico CFDI 4.0. Analiza la imagen del ticket COMPLETA.\n\nINSTRUCCIONES CRITICAS:\n1. ESTABLECIMIENTO: Lee el nombre del negocio en la parte superior del ticket.\n2. TOTAL: Busca el monto final a pagar.\n3. FECHA: Busca la fecha en el ticket.\n4. FOLIO/CODIGO: Busca el numero de ticket, folio, orden o codigo de facturacion.\n5. PORTAL: Si el ticket menciona una URL o instrucciones de facturacion, extrae la URL.\n6. Si no puedes leer algun dato claramente, ponlo vacio.\n\nResponde SOLO con JSON sin backticks:\n{\n  "establecimiento": "nombre real del negocio (ej: Home Depot, McDonaldes, OXXO)",\n  "folio": "numero CORTO de ticket impreso DEBAJO del codigo de barras (NO el numero largo del barcode). En Home Depot busca el formato SSSS NNN NNNNNN NNNN en texto bajo el barcode",\n  "fecha": "fecha del ticket",\n  "total": 0,\n  "codigo_facturacion": "codigo de facturacion o numero de barras largo",\n  "portal_facturacion": "URL del portal (homedepot.com.mx = https://www.homedepot.com.mx/facturacion)",\n  "rfc_emisor": "RFC del emisor si aparece",\n  "sistema_facturacion": "wansoft/otro"\n}';

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

  const _raw = (response.data.content[0] && response.data.content[0].text) || '';
    const _p = parsearRespuestaJSON(response.data.content);
    const m = (_raw + ' ' + (_p.codigo_facturacion || '')).match(/\b26\d{14,17}\b/);
    if (m && (!_p.codigo_facturacion || String(_p.codigo_facturacion).length < 12)) { _p.codigo_facturacion = m[0]; }
    return _p;
}

async function buscarPortal(establecimiento, rfcEmisor = '') {
    const systemPrompt = 'Eres experto en portales de autofacturacion de empresas mexicanas. Conoces exactamente que portales tienen las principales cadenas comerciales de Mexico.\nResponde UNICAMENTE con JSON valido sin backticks:\n{\n  "encontrado": true,\n  "portal_url": "URL exacta del portal de autofacturacion",\n  "nombre_portal": "nombre del sistema",\n  "instrucciones": "pasos breves"\n}';

  const resp = await axios.post(CLAUDE_API, {
        model: MODEL,
        max_tokens: 500,
        messages: [{
                role: 'user',
                content: 'Establecimiento: "' + establecimiento + '"' + (rfcEmisor ? ', RFC: ' + rfcEmisor : '') + '. Dame el portal de autofacturacion vigente con su URL exacta.'
        }]
  }, { headers: HEADERS });

  return parsearRespuestaJSON(resp.data.content);
}

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

function fixCodigoFacturacion(ticketData, rawResponse) {
    const texto = JSON.stringify(ticketData) + ' ' + (rawResponse || '');
    const match = texto.match(/\b26\d{14,17}\b/);
    if (match && (!ticketData.codigo_facturacion || ticketData.codigo_facturacion.length < 12)) {
          ticketData.codigo_facturacion = match[0];
    }
    return ticketData;
}

module.exports = { analizarTicket, buscarPortal };
module.exports.decodificarURL = decodificarURL;
module.exports.fixCodigoFacturacion = fixCodigoFacturacion;
