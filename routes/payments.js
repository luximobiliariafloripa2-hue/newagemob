/**
 * AGEMOB — Rotas de Pagamento (módulo isolado)
 *
 * Este arquivo exporta uma função factory que recebe as dependências do server.js
 * principal (db, authMiddleware, log) e retorna um Express Router pronto para ser
 * montado. Nenhuma lógica de negócio existente é alterada — apenas consumida.
 *
 * Rotas expostas:
 *   GET  /api/pagamentos/config           — informa se o gateway está configurado + public key
 *   GET  /api/pagamentos/planos           — catálogo de planos com preços mensal/anual
 *   POST /api/pagamentos/criar-pedido     — cria pedido + preference no Mercado Pago
 *   GET  /api/pagamentos/pedido/:id       — consulta status de um pedido (para o frontend conferir)
 *   GET  /api/pagamentos/historico        — histórico de pagamentos da imobiliária logada
 */

const express = require('express');
const paymentService = require('../services/paymentService');

function genPedidoId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = 'PED';
  for (let i = 0; i < 10; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

module.exports = function paymentsRouter({ db, authMiddleware, log, getBaseUrl }) {
  const router = express.Router();

  // ── Config pública (frontend usa para montar o Brick com a Public Key) ──
  router.get('/config', (req, res) => {
    res.json({
      configurado: paymentService.isConfigured(),
      publicKey:   paymentService.getPublicKey()
    });
  });

  // ── Catálogo de planos com preços ──
  router.get('/planos', (req, res) => {
    const catalogo = Object.entries(paymentService.PLAN_CATALOG).map(([slug, p]) => ({
      slug, nome: p.nome, mensal: p.mensal, anual: p.anual
    }));
    res.json(catalogo);
  });

  // ── Criar pedido de pagamento ──
  router.post('/criar-pedido', authMiddleware(['admin', 'corretor']), async (req, res) => {
    try {
      if (!paymentService.isConfigured()) {
        return res.status(503).json({
          erro: 'Gateway de pagamento ainda não configurado. Configure MP_ACCESS_TOKEN no ambiente.'
        });
      }

      const { planoSlug, periodicidade } = req.body;
      if (!planoSlug || !['mensal', 'anual'].includes(periodicidade)) {
        return res.status(422).json({ erro: 'Plano e periodicidade (mensal/anual) são obrigatórios.' });
      }

      const precoInfo = paymentService.getPlanoPreco(planoSlug, periodicidade);
      if (!precoInfo) return res.status(422).json({ erro: 'Plano inválido.' });

      const imob = await db.imobiliarias.findOne({ _id: req.user.imobiliariaId });
      if (!imob) return res.status(404).json({ erro: 'Imobiliária não encontrada.' });

      const pedidoId = genPedidoId();

      // Salva pedido como "pendente" — só vira "aprovado" via webhook confirmado
      const pedido = await db.pagamentos.insert({
        pedidoId,
        imobiliariaId:  req.user.imobiliariaId,
        usuarioId:      req.user.userId,
        planoSlug,
        planoNome:      precoInfo.nome,
        periodicidade,
        valor:          precoInfo.valor,
        diasVigencia:   precoInfo.dias,
        metodoPagamento: null,       // preenchido pelo webhook
        status:         'pendente',  // pendente | aprovado | recusado | estornado
        transactionId:  null,
        criadoEm:       new Date().toISOString(),
        atualizadoEm:   new Date().toISOString()
      });

      const baseUrl = getBaseUrl(req);
      const pref = await paymentService.criarPreferencia({
        pedidoId,
        planoSlug,
        periodicidade,
        valor: precoInfo.valor,
        email: imob.email,
        nome:  imob.nome,
        baseUrl
      });

      await db.pagamentos.update({ pedidoId }, { $set: { preferenceId: pref.preferenceId, atualizadoEm: new Date().toISOString() } });
      await log('pagamento', `Pedido criado: ${pedidoId} — ${precoInfo.nome} ${periodicidade} — R$${precoInfo.valor}`, null, req.user.imobiliariaId);

      res.json({
        ok: true,
        pedidoId,
        initPoint: pref.initPoint,
        sandboxInitPoint: pref.sandboxInitPoint,
        publicKey: paymentService.getPublicKey()
      });
    } catch (e) {
      await log('erro', `Falha ao criar pedido de pagamento: ${e.message}`);
      res.status(500).json({ erro: 'Falha ao iniciar pagamento. Tente novamente.' });
    }
  });

  // ── Consultar status de um pedido (frontend usa após retorno do checkout) ──
  router.get('/pedido/:pedidoId', authMiddleware(['admin', 'corretor']), async (req, res) => {
    const pedido = await db.pagamentos.findOne({ pedidoId: req.params.pedidoId, imobiliariaId: req.user.imobiliariaId });
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado.' });
    res.json(pedido);
  });

  // ── Histórico de pagamentos da imobiliária logada ──
  router.get('/historico', authMiddleware(['admin', 'corretor']), async (req, res) => {
    const lista = await db.pagamentos.find({ imobiliariaId: req.user.imobiliariaId }).sort({ criadoEm: -1 });
    res.json(lista);
  });

  return router;
};
