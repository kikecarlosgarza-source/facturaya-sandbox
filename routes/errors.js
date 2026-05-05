const express = require('express');
const router  = express.Router();
const authMiddleware = require('../middleware/auth');
const claudeAgent    = require('../services/claudeAgent');

// POST /api/errors/report
// Recibe un fallo de API capturado en el cliente y lanza analyzeApiFailure
// en background. Responde inmediatamente con { received: true }.
router.post('/report', authMiddleware, (req, res) => {
  const { portal, endpoint, request, responseStatus, responseBody, error } = req.body || {};

  if (!portal || !error) {
    return res.status(400).json({ error: 'portal y error son requeridos' });
  }

  claudeAgent.analyzeApiFailure({ portal, endpoint, request, responseStatus, responseBody, error })
    .catch(err => console.warn(`[/errors/report] analyzeApiFailure falló (${portal}):`, err.message));

  res.json({ received: true });
});

module.exports = router;
