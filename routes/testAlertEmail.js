// Endpoint TEMPORAL/DIAGNÓSTICO de validación SMTP — Reino C only.
//
// Permite disparar un email de prueba vía emailServiceAlert para verificar
// que las credenciales GMAIL_USER + GMAIL_APP_PASSWORD están bien configuradas
// y que Gmail acepta el envío.
//
// Gateado por .sandbox-marker (igual que testHandler) — solo accesible cuando
// el repo es Reino C.
//
// Uso:
//   curl -X POST https://facturaya-sandbox.onrender.com/api/test-alert-email
//   curl -X POST https://facturaya-sandbox.onrender.com/api/test-alert-email \
//     -H "Content-Type: application/json" \
//     -d '{"to":"otro@correo.com","subject":"Prueba","body":"Hola"}'
//
// Body (todos opcionales):
//   to?     — destinatario (default ALERT_EMAIL_TO o GMAIL_USER)
//   subject — asunto (default mensaje de prueba)
//   body    — cuerpo en texto plano (default mensaje de prueba)
//
// Devuelve:
//   200 { exito: true, messageId, ... }   si SMTP OK
//   500 { exito: false, error }           si SMTP falla
//   403 si no es Reino C

const express = require('express');
const path = require('path');
const fs = require('fs');
const { enviarAlerta } = require('../services/emailServiceAlert');

const router = express.Router();

router.post('/test-alert-email', async (req, res) => {
  // Gate Reino C
  if (!fs.existsSync(path.join(__dirname, '..', '.sandbox-marker'))) {
    return res.status(403).json({ exito: false, error: 'Endpoint solo disponible en Reino C' });
  }

  const inicio = Date.now();
  const { to, subject, body } = req.body || {};

  // Defaults útiles si el caller no manda nada
  const subjectFinal = subject || `🧪 Test SMTP FacturaYa — ${new Date().toISOString()}`;
  const bodyFinal = body || [
    `Este es un email de prueba enviado desde Reino C (sandbox).`,
    ``,
    `Si lo recibís, las credenciales GMAIL_USER + GMAIL_APP_PASSWORD están bien.`,
    ``,
    `Timestamp: ${new Date().toISOString()}`,
    `Servidor: ${process.env.RENDER_EXTERNAL_URL || 'localhost'}`,
    ``,
    `— FacturaYa Alerts (test endpoint)`
  ].join('\n');

  try {
    console.log(`[REINO C - TEST ALERT] Disparando email — to=${to || '(default)'} subject="${subjectFinal.substring(0, 60)}"`);

    const result = await enviarAlerta({ subject: subjectFinal, body: bodyFinal, to });

    const duracionMs = Date.now() - inicio;

    if (result.success) {
      return res.json({
        exito: true,
        messageId: result.messageId,
        envioA: to || process.env.ALERT_EMAIL_TO || process.env.GMAIL_USER || '(no configurado)',
        duracionMs,
        timestamp: new Date().toISOString()
      });
    }

    return res.status(500).json({
      exito: false,
      error: result.error || 'SMTP falló sin mensaje',
      duracionMs,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[REINO C - TEST ALERT] Error inesperado:', err.message);
    return res.status(500).json({
      exito: false,
      error: err.message,
      stack: err.stack?.substring(0, 500),
      duracionMs: Date.now() - inicio,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
