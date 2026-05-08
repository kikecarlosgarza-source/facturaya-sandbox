// Endpoint de validación de PIEZA 1.2 — Reino C only.
//
// Dispara procesarFactura() con una solicitud sintética para verificar que
// el interceptor EN_DESARROLLO funciona end-to-end (UPDATE status='fallida_temporal'
// + email automático a kikecarlosgarza@gmail.com).
//
// BLINDAJE: solo permite portales EN_DESARROLLO. Si el establecimiento matchea
// un portal EN_VALIDACION o regular, devuelve 400 SIN invocar procesarFactura
// (evita timbrar accidentalmente en portal real durante diagnóstico).
//
// Uso:
//   curl -X POST https://facturaya-sandbox.onrender.com/api/test-interceptor \
//     -H "Content-Type: application/json" \
//     -d '{"establecimiento":"Soriana San Pedro"}'

const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const { procesarFactura, detectarPortal } = require('../services/automationService');

const router = express.Router();

router.post('/test-interceptor', async (req, res) => {
  if (!fs.existsSync(path.join(__dirname, '..', '.sandbox-marker'))) {
    return res.status(403).json({ exito: false, error: 'Endpoint solo disponible en Reino C' });
  }

  const inicio = Date.now();
  const { establecimiento } = req.body || {};

  if (!establecimiento) {
    return res.status(400).json({ exito: false, error: 'Falta establecimiento en body' });
  }

  // BLINDAJE: detectar portal y verificar que sea EN_DESARROLLO
  const portal = detectarPortal(establecimiento, null);
  if (!portal) {
    return res.status(400).json({
      exito: false,
      error: `No se detectó portal para "${establecimiento}". Endpoint solo permite establecimientos que matcheen portales EN_DESARROLLO.`
    });
  }
  if (portal.estado !== 'EN_DESARROLLO') {
    return res.status(400).json({
      exito: false,
      error: `Portal "${portal.key}" tiene estado "${portal.estado || 'sin estado'}" — endpoint solo permite EN_DESARROLLO para evitar timbrados accidentales.`,
      portalDetectado: portal.key,
      estado: portal.estado || null
    });
  }

  const solicitudId = uuidv4();
  const perfilId = uuidv4();
  const usuarioId = 'test-interceptor-user';
  let cleanup = { solicitud: false, perfil: false };

  try {
    // 1. Asegurar usuario test (INSERT OR IGNORE)
    db.prepare('INSERT OR IGNORE INTO usuarios (id, email, password) VALUES (?, ?, ?)')
      .run(usuarioId, 'test-interceptor@facturaya.test', 'no-auth');

    // 2. Asegurar perfil fiscal test
    db.prepare(`INSERT OR IGNORE INTO perfiles_fiscales
      (id, usuario_id, rfc, nombre, cp, regimen, uso_cfdi, email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(perfilId, usuarioId, 'TEST010101AAA', 'TEST INTERCEPTOR USER', '00000', '612', 'G03', 'test-interceptor@facturaya.test');
    cleanup.perfil = true;

    // 3. Crear solicitud sintética
    db.prepare(`INSERT INTO solicitudes
      (id, usuario_id, establecimiento, status)
      VALUES (?, ?, ?, ?)`)
      .run(solicitudId, usuarioId, establecimiento, 'pendiente');
    cleanup.solicitud = true;

    console.log(`[REINO C - TEST INTERCEPTOR] Disparando procesarFactura para "${establecimiento}" (portal=${portal.key})`);

    // 4. Invocar procesarFactura (debería caer en interceptor EN_DESARROLLO)
    const resultado = await procesarFactura(solicitudId);

    // 5. Leer status final de la DB para confirmar que UPDATE se hizo
    const solicitudFinal = db.prepare('SELECT status, status_detalle FROM solicitudes WHERE id = ?').get(solicitudId);

    return res.json({
      exito: true,
      ...resultado,
      portalDetectado: portal.key,
      estadoPortal: portal.estado,
      solicitudId,
      statusFinal: solicitudFinal?.status,
      statusDetalleFinal: solicitudFinal?.status_detalle,
      duracionMs: Date.now() - inicio,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[REINO C - TEST INTERCEPTOR] Error:', err.message);
    return res.status(500).json({
      exito: false,
      error: err.message,
      stack: err.stack?.substring(0, 500),
      duracionMs: Date.now() - inicio
    });
  } finally {
    // Cleanup: eliminar solicitud y perfil sintético
    try {
      if (cleanup.solicitud) {
        db.prepare('DELETE FROM solicitudes WHERE id = ?').run(solicitudId);
      }
      if (cleanup.perfil) {
        db.prepare('DELETE FROM perfiles_fiscales WHERE usuario_id = ?').run(usuarioId);
        db.prepare('DELETE FROM usuarios WHERE id = ?').run(usuarioId);
      }
    } catch (cleanupErr) {
      console.warn('[REINO C - TEST INTERCEPTOR] Cleanup falló:', cleanupErr.message);
    }
  }
});

module.exports = router;
