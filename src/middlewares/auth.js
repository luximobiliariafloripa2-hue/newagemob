const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');

// Middleware JWT — verifica token e injeta req.user
function authMiddleware(roles = []) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    // SSE/EventSource envia token via query string pois não suporta headers customizados
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ erro: 'Token não fornecido.' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ erro: 'Acesso negado.' });
      }
      next();
    } catch(e) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }
  };
}

module.exports = authMiddleware;
