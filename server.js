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
app.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FacturaSAT backend corriendo en puerto ${PORT}`));

module.exports = app;
