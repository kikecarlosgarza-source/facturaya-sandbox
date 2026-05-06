// Endpoint TEMPORAL de auditoría para handlerUniversal (creado 2026-05-06).
// Borrar este archivo + la línea que lo monta en server.js cuando se tome la
// decisión KEEP/DEPRECATE/REFACTOR sobre handlerUniversal.
//
// Auth: ?token=<ADMIN_AUDIT_TOKEN>. La env var debe estar set en Render.
const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.get('/audit-handler-universal', (req, res) => {
  const expected = process.env.ADMIN_AUDIT_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_AUDIT_TOKEN no configurado' });
  }
  if (req.query.token !== expected) {
    return res.status(403).json({ error: 'token inválido' });
  }

  try {
    const portal_scripts_total = db.prepare('SELECT COUNT(*) AS n FROM portal_scripts').get().n;
    const portal_scripts_by_portal = db.prepare(
      'SELECT portal, COUNT(*) AS n FROM portal_scripts GROUP BY portal ORDER BY n DESC'
    ).all();
    const universal_patterns = db.prepare(
      "SELECT id, step, descripcion, confidence, active, created_at FROM portal_scripts WHERE portal='universal' ORDER BY id DESC"
    ).all();

    const solicitudes_total = db.prepare('SELECT COUNT(*) AS n FROM solicitudes').get().n;
    const solicitudes_by_status = db.prepare(
      'SELECT status, COUNT(*) AS n FROM solicitudes GROUP BY status ORDER BY n DESC'
    ).all();

    const universal_attempts_by_status = db.prepare(`
      SELECT status, COUNT(*) AS n FROM solicitudes
      WHERE status_detalle LIKE 'Universal:%' OR status_detalle LIKE 'Universal IA:%'
      GROUP BY status
    `).all();

    const universal_message_buckets = db.prepare(`
      SELECT status_detalle, COUNT(*) AS n FROM solicitudes
      WHERE status_detalle LIKE 'Universal:%' OR status_detalle LIKE 'Universal IA:%'
      GROUP BY status_detalle ORDER BY n DESC LIMIT 30
    `).all();

    const universal_last_50 = db.prepare(`
      SELECT id, establecimiento, portal_url, status, status_detalle, creado_en
      FROM solicitudes
      WHERE status_detalle LIKE 'Universal:%' OR status_detalle LIKE 'Universal IA:%'
      ORDER BY creado_en DESC LIMIT 50
    `).all();

    res.json({
      generated_at: new Date().toISOString(),
      portal_scripts: {
        total: portal_scripts_total,
        by_portal: portal_scripts_by_portal,
        universal_patterns
      },
      solicitudes: {
        total: solicitudes_total,
        by_status: solicitudes_by_status,
        handler_universal: {
          by_status: universal_attempts_by_status,
          message_buckets: universal_message_buckets,
          last_50: universal_last_50
        }
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
