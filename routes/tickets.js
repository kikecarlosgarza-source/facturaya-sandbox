const express = require('express');
const router = express.Router();
const { v4: uuid } = require('uuid');
const authMiddleware = require('../middleware/auth');
const { analizarTicket } = require('../services/claudeService');
const { db } = require('../db/database');

const PORTALES = {
      'home depot': 'https://www.homedepot.com.mx/facturacion',
      'oxxo': 'https://www.oxxo.com/facturacion',
      'walmart': 'https://facturacion.walmart.com.mx',
      'bodega aurrera': 'https://facturacion.walmart.com.mx',
      'sams': 'https://facturacion.walmart.com.mx',
      'soriana': 'https://www.soriana.com/facturacion',
      'starbucks': 'https://facturacion.starbucks.com.mx',
      'liverpool': 'https://facturacion.liverpool.com.mx',
      'coppel': 'https://facturacion.coppel.com',
      '7-eleven': 'https://www.7-eleven.com.mx/facturacion',
      'seven eleven': 'https://www.7-eleven.com.mx/facturacion',
      'mcdonalds': 'https://facturacion.mcdonalds.com.mx',
};

function detectarPortal(nombre) {
      if (!nombre) return null;
      const n = nombre.toLowerCase();
      for (const [key, url] of Object.entries(PORTALES)) {
              if (n.includes(key)) return url;
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

        const portalLocal = detectarPortal(ticketData.establecimiento);
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

module.exports = router;
