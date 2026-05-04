const express = require('express');
const router = express.Router();
const fs = require('fs');
const authMiddleware = require('../middleware/auth');
const { procesarFactura, enviarCaptcha } = require('../services/automationService');
const { procesarConAgente } = require('../services/agentService');
const db = require('../db/database');

// Portales que tienen automation hardcodeada
const PORTALES_HARDCODED = ['home depot', 'petro', 'bandeja', 'oxxo gas'];

function usarAgente(establecimiento) {
  const n = (establecimiento || '').toLowerCase();
  return !PORTALES_HARDCODED.some(p => n.includes(p));
}

router.post('/solicitar', authMiddleware, async (req, res) => {
  try {
    const { solicitudId } = req.body;
    if (!solicitudId) return res.status(400).json({ error: 'solicitudId requerido' });
    
    const solicitud = db.prepare('SELECT establecimiento FROM solicitudes WHERE id = ?').get(solicitudId);
    res.json({ ok: true, solicitudId, status: 'procesando' });

    // Usar agente visual para portales nuevos/desconocidos, automation hardcodeada para los conocidos
    if (solicitud && usarAgente(solicitud.establecimiento)) {
      console.log('[FACTURA] Usando agente visual para:', solicitud.establecimiento);
      procesarConAgente(solicitudId).catch(e => console.error('[AGENTE]', e.message));
    } else {
      console.log('[FACTURA] Usando automation hardcodeada para:', solicitud?.establecimiento);
      procesarFactura(solicitudId).catch(e => console.error('[FACTURA]', e.message));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/captcha', authMiddleware, async (req, res) => {
  try {
    const { solicitudId, captcha } = req.body;
    if (!solicitudId || !captcha) return res.status(400).json({ error: 'Faltan datos' });
    res.json({ ok: true, status: 'procesando' });
    enviarCaptcha(solicitudId, captcha).catch(e => console.error('[CAPTCHA]', e.message));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/status/:id', authMiddleware, (req, res) => {
  try {
    const s = db.prepare('SELECT id, status, status_detalle, establecimiento, folio, total, portal_url FROM solicitudes WHERE id = ? AND usuario_id = ?')
      .get(req.params.id, req.userId);
    if (!s) return res.status(404).json({ error: 'No encontrada' });
    if (s.status === 'captcha_required' && s.status_detalle) {
      try { s.captcha_imagen = fs.readFileSync(s.status_detalle).toString('base64'); } catch(e) {}
    }
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/historial', authMiddleware, (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM solicitudes WHERE usuario_id = ? ORDER BY rowid DESC LIMIT 20').all(req.userId);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
