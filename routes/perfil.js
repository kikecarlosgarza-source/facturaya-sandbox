const express        = require('express');
const router         = express.Router();
const { v4: uuid }   = require('uuid');
const authMiddleware = require('../middleware/auth');
const db             = require('../db/database');

// GET /api/perfil
router.get('/', authMiddleware, (req, res) => {
  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
  res.json(perfil || null);
});

// POST /api/perfil  (crear o actualizar)
router.post('/', authMiddleware, (req, res) => {
  const { rfc, nombre, cp, regimen, uso_cfdi, email } = req.body;
  if (!rfc || !nombre || !cp || !email) {
    return res.status(400).json({ error: 'RFC, nombre, CP y email son requeridos' });
  }

  const existe = db.prepare('SELECT id FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);

  if (existe) {
    db.prepare(`
      UPDATE perfiles_fiscales
      SET rfc=?, nombre=?, cp=?, regimen=?, uso_cfdi=?, email=?
      WHERE usuario_id=?
    `).run(rfc.toUpperCase(), nombre.toUpperCase(), cp, regimen || '612', uso_cfdi || 'G03', email, req.userId);
  } else {
    db.prepare(`
      INSERT INTO perfiles_fiscales (id, usuario_id, rfc, nombre, cp, regimen, uso_cfdi, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), req.userId, rfc.toUpperCase(), nombre.toUpperCase(), cp, regimen || '612', uso_cfdi || 'G03', email);
  }

  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
  res.json(perfil);
});

module.exports = router;
