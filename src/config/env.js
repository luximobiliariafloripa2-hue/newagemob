const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'agemob-dev-secret-mude-em-producao';

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (req) return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:' + PORT;
}

module.exports = { PORT, JWT_SECRET, getBaseUrl };
