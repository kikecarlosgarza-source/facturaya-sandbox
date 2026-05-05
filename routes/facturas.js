const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const authMiddleware = require('../middleware/auth');
const { procesarFactura, enviarCaptcha } = require('../services/automationService');
const { enviarConstanciaPorEmail } = require('../services/emailService');
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
    const s = db.prepare('SELECT id, status, status_detalle, establecimiento, rfc_emisor, folio, fecha_compra, total, portal_url FROM solicitudes WHERE id = ? AND usuario_id = ?')
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

// Contacto del negocio (whatsapp/email) — upsert con COALESCE para no pisar
// el otro campo si solo viene uno.
router.post('/contacto-negocio', authMiddleware, (req, res) => {
  try {
    const { rfc_emisor, whatsapp, email } = req.body || {};
    if (!rfc_emisor) return res.status(400).json({ error: 'rfc_emisor requerido' });
    if (!whatsapp && !email) return res.status(400).json({ error: 'al menos whatsapp o email es requerido' });

    const existe = db.prepare('SELECT rfc_emisor FROM contactos_negocio WHERE rfc_emisor = ?').get(rfc_emisor);
    if (existe) {
      db.prepare(`UPDATE contactos_negocio
                  SET whatsapp = COALESCE(?, whatsapp),
                      email    = COALESCE(?, email),
                      actualizado_en = datetime('now')
                  WHERE rfc_emisor = ?`)
        .run(whatsapp || null, email || null, rfc_emisor);
    } else {
      db.prepare(`INSERT INTO contactos_negocio (rfc_emisor, whatsapp, email, actualizado_en)
                  VALUES (?, ?, ?, datetime('now'))`)
        .run(rfc_emisor, whatsapp || null, email || null);
    }
    const final = db.prepare('SELECT rfc_emisor, whatsapp, email, actualizado_en FROM contactos_negocio WHERE rfc_emisor = ?').get(rfc_emisor);
    res.json({ ok: true, contacto: final });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/contacto-negocio/:rfc', authMiddleware, (req, res) => {
  try {
    const r = db.prepare('SELECT rfc_emisor, whatsapp, email, actualizado_en FROM contactos_negocio WHERE rfc_emisor = ?')
      .get(req.params.rfc);
    res.json(r || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Manda el correo con la constancia adjunta vía SendGrid SMTP. Errores
// específicos (sin email_negocio, sin perfil, sin constancia, sin SendGrid)
// devuelven códigos identificables para que la app muestre UX adecuado.
router.post('/enviar-constancia', authMiddleware, async (req, res) => {
  try {
    const { solicitudId } = req.body || {};
    if (!solicitudId) return res.status(400).json({ error: 'solicitudId requerido' });

    const sol = db.prepare(`SELECT id, rfc_emisor, establecimiento, folio, fecha_compra, total, usuario_id
                            FROM solicitudes WHERE id = ? AND usuario_id = ?`)
      .get(solicitudId, req.userId);
    if (!sol) return res.status(404).json({ error: 'solicitud_no_encontrada' });
    if (!sol.rfc_emisor) return res.status(400).json({ error: 'solicitud_sin_rfc_emisor' });

    const contacto = db.prepare('SELECT email FROM contactos_negocio WHERE rfc_emisor = ?').get(sol.rfc_emisor);
    if (!contacto || !contacto.email) {
      return res.status(400).json({ error: 'falta_email_negocio', rfc_emisor: sol.rfc_emisor });
    }

    const perfil = db.prepare(`SELECT rfc, nombre, nombre_sat, cp, regimen, uso_cfdi, email, constancia_path
                               FROM perfiles_fiscales WHERE usuario_id = ?`).get(req.userId);
    if (!perfil) return res.status(400).json({ error: 'sin_perfil_fiscal' });

    try {
      await enviarConstanciaPorEmail({
        to: contacto.email,
        perfil,
        establecimiento: sol.establecimiento,
        ticket: { folio: sol.folio, fecha_compra: sol.fecha_compra, total: sol.total },
        attachmentPath: perfil.constancia_path
      });
    } catch (e) {
      if (e.code === 'EMAIL_NO_CONFIGURADO') {
        return res.status(503).json({ error: 'email_no_configurado', detalle: 'SENDGRID_API_KEY o SENDGRID_FROM no seteadas en backend' });
      }
      throw e;
    }

    db.prepare(`UPDATE solicitudes SET status = ?, status_detalle = ? WHERE id = ?`)
      .run('manual_email_enviado', `Constancia enviada a ${contacto.email}`, solicitudId);

    res.json({ ok: true, enviado_a: contacto.email });
  } catch (e) {
    console.error('[enviar-constancia]', e);
    res.status(500).json({ error: e.message });
  }
});

// Stream binario de la constancia del usuario, para que la app la descargue
// con expo-file-system y la comparta vía expo-sharing al WhatsApp del negocio.
router.get('/constancia', authMiddleware, (req, res) => {
  try {
    const perfil = db.prepare('SELECT constancia_path FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
    if (!perfil || !perfil.constancia_path) return res.status(404).json({ error: 'sin_constancia' });
    if (!fs.existsSync(perfil.constancia_path)) return res.status(404).json({ error: 'archivo_no_encontrado' });

    const ext = path.extname(perfil.constancia_path).toLowerCase().replace('.', '');
    const mime = ext === 'pdf' ? 'application/pdf'
               : ext === 'png' ? 'image/png'
               : 'image/jpeg';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="constancia_fiscal.${ext}"`);
    fs.createReadStream(perfil.constancia_path).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/historial', authMiddleware, (req, res) => {
  try {
    const data = db.prepare('SELECT * FROM solicitudes WHERE usuario_id = ? ORDER BY rowid DESC LIMIT 20').all(req.userId);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
