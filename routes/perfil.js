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

// POST /api/perfil (crear o actualizar - acepta actualizacion parcial)
router.post('/', authMiddleware, (req, res) => {
  const { rfc, nombre, cp, regimen, uso_cfdi, email, password_portales } = req.body;

  const existe = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);

  // Si es actualizacion parcial (solo password_portales), no requerir campos fiscales
  const soloPortales = password_portales !== undefined && !rfc && !nombre && !cp && !email;

  if (!soloPortales && (!rfc || !nombre || !cp || !email)) {
    return res.status(400).json({ error: 'RFC, nombre, CP y email son requeridos' });
  }

  if (existe) {
    if (soloPortales) {
      // Solo actualizar credenciales de portales
      db.prepare('UPDATE perfiles_fiscales SET password_portales=? WHERE usuario_id=?')
        .run(password_portales, req.userId);
    } else {
      db.prepare(`
        UPDATE perfiles_fiscales
        SET rfc=?, nombre=?, cp=?, regimen=?, uso_cfdi=?, email=?,
            password_portales=COALESCE(?, password_portales)
        WHERE usuario_id=?
      `).run(
        rfc.toUpperCase(), nombre.toUpperCase(), cp,
        regimen || '612', uso_cfdi || 'G03', email,
        password_portales ?? null,
        req.userId
      );
    }
  } else {
    if (soloPortales) {
      return res.status(400).json({ error: 'Primero configura tu perfil fiscal' });
    }
    db.prepare(`
      INSERT INTO perfiles_fiscales
        (id, usuario_id, rfc, nombre, cp, regimen, uso_cfdi, email, password_portales)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuid(), req.userId,
      rfc.toUpperCase(), nombre.toUpperCase(), cp,
      regimen || '612', uso_cfdi || 'G03', email,
      password_portales ?? null
    );
  }

  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
  res.json(perfil);
});

module.exports = router;
