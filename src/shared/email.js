const express = require('express');

// Envio de e-mail via Brevo
async function enviarEmailBrevo(destino, assunto, texto, html, nomeImob) {
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: `AGEMOB · ${nomeImob||'Imóveis'}`, email: process.env.BREVO_SENDER || 'luximobiliariafloripa2@gmail.com' },
      to: [{ email: destino }],
      subject: assunto,
      textContent: texto || undefined,
      htmlContent: html  || undefined
    })
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  return r.json();
}

function criarRotaEmail() {
  const router = express.Router();

  router.post('/', async (req, res) => {
    try {
      const { destino, assunto, texto, html, nomeImob } = req.body;
      if (!destino || !assunto || (!texto && !html)) return res.status(422).json({ erro: 'Campos obrigatórios.' });
      if (!process.env.BREVO_API_KEY) return res.status(503).json({ erro: 'E-mail não configurado.' });
      await enviarEmailBrevo(destino, assunto, texto, html, nomeImob);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
  });

  return router;
}

module.exports = { enviarEmailBrevo, criarRotaEmail };
