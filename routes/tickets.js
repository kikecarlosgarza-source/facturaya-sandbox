const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { analizarTicket } = require('../services/claudeService');
const { extraerCodigoFacturacion } = require('../services/ocrService');
const { leerQRdeImagen } = require('../services/qrService');
const { db, uuid } = require('../db/database');

const PORTALES_CONOCIDOS = {
    'home depot': 'https://www.homedepot.com.mx/facturacion',
    'homedepot': 'https://www.homedepot.com.mx/facturacion',
    'oxxo': 'https://www.oxxo.com/facturacion',
    'walmart': 'https://facturacion.walmart.com.mx',
    'bodega aurrera': 'https://facturacion.walmart.com.mx',
    'sams': 'https://facturacion.walmart.com.mx',
    'soriana': 'https://www.soriana.com/facturacion',
    'starbucks': 'https://facturacion.starbucks.com.mx',
    'liverpool': 'https://facturacion.liverpool.com.mx',
    'coppel': 'https://facturacion.coppel.com',
    'seven eleven': 'https://www.7-eleven.com.mx/facturacion',
    '7-eleven': 'https://www.7-eleven.com.mx/facturacion',
    'mcdonalds': 'https://facturacion.mcdonalds.com.mx',
    'burger king': 'https://facturacion.burgerking.com.mx',
};

function detectarPortalLocal(establecimiento) {
    if (!establecimiento) return null;
    const nombre = establecimiento.toLowerCase();
    for (const [key, url] of Object.entries(PORTALES_CONOCIDOS)) {
          if (nombre.includes(key)) return url;
    }
    return null;
}

router.post('/analizar', authMiddleware, async (req, res) => {
    try {
          const { imagen, mimeType = 'image/jpeg' } = req.body;
          if (!imagen) return res.status(400).json({ error: 'Imagen requerida' });

      console.log('[IMG] tamanio base64:', imagen.length, 'mimeType:', mimeType);

      const ticketData = await analizarTicket(imagen, mimeType);
          console.log('[TICKET] datos extraidos:', JSON.stringify(ticketData));

      const portalLocal = detectarPortalLocal(ticketData.establecimiento);
          if (portalLocal && !ticketData.portal_facturacion) {
                  ticketData.portal_facturacion = portalLocal;
          }

      const solicitudId = uuid();
          db.prepare(`
                INSERT INTO solicitudes (id, usuario_id, establecimiento, folio, total, portal_url, status)
                      VALUES (?, ?, ?, ?, ?, ?, 'analizado')
                          `).run(
                  solicitudId,
                  req.userId,
                  ticketData.establecimiento || '',
                  ticketData.folio || ticketData.codigo_facturacion || '',
                  ticketData.total || 0,
                  ticketData.portal_facturacion || ''
                );

      res.json({ ...ticketData, solicitudId });
    } catch (e) {
          console.error('[ERROR] analizando ticket:', e.message);
          res.status(500).json({ error: 'Error analizando ticket: ' + e.message });
    }
});

router.post('/portal', authMiddleware, async (req, res) => {
    try {
          const { establecimiento, rfcEmisor } = req.body;
          const portalLocal = detectarPortalLocal(establecimiento);
          if (portalLocal) {
                  return res.json({ encontrado: true, portal_url: portalLocal });
          }
          res.json({ encontrado: false, portal_url: null });
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
});

module.exports = router;
