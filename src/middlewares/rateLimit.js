const rateLimit = require('express-rate-limit');

// Rate limiting — proteção brute force
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { erro: 'Muitas tentativas. Aguarde 15 minutos.' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 100 });

module.exports = { authLimiter, apiLimiter };
