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
  const limpio = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
  // Intentar parsear directo
  try { return JSON.parse(limpio); } catch(e) {}
  // Buscar primer { hasta ultimo }
  const start = limpio.indexOf('{');
  const end = limpio.lastIndexOf('}');
  if(start >= 0 && end > start) {
    try { return JSON.parse(limpio.substring(start, end+1)); } catch(e) {}
    // Intentar desde el final progresivamente
    for(let i = end; i > start; i--) {
      try { return JSON.parse(limpio.substring(start, i+1)); } catch(e) {}
    }
  }
  throw new Error('Respuesta no es JSON valido: ' + limpio.substring(0, 200));
}

async function analizarTicket(base64Image, mimeType = 'image/jpeg') {
  const systemPrompt = `Eres un experto en facturacion electronica Mexico CFDI 4.0. Analiza la imagen del ticket.

INSTRUCCIONES:
1. ESTABLECIMIENTO: nombre del negocio.
2. TOTAL: monto final a pagar.
3. FECHA: fecha de la compra (formato DD/MM/YYYY o como aparezca).
4. FOLIO: El numero que se usa para solicitar la factura en el portal.
   - Para Home Depot: es el numero impreso DEBAJO del logo y SOBRE el codigo de barras.
     Tiene EXACTAMENTE 22 digitos impresos en el ticket (la API agrega un 0 al inicio internamente
     para llegar a 23). Aparece en grupos separados por espacios, formato tipico 8+8+6.
     Ejemplo: "08652006 06332050 126601" -> devolver "0865200606332050126601" (22 digitos sin espacios).
     CRITICO: cuenta los digitos antes de responder. Deben ser 22 exactos. Lee desde el PRIMER digito
     hasta el ULTIMO sin truncar.
   - Para otros comercios: el numero de folio o ticket que pide el portal.
   Devuelve el folio EXACTAMENTE como aparece impreso en el ticket, conservando guiones si los tiene.
   Ejemplos: 78-1707 -> 78-1707, 0865200606332050126601 -> 0865200606332050126601 (22 digitos).
5. PORTAL: URL del portal de facturacion si aparece en el ticket.
6. NO_ESTACION: Para gasolineras (Petro 7, Petromax, OXXO Gas), el numero de estacion o sucursal.
7. WEB_ID: Para Petro 7/Petromax, el Web ID del ticket (numero corto, generalmente 4-6 digitos).
8. SISTEMA_FACTURACION: identifica el backend usado para emitir CFDI. Pistas:
   pie de página o "Powered by" en el ticket, dominio del portal, marca del proveedor.
   - "facturama_shopify": tiendas online en Shopify que usan Facturama. Indicios:
     URL del portal contiene "*.myshopify.com", o pertenece a una tienda online
     (ej: bandeja.mx, moft.mx). El portal suele ser "shopname.com/pages/facturacion"
     o redirige a app.facturama.mx.
   - "facturama_hd": Home Depot México únicamente (facturacion.homedepot.com.mx).
   - "konesh": K Portal Externo de Konesh. Lo usan Petro 7 y Petromax. Indicios:
     URL contiene "tarjetapetro-7.com.mx", "petro7.mx", "/KPortalExterno/" o
     "/KJServices/", o el footer dice "Powered by Konesh".
   - "wansoft": software Wansoft. Cada cliente despliega su propio subdominio
     (ej: factura.{empresa}.com.mx, autofactura.{empresa}.com.mx). Indicios:
     footer/copyright menciona "Wansoft" o "wansoft.mx", URL contiene "wansoft",
     o el portal pide RFC + ticket + un campo "Pin/Clave/Folio Web" típico.
   - "oxxo_gas": OXXO Gas (facturacion.oxxogas.com). Requiere cuenta con login.
   - "otro": cualquier otro sistema o si no estás seguro.
9. SHOP_NAME: SOLO si sistema_facturacion = "facturama_shopify". Es el handle de
   Shopify (parte antes de ".myshopify.com"). Si el dominio en el ticket es
   "bandeja.mx" responde "bandeja-mx". Si es "moft.mx" responde "moft". Si es
   "tienda.com" responde "tienda". Si no estás seguro responde null.
10. NUMERO_TIENDA: Para cadenas que identifican sucursal por número
    (Alsea: VIPS, Starbucks, Domino's, Chili's, P.F. Chang's, etc.;
    HEB; otros con campo "Sucursal"/"Tienda"/"Store"). Pueden ser 3-5
    dígitos. Devuelve solo los dígitos. Si no aparece o no aplica, null.
11. NUMERO_TICKET: Número de 9 dígitos del ticket cuando aparece como
    "No. Ticket", "Ticket #" o similar. Es complementario al folio: en
    algunos portales (como Alsea) se usa específicamente el número de
    9 dígitos. Devuelve solo dígitos. Si no aparece, null.

Responde SOLO JSON sin backticks:
{
  "establecimiento": "nombre del negocio",
  "folio": "numero SIN espacios ni guiones, solo digitos",
  "fecha": "fecha del ticket",
  "total": 0,
  "portal_facturacion": "URL del portal o null",
  "rfc_emisor": "RFC del emisor si aparece",
  "no_estacion": "numero de estacion para gasolineras o null",
  "web_id": "Web ID para Petro 7 o null",
  "sistema_facturacion": "facturama_shopify/facturama_hd/konesh/wansoft/oxxo_gas/otro",
  "shop_name": "handle de Shopify si aplica, null si no",
  "numero_tienda": "5 digitos de sucursal o null",
  "numero_ticket": "9 digitos del ticket o null"
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
          text: 'Extrae todos los datos de este ticket para solicitar factura electronica en Mexico. Lee el folio con cuidado: incluye TODOS los digitos sin omitir ninguno. Si es Home Depot el folio debe tener 22 digitos exactos — cuentalos antes de responder.'
        }
      ]
    }]
  }, { headers: HEADERS });

  const datos = parsearRespuestaJSON(response.data.content);
  // Limpiar folio: quitar todo excepto digitos
  if (datos.folio) datos.folio = datos.folio.replace(/[^0-9\-]/g, '').replace(/^-+|-+$/g, '');

  // Fallback de detección Facturama-Shopify si Claude no lo detectó
  if (datos.sistema_facturacion !== 'facturama_shopify') {
    const det = detectarFacturamaShopify(datos.portal_facturacion, datos.establecimiento);
    if (det) {
      datos.sistema_facturacion = 'facturama_shopify';
      datos.shop_name = det;
    }
  } else if (!datos.shop_name) {
    datos.shop_name = detectarFacturamaShopify(datos.portal_facturacion, datos.establecimiento);
  }
  // Normalizar shop_name (lowercase, conservar guiones, sin espacios)
  if (datos.shop_name) {
    datos.shop_name = String(datos.shop_name).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    if (!datos.shop_name) datos.shop_name = null;
  }

  return datos;
}

// Tiendas online conocidas (handle Shopify ↔ patrones del establecimiento/dominio)
const FACTURAMA_SHOPIFY_KNOWN = {
  'bandeja-mx': ['bandeja.mx', 'bandeja'],
  'moft': ['moft.mx', 'moft.com', 'moft '],
};

function detectarFacturamaShopify(portalUrl, establecimiento) {
  // 1. URL con *.myshopify.com
  if (portalUrl) {
    const m = String(portalUrl).match(/([a-z0-9-]+)\.myshopify\.com/i);
    if (m) return m[1].toLowerCase();
  }
  // 2. Tiendas conocidas por nombre del establecimiento o URL del portal
  const haystack = ((portalUrl || '') + ' ' + (establecimiento || '')).toLowerCase();
  for (const [slug, patterns] of Object.entries(FACTURAMA_SHOPIFY_KNOWN)) {
    if (patterns.some(p => haystack.includes(p))) return slug;
  }
  return null;
}

module.exports = { analizarTicket };
