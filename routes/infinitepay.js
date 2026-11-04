'use strict';

// AGEMOB — checkout e confirmação de pagamento pela InfinitePay (M9-02).
//
//   GET  /api/pagamentos/planos        planos vendáveis (db.planos)
//   POST /api/pagamentos/criar         { planoId } → link de pagamento
//   GET  /api/pagamentos/:orderNsu     status do pedido; com transaction_nsu
//                                      e slug também confirma (caminho B)
//   POST /api/webhooks/infinitepay     gatilho de confirmação (caminho A)
//
// O webhook não é assinado: dele só se aproveitam order_nsu, transaction_nsu
// e invoice_slug, e nada é gravado sem payment_check positivo. Tenant, plano
// e valor vêm sempre do registro local.
//
// Aplicação do plano: aplicacaoStatus pending → processing (claim atômico)
// → applied | failed. failed/processing parados exigem reconciliação manual;
// nada é reaplicado automaticamente.
//
// Com INFINITEPAY_DESATIVADO=true (homologação, M11): /criar e o webhook
// respondem 503 sem gravar nada; a consulta de pedido só lê o registro local.

const express = require('express');
const crypto = require('crypto');
const { ErroInfinitepay } = require('../services/infinitepayService');

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RE_ID_EXTERNO = /^[A-Za-z0-9_-]{1,100}$/;
const VALIDADE_LINK_MS = 48 * 60 * 60 * 1000;
const VALOR_MINIMO_CENTAVOS = 100;
const MSG_DESATIVADO = 'Pagamento temporariamente indisponível: ambiente de homologação, sem cobrança.';

function valorCentavosVendavel(plano) {
  if (!plano || plano.ativo !== true || plano.slug === 'trial') return null;
  if (typeof plano.valorMensal !== 'number' || !Number.isFinite(plano.valorMensal)) return null;
  const centavos = Math.round(plano.valorMensal * 100);
  return centavos >= VALOR_MINIMO_CENTAVOS ? centavos : null;
}

// Status mostrado ao tenant: aprovado só com o plano efetivamente aplicado.
function statusPublico(pag) {
  if (pag.status === 'approved') return pag.aplicacaoStatus === 'applied' ? 'approved' : 'processing';
  return pag.status;
}

module.exports = function rotasInfinitepay({ db, authMiddleware, carregarAcessoTenant, log, getBaseUrl, infinitepay, ativarPorPagamento }) {
  db.pagamentos.ensureIndex({ fieldName: 'orderNsu', unique: true });
  db.pagamentos.ensureIndex({ fieldName: 'transactionNsu', unique: true, sparse: true });

  // Confirma um pedido local pela InfinitePay e aplica o plano uma única vez.
  // Retorna 'aplicado' | 'noop' | 'nao_pago' | 'conflito' | 'falha_aplicacao';
  // lança ErroInfinitepay em falha temporária (nada é alterado).
  async function confirmarPagamento(pag, transactionNsu, slug) {
    if (pag.status !== 'pending' || pag.aplicacaoStatus !== 'pending') return 'noop';

    const conf = await infinitepay.verificarPagamento({
      orderNsu: pag.orderNsu, transactionNsu, slug, valorCentavos: pag.valorCentavos
    });
    if (!conf.pago) {
      if (conf.motivo === 'valor_divergente' || conf.motivo === 'valor_pago_menor') {
        await log('alerta', `InfinitePay: pagamento com valor divergente (${conf.motivo}) pedido=${pag.orderNsu}`, null, pag.imobiliariaId);
      }
      return 'nao_pago';
    }

    const outro = await db.pagamentos.findOne({ transactionNsu, _id: { $ne: pag._id } });
    if (outro) {
      await log('alerta', `InfinitePay: transaction_nsu já usado no pedido ${outro.orderNsu}; pedido=${pag.orderNsu} não aplicado`, null, pag.imobiliariaId);
      return 'conflito';
    }

    const agora = new Date();
    let n;
    try {
      n = await db.pagamentos.update(
        { _id: pag._id, status: 'pending', aplicacaoStatus: 'pending' },
        { $set: { status: 'approved', aplicacaoStatus: 'processing', transactionNsu, invoiceSlug: slug,
          metodo: conf.metodo, aprovadoEm: agora.toISOString(), atualizadoEm: agora.toISOString() } });
    } catch (e) {
      if (e.errorType !== 'uniqueViolated') throw e;
      await log('alerta', `InfinitePay: transaction_nsu já usado em outro pedido; pedido=${pag.orderNsu} não aplicado`, null, pag.imobiliariaId);
      return 'conflito';
    }
    if (n !== 1) return 'noop';

    try {
      await ativarPorPagamento(pag.imobiliariaId, pag, agora);
    } catch (e) {
      await db.pagamentos.update({ _id: pag._id }, { $set: { aplicacaoStatus: 'failed', atualizadoEm: new Date().toISOString() } });
      await log('erro', `InfinitePay: pagamento aprovado sem plano aplicado — reconciliação manual. pedido=${pag.orderNsu} (${e.message})`, null, pag.imobiliariaId);
      return 'falha_aplicacao';
    }
    const fim = new Date().toISOString();
    await db.pagamentos.update({ _id: pag._id }, { $set: { aplicacaoStatus: 'applied', planoAplicadoEm: fim, atualizadoEm: fim } });
    await log('pagamento', `Plano ${pag.planoNome} aplicado por pagamento InfinitePay. pedido=${pag.orderNsu}`, null, pag.imobiliariaId);
    return 'aplicado';
  }

  // ── /api/pagamentos ──
  const pagamentos = express.Router();

  pagamentos.get('/planos', authMiddleware(['admin']), async (_req, res) => {
    try {
      const planos = await db.planos.find({ ativo: true });
      res.json(planos
        .map(p => ({ p, centavos: valorCentavosVendavel(p) }))
        .filter(x => x.centavos !== null)
        .sort((a, b) => a.centavos - b.centavos)
        .map(({ p }) => ({ _id: p._id, nome: p.nome, valorMensal: p.valorMensal })));
    } catch (e) {
      res.status(500).json({ erro: 'Erro interno.' });
    }
  });

  pagamentos.post('/criar', authMiddleware(['admin']), async (req, res) => {
    try {
      if (req.user.modoSuporte) return res.status(403).json({ erro: 'Compra de plano indisponível em modo suporte.' });
      const { imob, acesso } = await carregarAcessoTenant(req.user.imobiliariaId);
      if (!imob || acesso.statusEfetivo === 'suspenso' || acesso.statusEfetivo === 'desativado') {
        return res.status(403).json({ erro: acesso.motivo || 'Conta indisponível.' });
      }
      if (infinitepay.desativado) return res.status(503).json({ erro: MSG_DESATIVADO });
      if (!infinitepay.configurado) return res.status(503).json({ erro: 'Pagamento indisponível no momento.' });

      const { planoId } = req.body || {};
      if (typeof planoId !== 'string' || !planoId) return res.status(422).json({ erro: 'Plano inválido.' });
      const plano = await db.planos.findOne({ _id: planoId });
      const valorCentavos = valorCentavosVendavel(plano);
      if (valorCentavos === null) return res.status(422).json({ erro: 'Plano inválido.' });

      const agora = new Date();
      const pag = await db.pagamentos.insert({
        gateway: 'infinitepay',
        imobiliariaId: imob._id,
        usuarioId: req.user.userId,
        planoId: plano._id,
        planoSlug: plano.slug,
        planoNome: plano.nome,
        valorCentavos,
        moeda: 'BRL',
        orderNsu: crypto.randomUUID(),
        checkoutUrl: null,
        metodo: null,
        status: 'pending',
        aplicacaoStatus: 'pending',
        criadoEm: agora.toISOString(),
        atualizadoEm: agora.toISOString(),
        aprovadoEm: null
      });

      const base = getBaseUrl(req);
      let checkoutUrl;
      try {
        ({ checkoutUrl } = await infinitepay.criarLink({
          orderNsu: pag.orderNsu,
          valorCentavos,
          descricao: `AGEMOB — Plano ${plano.nome} (30 dias)`,
          redirectUrl: `${base}/checkout-resultado.html`,
          webhookUrl: `${base}/api/webhooks/infinitepay`,
          cliente: { nome: imob.nome, email: imob.email },
          validoAte: new Date(agora.getTime() + VALIDADE_LINK_MS).toISOString()
        }));
      } catch (e) {
        await db.pagamentos.update({ _id: pag._id }, { $set: { status: 'canceled', atualizadoEm: new Date().toISOString() } });
        await log('erro', `InfinitePay: falha ao criar link pedido=${pag.orderNsu} (${e instanceof ErroInfinitepay ? e.detalhe : 'interno'})`, null, imob._id);
        return res.status(502).json({ erro: 'Falha ao iniciar pagamento. Tente novamente.' });
      }

      await db.pagamentos.update({ _id: pag._id }, { $set: { checkoutUrl, atualizadoEm: new Date().toISOString() } });
      await log('pagamento', `Pedido criado: ${pag.orderNsu} — ${plano.nome} — ${valorCentavos} centavos`, null, imob._id);
      res.json({ checkoutUrl, orderNsu: pag.orderNsu });
    } catch (e) {
      res.status(500).json({ erro: 'Erro interno.' });
    }
  });

  pagamentos.get('/:orderNsu', authMiddleware(['admin', 'corretor']), async (req, res) => {
    try {
      const { orderNsu } = req.params;
      if (!RE_UUID.test(orderNsu)) return res.status(404).json({ erro: 'Pedido não encontrado.' });
      let pag = await db.pagamentos.findOne({ orderNsu, imobiliariaId: req.user.imobiliariaId });
      if (!pag) return res.status(404).json({ erro: 'Pedido não encontrado.' });

      // Caminho B: a InfinitePay não consulta só por order_nsu; o retorno do
      // navegador traz transaction_nsu e slug, que só servem para perguntar.
      const { transaction_nsu: transactionNsu, slug } = req.query;
      if (pag.status === 'pending' && infinitepay.configurado
          && typeof transactionNsu === 'string' && RE_ID_EXTERNO.test(transactionNsu)
          && typeof slug === 'string' && RE_ID_EXTERNO.test(slug)) {
        try {
          await confirmarPagamento(pag, transactionNsu, slug);
        } catch (e) {
          if (!(e instanceof ErroInfinitepay)) throw e;
          await log('erro', `InfinitePay: payment_check indisponível (retorno) pedido=${orderNsu} (${e.detalhe})`, null, pag.imobiliariaId);
        }
        pag = await db.pagamentos.findOne({ _id: pag._id });
      }
      res.json({ status: statusPublico(pag), planoNome: pag.planoNome, aprovadoEm: pag.aprovadoEm || null });
    } catch (e) {
      res.status(500).json({ erro: 'Erro interno.' });
    }
  });

  // ── /api/webhooks ──
  // 2xx encerra a entrega; qualquer outro status faz a InfinitePay reenviar
  // (a doc recomenda 400). Só falha temporária pede reenvio.
  const webhooks = express.Router();

  webhooks.post('/infinitepay', async (req, res) => {
    // Desativado (homologação): nada é lido nem gravado.
    if (infinitepay.desativado) return res.sendStatus(503);
    const corpo = req.body && typeof req.body === 'object' ? req.body : {};
    const { order_nsu: orderNsu, transaction_nsu: transactionNsu, invoice_slug: slug } = corpo;
    if (typeof orderNsu !== 'string' || !RE_UUID.test(orderNsu)
        || typeof transactionNsu !== 'string' || !RE_ID_EXTERNO.test(transactionNsu)
        || typeof slug !== 'string' || !RE_ID_EXTERNO.test(slug)) {
      return res.sendStatus(200);
    }
    try {
      const pag = await db.pagamentos.findOne({ orderNsu });
      if (!pag) return res.sendStatus(200);
      if (!infinitepay.configurado) return res.sendStatus(503);
      await confirmarPagamento(pag, transactionNsu, slug);
      res.sendStatus(200);
    } catch (e) {
      await log('erro', `InfinitePay: webhook não processado pedido=${orderNsu} (${e instanceof ErroInfinitepay ? e.detalhe : 'interno'})`);
      res.sendStatus(400);
    }
  });

  return { pagamentos, webhooks };
};
