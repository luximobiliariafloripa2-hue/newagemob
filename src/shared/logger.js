function createLogger(db) {
  return async function log(tipo, mensagem, dados, imobiliariaId) {
    try { await db.logs.insert({ tipo, mensagem, dados: dados||null, imobiliariaId: imobiliariaId||null, em: new Date().toISOString() }); }
    catch(e) { console.error('Log error:', e.message); }
  };
}

module.exports = createLogger;
