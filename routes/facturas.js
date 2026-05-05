const express = require('express');
const router = express.Router();
const fs = require('fs');
const authMiddleware = require('../middleware/auth');
const { procesarFactura, enviarCaptcha } = require('../services/automationService');
const db = require('../db/database');

router.post('/solicitar', authMiddleware, async (req, res) => {
  try {
    const { solicitudId } = req.body;
    if (!solicitudId) return res.status(400).json({ error: 'solicitudId requerido' });
    res.json({ ok: true, solicitudId, status: 'procesando' });
    procesarFactura(solicitudId).catch(e => console.error('[FACTURA]', e.message));
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
    const s = db.prepare('SELECT id, status, status_detalle, establecimiento, rfc_emisor, folio, total, portal_url FROM solicitudes WHERE id = ? AND usuario_id = ?')
      .get(req.params.id, req.userId);
    if (!s) return res.status(404).json({ error: 'No encontrada' });
    if (s.status === 'captcha_required' && s.status_detalle) {
      try { s.captcha_imagen = fs.readFileSync(s.status_detalle).toString('base64'); } catch(e) {}
    }
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const METODOS_VALIDOS = ['whatsapp', 'email', 'portal', 'no_se'];

router.post('/metodo-manual', authMiddleware, (req, res) => {
  try {
    const { rfc_emisor, metodo } = req.body || {};
    if (!rfc_emisor || !metodo) return res.status(400).json({ error: 'rfc_emisor y metodo requeridos' });
    if (!METODOS_VALIDOS.includes(metodo)) return res.status(400).json({ error: 'metodo inválido' });
    db.prepare(`
      INSERT INTO metodo_facturacion_manual (rfc_emisor, metodo, actualizado_en)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(rfc_emisor) DO UPDATE SET
        metodo = excluded.metodo,
        actualizado_en = excluded.actualizado_en
    `).run(rfc_emisor, metodo);
    res.json({ ok: true, rfc_emisor, metodo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/metodo-manual/:rfc', authMiddleware, (req, res) => {
  try {
    const r = db.prepare('SELECT rfc_emisor, metodo, actualizado_en FROM metodo_facturacion_manual WHERE rfc_emisor = ?')
      .get(req.params.rfc);
    res.json(r || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/historial', authMiddleware, (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM solicitudes WHERE usuario_id = ? ORDER BY rowid DESC LIMIT 20').all(req.userId);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
