/**
 * AGEMOB — Webhook do Mercado Pago (módulo isolado)
 *
 * Esta é a ÚNICA fonte de verdade para liberar um plano pago.
 * O frontend NUNCA libera o plano sozinho — apenas mostra "processando" até
 * o webhook confirmar e o pedido mudar de status no banco.
 *
 * Fluxo:
 *  1. Mercado Pago envia POST com { type: 'payment', data: { id } }
 *  2. Validamos a assinatura HMAC (x-signature header)
 *  3. Consultamos o pagamento real na API do MP (nunca confiamos só no payload recebido)
 *  4. Buscamos o pedido pelo external_reference
 *  5. Se status === 'approved' → liberamos o plano por N dias
 *  6. Se status === 'rejected' → marcamos pedido como recusado
 *  7. Se status === 'refunded'/'charged_back' → marcamos como estornado e revoga o plano se ainda vigente
 *  8. Sempre respondemos 200 rapidamente (Mercado Pago reenviar se não receber 200)
 */

const express = require('express');
const paymentService = require('../services/paymentService');

module.exports = function webhooksRouter({ db, log }) {
  const router = express.Router();

  router.post('/mercadopago', express.json(), async (req, res) => {
    // Responde 200 imediatamente para o MP não ficar reenviando — processamos async
    res.sendStatus(200);

    try {
      const xSignature = req.headers['x-signature'];
      const xRequestId  = req.headers['x-request-id'];
      const { type, data } = req.body || {};

      if (type !== 'payment' || !data?.id) return; // ignora outros tipos de notificação

      const validacao = paymentService.validarAssinaturaWebhook({
        xSignature, xRequestId, dataId: data.id
      });

      if (!validacao.valido) {
        await log('erro', `Webhook MP com assinatura inválida: ${validacao.erro || 'desconhecido'}`);
        return;
      }
      if (validacao.aviso) {
        await log('aviso', `Webhook MP: ${validacao.aviso}`);
      }

      // Nunca confiar no payload puro — sempre consultar a API oficial
      const pagamentoMP = await paymentService.consultarPagamento(data.id);
      const pedidoId = pagamentoMP.external_reference;
      if (!pedidoId) {
        await log('erro', `Webhook MP sem external_reference: payment_id=${data.id}`);
        return;
      }

      const pedido = await db.pagamentos.findOne({ pedidoId });
      if (!pedido) {
        await log('erro', `Webhook MP: pedido não encontrado no banco: ${pedidoId}`);
        return;
      }

      // Evita reprocessar o mesmo pagamento duas vezes (idempotência)
      if (pedido.transactionId === String(data.id) && pedido.status === mapStatus(pagamentoMP.status)) {
        return; // já processado
      }

      const novoStatus = mapStatus(pagamentoMP.status);
      const metodoPagamento = pagamentoMP.payment_type_id || pagamentoMP.payment_method_id || 'desconhecido';

      await db.pagamentos.update({ pedidoId }, { $set: {
        status: novoStatus,
        transactionId: String(data.id),
        metodoPagamento,
        valorPago: pagamentoMP.transaction_amount,
        parcelas: pagamentoMP.installments || 1,
        dataPagamento: pagamentoMP.date_approved || null,
        atualizadoEm: new Date().toISOString()
      }});

      if (novoStatus === 'aprovado') {
        await liberarPlano(db, log, pedido);
      } else if (novoStatus === 'estornado') {
        await revogarPlanoSeVigente(db, log, pedido);
      }

      await log('pagamento', `Webhook MP processado: pedido=${pedidoId} status=${novoStatus} payment_id=${data.id}`, null, pedido.imobiliariaId);
    } catch (e) {
      await log('erro', `Falha ao processar webhook MP: ${e.message}`);
    }
  });

  return router;
};

function mapStatus(mpStatus) {
  const map = {
    approved: 'aprovado',
    pending:  'pendente',
    in_process: 'pendente',
    rejected: 'recusado',
    cancelled: 'recusado',
    refunded: 'estornado',
    charged_back: 'estornado'
  };
  return map[mpStatus] || 'pendente';
}

/** Libera o plano contratado por N dias a partir da aprovação — sem renovação automática */
async function liberarPlano(db, log, pedido) {
  const venc = new Date();
  venc.setDate(venc.getDate() + (pedido.diasVigencia || 30));

  const plano = await db.planos.findOne({ slug: pedido.planoSlug });

  await db.imobiliarias.update({ _id: pedido.imobiliariaId }, { $set: {
    planoSlug: pedido.planoSlug,
    planoNome: pedido.planoNome,
    limiteAutorizacoes: plano?.limite ?? undefined,
    status: 'ativo',
    ativo: true,
    planoVencimento: venc.toISOString(),
    atualizadoEm: new Date().toISOString()
  }});

  // Sincroniza subscription se existir (compatibilidade com módulo de billing já existente)
  const sub = await db.subscriptions.findOne({ imobiliariaId: pedido.imobiliariaId });
  if (sub) {
    await db.subscriptions.update({ imobiliariaId: pedido.imobiliariaId }, { $set: {
      planoSlug: pedido.planoSlug,
      planoNome: pedido.planoNome,
      status: 'active',
      limiteAutorizacoes: plano?.limite ?? sub.limiteAutorizacoes,
      renewalDate: venc.toISOString(),
      atualizadoEm: new Date().toISOString()
    }});
  }

  await log('pagamento', `Plano liberado: ${pedido.planoNome} (${pedido.periodicidade}) até ${venc.toLocaleDateString('pt-BR')}`, null, pedido.imobiliariaId);
}

/** Se um pagamento for estornado e o plano ainda estiver dentro da vigência paga, revoga */
async function revogarPlanoSeVigente(db, log, pedido) {
  const imob = await db.imobiliarias.findOne({ _id: pedido.imobiliariaId });
  if (!imob) return;
  if (imob.planoSlug !== pedido.planoSlug) return; // já trocou de plano, não mexe

  await db.imobiliarias.update({ _id: pedido.imobiliariaId }, { $set: {
    status: 'suspenso',
    atualizadoEm: new Date().toISOString()
  }});
  await log('pagamento', `Plano revogado por estorno: pedido=${pedido.pedidoId}`, null, pedido.imobiliariaId);
}
