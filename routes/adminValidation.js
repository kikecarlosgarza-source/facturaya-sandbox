const express = require('express');
const path = require('path');
const fs = require('fs');
const validationStateService = require('../services/validationStateService');

const router = express.Router();

function checkAuth(req, res) {
  if (!fs.existsSync(path.join(__dirname, '..', '.sandbox-marker'))) {
    res.status(403).json({ exito: false, error: 'Endpoint solo disponible en Reino C' });
    return false;
  }
  const expected = process.env.ADMIN_API_TOKEN;
  if (!expected) {
    res.status(500).json({ exito: false, error: 'ADMIN_API_TOKEN no configurado' });
    return false;
  }
  if (req.headers['x-admin-token'] !== expected) {
    res.status(401).json({ exito: false, error: 'Token de admin inválido (header X-Admin-Token)' });
    return false;
  }
  return true;
}

router.get('/admin/validation-status', (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    const estados = validationStateService.listarTodos();
    res.json({ exito: true, total: estados.length, estados, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ exito: false, error: err.message });
  }
});

router.post('/admin/reset-validation', (req, res) => {
  if (!checkAuth(req, res)) return;
  const { portal } = req.body || {};
  if (!portal) return res.status(400).json({ exito: false, error: 'Falta { portal: "..." } en body' });
  try {
    const fueEliminado = validationStateService.resetValidation(portal);
    res.json({ exito: true, portal, fueEliminado, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ exito: false, error: err.message });
  }
});

router.post('/admin/reset-all-validation', (req, res) => {
  if (!checkAuth(req, res)) return;
  if (req.body?.confirmar !== 'SI_BORRAR_TODO') {
    return res.status(400).json({ exito: false, error: 'Mandá { "confirmar": "SI_BORRAR_TODO" } para confirmar' });
  }
  try {
    const cantidad = validationStateService.resetAllValidation();
    res.json({ exito: true, cantidadBorrada: cantidad, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ exito: false, error: err.message });
  }
});

module.exports = router;
