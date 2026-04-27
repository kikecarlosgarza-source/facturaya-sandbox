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

    const prompt = `Eres un agente que factura tickets en Mexico. Analiza los campos de este portal de facturacion.
Datos del receptor: RFC=${perfil?.rfc}, Nombre=${perfil?.nombre}, CP=${perfil?.cp}, Email=${perfil?.email}, Regimen=${perfil?.regimen||'612'}, UsoCFDI=${perfil?.uso_cfdi||'G03'}
URL actual: ${url}
Titulo: ${titulo}
Intento: ${intento}

Analiza el HTML y responde SOLO con JSON:
- Si hay formulario para llenar: {"accion":"js","js":"(function(){function sv(id,v){var e=document.getElementById(id);if(e){e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}}sv('rfc','GAME860412CY6');sv('legalName','ENRIQUE CARLOS GARZA MONTEMAYOR');sv('email','kikecarlosgarza@gmail.com');sv('CP','66230');})()","descripcion":"llenando RFC"}
- Si pide crear cuenta: {"accion":"preguntar","descripcion":"El portal pide crear una cuenta para facturar. ¿La creo?","js":"...js para crear cuenta..."}  
- Si la factura ya se generó exitosamente: {"accion":"done","descripcion":"Factura generada"}
- Si hay error: {"accion":"error","descripcion":"descripcion del error"}

Campos del formulario:
${JSON.stringify(req.body.inputs || [], null, 2).slice(0,2000)}

HTML del portal (sin scripts):
${html?.slice(0,10000)}`;

    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    }, { headers: HEADERS });

    const texto = resp.data.content[0].text;
    let instruccion;
    try { instruccion = JSON.parse(texto.replace(/```json|```/g, '').trim()); }
    catch(e) { instruccion = { accion: 'error', descripcion: 'No pude analizar la pagina' }; }

    res.json(instruccion);
  } catch(e) {
    res.status(500).json({ accion: 'error', descripcion: e.message });
  }
});
module.exports = router;
