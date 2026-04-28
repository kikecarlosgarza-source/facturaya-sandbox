const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { procesarFactura } = require('../services/automationService');
const db = require('../db/database');

// POST /api/facturas/solicitar — lanza la automatizacion en background
router.post('/solicitar', authMiddleware, async (req, res) => {
    try {
          const { solicitudId } = req.body;
          if (!solicitudId) return res.status(400).json({ error: 'solicitudId requerido' });

      // Responder inmediatamente — el proceso corre en background
      res.json({ ok: true, solicitudId, status: 'procesando' });

      // Lanzar automatizacion sin await para no bloquear
      procesarFactura(solicitudId).catch(e => {
              console.error('[FACTURA] Error background:', e.message);
      });

    } catch (e) {
          res.status(500).json({ error: e.message });
    }
});

// GET /api/facturas/status/:id — consulta el status de una solicitud
router.get('/status/:id', authMiddleware, (req, res) => {
    try {
          const solicitud = db.prepare('SELECT id, status, status_detalle, establecimiento, folio, total, portal_url FROM solicitudes WHERE id = ? AND usuario_id = ?')
            .get(req.params.id, req.userId);
          if (!solicitud) return res.status(404).json({ error: 'No encontrada' });
          res.json(solicitud);
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
});

// GET /api/facturas/historial
router.get('/historial', authMiddleware, (req, res) => {
    try {
          const solicitudes = db.prepare('SELECT * FROM solicitudes WHERE usuario_id = ? ORDER BY rowid DESC LIMIT 20')
            .all(req.userId);
          res.json(solicitudes);
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
});

module.exports = router;
