const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db       = require('../db/database');

const JWT_SECRET = process.env.JWT_SECRET || 'facturasat_secret_2024';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, nombre } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });

    const existe = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
    if (existe) return res.status(409).json({ error: 'Email ya registrado' });

    const hash = await bcrypt.hash(password, 10);
    const id = uuid();
    db.prepare('INSERT INTO usuarios (id, email, password, nombre) VALUES (?, ?, ?, ?)')
      .run(id, email.toLowerCase(), hash, nombre || '');

    const token = jwt.sign({ userId: id, email }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, userId: id, email });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email?.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, userId: user.id, email: user.email, nombre: user.nombre });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
