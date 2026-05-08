console.log('[REINO C - SANDBOX] Iniciando réplica de Reino A para validación');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/tickets',  require('./routes/tickets'));
app.use('/api/facturas', require('./routes/facturas'));
app.use('/api/perfil',   require('./routes/perfil'));

app.use('/api/constancia', require('./routes/constancia'));
app.use('/api/scripts',    require('./routes/scripts'));
app.use('/api/errors',     require('./routes/errors'));
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

if (require('fs').existsSync(require('path').join(__dirname, '.sandbox-marker'))) {
  const testHandlerRoute = require('./routes/testHandler');
  app.use('/api', testHandlerRoute);
  console.log('[REINO C - SANDBOX] Endpoint /api/test-handler registrado');

  const testAlertEmailRoute = require('./routes/testAlertEmail');
  app.use('/api', testAlertEmailRoute);
  console.log('[REINO C - SANDBOX] Endpoint /api/test-alert-email registrado');

  const testInterceptorRoute = require('./routes/testInterceptor');
  app.use('/api', testInterceptorRoute);
  console.log('[REINO C - SANDBOX] Endpoint /api/test-interceptor registrado');
}


// auto-seed usuario principal
try {
  const _db = require('./db/database');
  const _b = require('bcryptjs');
  const {v4:_uuid} = require('uuid');
  const _u = _db.prepare('SELECT id FROM usuarios WHERE email=?').get('kike@facturaya.mx');
  if (!_u) {
    _db.prepare('INSERT INTO usuarios(id,email,password,nombre) VALUES(?,?,?,?)').run(_uuid(),'kike@facturaya.mx',_b.hashSync('Kike2024',10),'Enrique Garza');
    console.log('[SEED] Usuario creado');
  } else {
    console.log('[SEED] Usuario ya existe');
  }
} catch(e) { console.log('[SEED] Error:', e.message); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FacturaYa backend corriendo en puerto ${PORT}`));

module.exports = app;
