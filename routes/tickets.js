const express       = require('express');
const router        = express.Router();
const authMiddleware = require('../middleware/auth');
const { analizarTicket, buscarPortal } = require('../services/claudeService');
const automation    = require('../services/automationService');

// POST /api/tickets/analizar
// Recibe base64 de la imagen del ticket, retorna datos extraídos + info del portal
router.post('/analizar', authMiddleware, async (req, res) => {
  try {
    const { imagen, mimeType = 'image/jpeg' } = req.body;
    if (!imagen) return res.status(400).json({ error: 'Imagen requerida (base64)' });

    // 1. Analizar ticket con Claude
    const ticketData = await analizarTicket(imagen, mimeType);

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
    } else if (ticketData.url_facturacion) {
      portalInfo = {
        encontrado: true,
        portal_url: ticketData.url_facturacion,
        url_directa: true,
        automatizable: true,
        portal_nombre: 'Portal directo del ticket'
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

module.exports = router;
