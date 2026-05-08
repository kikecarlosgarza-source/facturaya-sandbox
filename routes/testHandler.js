const express = require('express');
const path = require('path');
const router = express.Router();

// POST /test-handler — solo accesible si MODE=sandbox
router.post('/test-handler', async (req, res) => {
  const { portal, ticketData, perfil } = req.body;

  if (!portal || !ticketData) {
    return res.status(400).json({ exito: false, error: 'Falta portal o ticketData' });
  }

  // Verificar que estamos en sandbox
  const fs = require('fs');
  if (!fs.existsSync(path.join(__dirname, '..', '.sandbox-marker'))) {
    return res.status(403).json({ exito: false, error: 'Endpoint solo disponible en Reino C' });
  }

  console.log(`[REINO C - TEST] portal=${portal}, ticket=${ticketData?.noTicket || 'desconocido'}`);

  try {
    // Cargar el handler del portal solicitado
    const handlerPath = path.join(__dirname, '..', 'services', 'handlers', `${portal}Handler.js`);
    if (!fs.existsSync(handlerPath)) {
      return res.status(404).json({
        exito: false,
        error: `Handler no encontrado: ${portal}Handler.js`,
        path: handlerPath
      });
    }

    // Limpiar require cache para que tome el handler actualizado
    delete require.cache[require.resolve(handlerPath)];
    const handler = require(handlerPath);

    if (typeof handler.ejecutar !== 'function') {
      return res.status(500).json({ exito: false, error: 'Handler no exporta función ejecutar' });
    }

    // Perfil de prueba (datos del usuario default)
    const perfilDefault = perfil || {
      rfc: 'GAME860412CY6',
      nombre: 'ENRIQUE CARLOS GARZA MONTEMAYOR',
      cp: '66230',
      regimen: '612',
      usoCfdi: 'G03',
      email: 'kikecarlosgarza@gmail.com'
    };

    const inicio = Date.now();
    const resultado = await handler.ejecutar(perfilDefault, ticketData);
    const duracionMs = Date.now() - inicio;

    return res.json({
      ...resultado,
      duracionMs,
      portalProbado: portal,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error(`[REINO C - TEST] Error ejecutando handler ${portal}:`, err);
    return res.status(500).json({
      exito: false,
      error: err.message,
      stack: err.stack?.substring(0, 500)
    });
  }
});

module.exports = router;
