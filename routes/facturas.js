const express        = require('express');
const router         = express.Router();
const { v4: uuid }   = require('uuid');
const authMiddleware = require('../middleware/auth');
const automation     = require('../services/automationService');
const db             = require('../db/database');
const portalsData    = require('../portals/portals.json');

// POST /api/facturas/solicitar
// Dispara la automatización completa para solicitar la factura
router.post('/solicitar', authMiddleware, async (req, res) => {
  const { ticketData, portalInfo } = req.body;
  if (!ticketData) return res.status(400).json({ error: 'Datos del ticket requeridos' });

  // Obtener perfil fiscal del usuario
  const perfil = db.prepare('SELECT * FROM perfiles_fiscales WHERE usuario_id = ?').get(req.userId);
  if (!perfil) return res.status(400).json({ error: 'Configura tu perfil fiscal primero' });

  // Crear registro de solicitud
  const solicitudId = uuid();
  db.prepare(`
    INSERT INTO solicitudes (id, usuario_id, establecimiento, rfc_emisor, folio, fecha_compra, total, descripcion, portal_url, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'procesando')
  `).run(
    solicitudId, req.userId,
    ticketData.establecimiento, ticketData.rfc_emisor,
    ticketData.folio, ticketData.fecha,
    ticketData.total, ticketData.descripcion,
    portalInfo?.portal_url
  );

  // Responder inmediatamente — la automatización corre en background
  res.json({ solicitudId, status: 'procesando', mensaje: 'Solicitando tu factura...' });

  // Correr automatización en background
  _ejecutarAutomatizacion(solicitudId, ticketData, portalInfo, perfil);
});

async function _ejecutarAutomatizacion(solicitudId, ticketData, portalInfo, perfil) {
  try {
    let resultado;

    if (portalInfo?.url_directa && ticketData.url_facturacion) {
      // URL directa desde el ticket (Parrot, etc.)
      resultado = await automation.solicitarFacturaURLDirecta(
        ticketData.url_facturacion, ticketData, perfil
      );
    } else if (portalInfo?.portal_id) {
      // Portal en nuestra base de datos
      const portal = portalsData.portals.find(p => p.id === portalInfo.portal_id);
      if (portal) {
        resultado = await automation.solicitarFactura(ticketData, perfil, { portal, url_directa: null });
      } else {
        resultado = { success: false, mensaje: 'Portal no encontrado en base de datos' };
      }
    } else if (portalInfo?.portal_url) {
      // URL encontrada por IA pero sin flujo definido — intentar genérico
      resultado = await automation.solicitarFacturaURLDirecta(portalInfo.portal_url, ticketData, perfil);
    } else {
      resultado = { success: false, mensaje: 'No se encontró portal de facturación para este establecimiento' };
    }

    // Actualizar status en BD
    const status = resultado.success ? 'solicitada' : 'requiere_atencion';
    db.prepare(`
      UPDATE solicitudes SET status = ?, status_detalle = ?, actualizado_en = datetime('now')
      WHERE id = ?
    `).run(status, resultado.mensaje, solicitudId);

  } catch (err) {
    db.prepare(`
      UPDATE solicitudes SET status = 'error', status_detalle = ?, actualizado_en = datetime('now')
      WHERE id = ?
    `).run(err.message, solicitudId);
  }
}

// GET /api/facturas/historial
router.get('/historial', authMiddleware, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;
  const rows = db.prepare(`
    SELECT * FROM solicitudes WHERE usuario_id = ?
    ORDER BY creado_en DESC LIMIT ? OFFSET ?
  `).all(req.userId, parseInt(limit), offset);

  const total = db.prepare('SELECT COUNT(*) as c FROM solicitudes WHERE usuario_id = ?').get(req.userId).c;
  res.json({ solicitudes: rows, total, page: parseInt(page), pages: Math.ceil(total / limit) });
});

// GET /api/facturas/status/:id
router.get('/status/:id', authMiddleware, (req, res) => {
  const row = db.prepare('SELECT * FROM solicitudes WHERE id = ? AND usuario_id = ?')
    .get(req.params.id, req.userId);
  if (!row) return res.status(404).json({ error: 'Solicitud no encontrada' });
  res.json(row);
});

module.exports = router;
