const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const authMiddleware = require('../middleware/auth');
const db = require('../db/database');
const { v4: uuid } = require('uuid');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };

router.post('/analizar', authMiddleware, async (req, res) => {
  try {
    const { imagen, mimeType = 'image/jpeg' } = req.body;
    if (!imagen) return res.status(400).json({ error: 'Imagen requerida' });
    const esPDF = mimeType === 'application/pdf';
    const block = esPDF
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: imagen } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data: imagen } };
    const r = await axios.post(CLAUDE_API, {
      model: 'claude-sonnet-4-5', max_tokens: 500,
      system: 'Eres experto en documentos SAT Mexico. Extrae datos de la constancia fiscal. Responde SOLO JSON sin backticks: {"rfc":"","nombre":"EN MAYUSCULAS","cp":"5 digitos","regimen":"612","regimen_nombre":"","curp":"","estatus":"ACTIVO","confianza":0.98}',
      messages: [{ role: 'user', content: [block, { type: 'text', text: 'Extrae datos fiscales de esta constancia SAT.' }] }]
    }, { headers: HEADERS });
    const txt = r.data.content.filter(b => b.type === 'text').map(b => b.text).join('').replace(/```[\w]*\n?/g, '').trim();
    let datos;
    try { datos = JSON.parse(txt); } catch { const m = txt.match(/\{[\s\S]*\}/); if (!m) throw new Error('JSON invalido'); datos = JSON.parse(m[0]); }
    if (!datos.rfc || datos.rfc.length < 12) return res.status(422).json({ error: 'No se pudo leer el RFC.' });
    const existe = db.prepare('SELECT id FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
    if (existe) {
      db.prepare('UPDATE perfiles_fiscales SET rfc=?, nombre=?, nombre_sat=?, cp=?, regimen=?, uso_cfdi=? WHERE usuario_id=?')
        .run(datos.rfc, datos.nombre, datos.nombre, datos.cp, datos.regimen || '612', 'G03', req.userId);
    } else {
      const email = db.prepare('SELECT email FROM usuarios WHERE id = ?').get(req.userId)?.email || '';
      db.prepare('INSERT INTO perfiles_fiscales (id,usuario_id,rfc,nombre,nombre_sat,cp,regimen,uso_cfdi,email) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(uuid(), req.userId, datos.rfc, datos.nombre, datos.nombre, datos.cp, datos.regimen || '612', 'G03', email);
    }
    res.json({ datos, guardado: !existe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
