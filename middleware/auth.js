const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'facturasat_secret_2024';

module.exports = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requerido' });
  try {
    const payload = jwt.verify(auth.split(' ')[1], JWT_SECRET);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};
