const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const authMiddleware = require('../middleware/auth');

const selectActive = db.prepare(`
  SELECT id, portal, step, patch_js, descripcion, confidence, created_at, active
  FROM portal_scripts
  WHERE portal = ? AND active = 1
  ORDER BY created_at DESC
`);

const selectById = db.prepare(`
  SELECT id, portal, step FROM portal_scripts WHERE id = ? AND portal = ?
`);

const selectPrevious = db.prepare(`
  SELECT id FROM portal_scripts
  WHERE portal = ? AND step IS ? AND id != ? AND active = 0
  ORDER BY created_at DESC
  LIMIT 1
`);

const deactivate = db.prepare(`UPDATE portal_scripts SET active = 0 WHERE id = ?`);
const activate   = db.prepare(`UPDATE portal_scripts SET active = 1 WHERE id = ?`);

// Algunos rows en portal_scripts no son JS ejecutable sino descriptores JSON
// (analyzeApiFailure → step="api:..."; handlerUniversal → step="universal_pattern:...";
// agentService macro CAMBIO 1 → step="agente_visual_exitoso"). Esos los salta el
// validador para no marcarlos como inválidos por error.
function esJsEjecutable(patch_js, step) {
  if (!patch_js || typeof patch_js !== 'string') return false;
  if (patch_js.trim().startsWith('{')) return false;
  if (step && (step.startsWith('api:') ||
               step.startsWith('universal_pattern:') ||
               step === 'agente_visual_exitoso')) return false;
  return true;
}

function validarSintaxisJs(code) {
  try {
    const AsyncFunction = (async function(){}).constructor;
    new AsyncFunction(code);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// POST /api/scripts/cleanup — recorre todos los activos, valida sintaxis JS de
// los que son código ejecutable y desactiva los que tengan SyntaxError.
// Reversible vía /:portal/:id/rollback.
router.post('/cleanup', authMiddleware, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, portal, step, patch_js FROM portal_scripts WHERE active = 1').all();
    const desactivados = [];
    let skipped_json = 0;
    let validos = 0;
    const tx = db.transaction(() => {
      for (const r of rows) {
        if (!esJsEjecutable(r.patch_js, r.step)) { skipped_json++; continue; }
        const v = validarSintaxisJs(r.patch_js);
        if (!v.valid) {
          deactivate.run(r.id);
          desactivados.push({ id: r.id, portal: r.portal, step: r.step, error: v.error });
        } else {
          validos++;
        }
      }
    });
    tx();
    res.json({
      total_activos_antes: rows.length,
      desactivados: desactivados.length,
      validos,
      skipped_json_descriptors: skipped_json,
      detalles: desactivados
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scripts/patch/:id — endpoint admin temporal: devuelve el parche
// completo (incluyendo patch_js) por id. Debe ir ANTES de /:portal porque
// Express matchea por orden y "patch" caería bajo el catch-all de :portal.
router.get('/patch/:id', authMiddleware, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    const r = db.prepare(`
      SELECT id, portal, step, patch_js, descripcion, confidence, created_at, active
      FROM portal_scripts WHERE id = ?
    `).get(id);
    if (!r) return res.status(404).json({ error: 'parche no encontrado' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/scripts/:portal
router.get('/:portal', (req, res) => {
  try {
    const scripts = selectActive.all(req.params.portal);
    res.json({ portal: req.params.portal, scripts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/scripts/:portal/:id/rollback
router.post('/:portal/:id/rollback', (req, res) => {
  try {
    const { portal, id } = req.params;
    const current = selectById.get(id, portal);
    if (!current) {
      return res.status(404).json({ error: 'Parche no encontrado para ese portal' });
    }

    const previous = selectPrevious.get(portal, current.step, id);

    const tx = db.transaction(() => {
      deactivate.run(id);
      if (previous) activate.run(previous.id);
    });
    tx();

    res.json({
      portal,
      desactivado: Number(id),
      activado: previous ? previous.id : null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
