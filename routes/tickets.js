const express       = require('express');
const router        = express.Router();
const authMiddleware = require('../middleware/auth');
const { analizarTicket, buscarPortal, decodificarURL, fixCodigoFacturacion } = require('../services/claudeService');
const { extraerCodigoFacturacion } = require('../services/ocrService');
const { leerQRdeImagen } = require('../services/qrService');
const automation    = require('../services/automationService');

// POST /api/tickets/analizar
// Recibe base64 de la imagen del ticket, retorna datos extraídos + info del portal
router.post('/analizar', authMiddleware, async (req, res) => {
  try {
    const { imagen, mimeType = 'image/jpeg' } = req.body;
    if (!imagen) return res.status(400).json({ error: 'Imagen requerida (base64)' });

    // 1. Analizar ticket con Claude
    let ticketData = await analizarTicket(imagen, mimeType);
    ticketData = fixCodigoFacturacion(ticketData);
    // Si el codigo sigue siendo corto, usar OCR directamente
    if (!ticketData.codigo_facturacion || String(ticketData.codigo_facturacion).length < 12) {
      const codigoOCR = await extraerCodigoFacturacion(imagen);
      if (codigoOCR) {
        ticketData.codigo_facturacion = codigoOCR;
        console.log('[OCR] codigo_facturacion corregido a:', codigoOCR);
      }
    }

    // 2. Detectar portal en base de datos local
    const portalLocal = automation.detectarPortal(ticketData);

    // 3. Si no está en BD local, buscar con IA
    let portalInfo = null;
    if (portalLocal) {
      portalInfo = {
        encontrado: true,
        portal_id: portalLocal.portal.id,
        portal_nombre: portalLocal.portal.name,
        portal_url: portalLocal.url_directa || portalLocal.portal.automation.base_url,
        url_directa: !!portalLocal.url_directa,
        requiere_cuenta: !!portalLocal.portal.automation.requires_account,
        automatizable: !portalLocal.portal.automation.requires_account
      };
    // Intentar leer QR de la imagen para obtener URL exacta
    if (imagen && (ticketData.sistema_facturacion === 'wansoft' || ticketData.portal_url?.includes('wansoft'))) {
      try {
        const qrUrl = await leerQRdeImagen(imagen, mimeType || 'image/jpeg');
        if (qrUrl && qrUrl.startsWith('http')) {
          ticketData.url_facturacion = qrUrl;
          ticketData.codigo_facturacion = qrUrl.split('code=')[1] || ticketData.codigo_facturacion;
          console.log('[QR] URL extraída del QR:', qrUrl);
        }
      } catch(e) { console.error('[QR] Error leyendo QR:', e.message); }
    }

    } else if (ticketData.url_facturacion) {
      const urlFac = decodificarURL(ticketData.url_facturacion);
      portalInfo = {
        encontrado: true,
        portal_url: urlFac,
        url_directa: true,
        automatizable: true,
        portal_nombre: urlFac.includes('wansoft') ? 'Wansoft' : 'Portal directo del ticket',
        sistema: urlFac.includes('autoInvoicing') ? 'wansoft_auto' : 'directo'
      };
    } else {
      // Buscar con IA
      const portalIA = await buscarPortal(ticketData.establecimiento, ticketData.rfc_emisor);
      portalInfo = {
        encontrado: portalIA.encontrado,
        portal_url: portalIA.portal_url,
        portal_nombre: portalIA.portal_nombre,
        requiere_cuenta: portalIA.requiere_cuenta,
        automatizable: portalIA.encontrado && !portalIA.requiere_cuenta,
        instrucciones: portalIA.instrucciones
      };
    }

    res.json({ ticket: ticketData, portal: portalInfo });

  } catch (e) {
    console.error('Error analizando ticket:', e.message);
    res.status(500).json({ error: e.message });
  }
});


router.post('/procesar-webview', authMiddleware, async (req, res) => {
  try {
    const { html, url, titulo, perfil, ticket, intento } = req.body;
    const axios = require('axios');
    const HEADERS = {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };

    const prompt = `Eres un agente experto en portales de facturacion electronica de Mexico. Analiza la pagina actual y ejecuta el siguiente paso para generar una factura CFDI.

DATOS REALES DEL RECEPTOR (USA ESTOS EXACTAMENTE, NO LOS PLACEHOLDERS): RFC=${perfil?.rfc}, Nombre=${perfil?.nombre}, CP=${perfil?.cp}, Email=${perfil?.email}, Regimen=${perfil?.regimen||'612'}, UsoCFDI=${perfil?.uso_cfdi||'G03'}
URL: ${url} | Intento: ${intento}/10

Analiza los campos del formulario y el HTML. Genera JavaScript que llene los campos con los datos del receptor usando los IDs REALES que ves en el HTML. Para dropdowns usa: el.value="612" y luego el.dispatchEvent(new Event("change",{bubbles:true})). Para inputs de texto y email usa .value y dispatchEvent input+change. Para campos de tipo email busca input[type=email] o input[name*=email] o input[id*=mail] o input[placeholder*=correo i]. Luego haz click en el boton siguiente o emitir. Si no encuentras el campo email por ID, usa: var emailField = document.querySelector("input[type=email],input[name*=email],input[id*=mail],input[placeholder*=orreo]"); if(emailField){emailField.value="kikecarlosgarza@gmail.com";emailField.dispatchEvent(new Event("input",{bubbles:true}))}

RESPONDE SOLO JSON. En el PRIMER intento genera UN SOLO JS que haga TODO: llene TODOS los campos visibles, seleccione dropdowns y haga click en el boton de siguiente/emitir/generar. No hagas un campo a la vez.
- Todo de una vez: {"accion":"js","js":"JS_QUE_LLENA_TODO_Y_HACE_CLICK","descripcion":"llenando todo y emitiendo"}
- Exito SOLO si el intento es mayor a 2 Y ves confirmacion clara (folio fiscal UUID, descarga PDF exitosa, mensaje de exito explicito): {"accion":"done","descripcion":"Factura generada"}. NO declares exito en intento 1 ni por ver palabras como factura/generar/PDF en el menu
- Pide cuenta: {"accion":"preguntar","descripcion":"pide crear cuenta","js":"js_crear_cuenta"}
- Error: {"accion":"error","descripcion":"descripcion"}

Campos: ${JSON.stringify(req.body.inputs||[],null,2).slice(0,2000)}
HTML: ${html?.slice(0,8000)}`

    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: HEADERS });

    const texto = resp.data.content[0].text;
    let instruccion;
    try { instruccion = JSON.parse(texto.replace(/```json|```/g, '').trim()); }
    catch(e) { instruccion = { accion: 'error', descripcion: 'No pude analizar la pagina' }; }

    if(instruccion.accion==="done" && intento<=2){instruccion={accion:"js",js:"true",descripcion:"verificando portal"};}
    res.json(instruccion);
  } catch(e) {
    res.status(500).json({ accion: 'error', descripcion: e.message });
  }
});
module.exports = router;
