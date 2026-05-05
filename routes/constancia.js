const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const authMiddleware = require('../middleware/auth');
const db = require('../db/database');
const { v4: uuid } = require('uuid');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const HEADERS = { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };

const DB_DIR = process.env.DB_DIR || '/tmp';
const CONSTANCIAS_DIR = path.join(DB_DIR, 'constancias');
try { fs.mkdirSync(CONSTANCIAS_DIR, { recursive: true }); } catch {}

function guardarConstancia(userId, base64, mimeType) {
  const ext = mimeType === 'application/pdf' ? 'pdf'
            : mimeType === 'image/png' ? 'png'
            : 'jpg';
  const target = path.join(CONSTANCIAS_DIR, `${userId}.${ext}`);
  for (const e of ['pdf', 'jpg', 'png']) {
    if (e === ext) continue;
    try { fs.unlinkSync(path.join(CONSTANCIAS_DIR, `${userId}.${e}`)); } catch {}
  }
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return target;
}

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

    let constanciaPath = null;
    try {
      constanciaPath = guardarConstancia(req.userId, imagen, mimeType);
    } catch (e) {
      console.warn('[constancia] no se pudo guardar archivo:', e.message);
    }

    const existe = db.prepare('SELECT id FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
    if (existe) {
      db.prepare('UPDATE perfiles_fiscales SET rfc=?, nombre=?, nombre_sat=?, cp=?, regimen=?, uso_cfdi=?, constancia_path=COALESCE(?, constancia_path) WHERE usuario_id=?')
        .run(datos.rfc, datos.nombre, datos.nombre, datos.cp, datos.regimen || '612', 'G03', constanciaPath, req.userId);
    } else {
      const email = db.prepare('SELECT email FROM usuarios WHERE id = ?').get(req.userId)?.email || '';
      db.prepare('INSERT INTO perfiles_fiscales (id,usuario_id,rfc,nombre,nombre_sat,cp,regimen,uso_cfdi,email,constancia_path) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(uuid(), req.userId, datos.rfc, datos.nombre, datos.nombre, datos.cp, datos.regimen || '612', 'G03', email, constanciaPath);
    }
    res.json({ datos, guardado: !existe });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
