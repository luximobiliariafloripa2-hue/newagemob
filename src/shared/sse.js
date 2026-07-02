const express = require('express');

// ═══════════════════════════════════════════════════════
// SSE — Server-Sent Events para atualização em tempo real
// ═══════════════════════════════════════════════════════
const sseClients = new Map(); // imobiliariaId → Set of response objects

function sseNotificar(imobiliariaId, evento, dados) {
  const clientes = sseClients.get(imobiliariaId);
  if (!clientes || clientes.size === 0) return;
  const msg = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) {
    try { res.write(msg); } catch(e) { clientes.delete(res); }
  }
}

// Rota SSE — painel da imobiliária se conecta aqui
function criarRotaSSE(authMiddleware) {
  const router = express.Router();

  router.get('/', authMiddleware(['admin','corretor']), (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Nginx/Render: desativa buffer
    res.flushHeaders();

    const imobId = req.user.imobiliariaId;
    if (!sseClients.has(imobId)) sseClients.set(imobId, new Set());
    sseClients.get(imobId).add(res);

    // Ping a cada 25s para manter conexão viva
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch(e) { clearInterval(ping); }
    }, 25000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.get(imobId)?.delete(res);
    });
  });

  return router;
}

module.exports = { sseNotificar, criarRotaSSE };
