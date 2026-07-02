function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 9; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

module.exports = { genCode };
