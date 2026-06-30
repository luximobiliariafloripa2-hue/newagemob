/**
 * AGEMOB — Payment Service
 * Wrapper isolado do SDK Mercado Pago. Pagamento único (sem assinatura recorrente).
 *
 * Suporta:
 *  - Cartão de crédito (via Checkout Bricks no frontend — tokenizado, nunca toca o servidor)
 *  - PIX (QR Code + copia-e-cola)
 *  - Boleto bancário
 *  - Parcelamento em até 12x no plano anual (Mercado Pago repassa o valor integral
 *    ao lojista de uma vez, descontando apenas a taxa — o parcelamento é cobrado do
 *    comprador pela operadora do cartão, não afeta o caixa do AGEMOB)
 *
 * CONFIGURAÇÃO NECESSÁRIA (variáveis de ambiente):
 *   MP_ACCESS_TOKEN   — Access Token do Mercado Pago (sandbox ou produção)
 *   MP_PUBLIC_KEY     — Public Key do Mercado Pago (usada no frontend/Bricks)
 *   MP_WEBHOOK_SECRET — Secret para validar assinatura do webhook (gerado no painel MP)
 *
 * Enquanto essas variáveis não forem configuradas, o sistema funciona normalmente
 * mas as rotas de pagamento retornam erro amigável informando que o gateway
 * ainda não foi configurado — não quebra nenhuma outra funcionalidade.
 */

const { MercadoPagoConfig, Payment, Preference } = require('mercadopago');
const crypto = require('crypto');

const MP_ACCESS_TOKEN   = process.env.MP_ACCESS_TOKEN   || '';
const MP_PUBLIC_KEY     = process.env.MP_PUBLIC_KEY     || '';
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || '';

const isConfigured = () => !!MP_ACCESS_TOKEN;

let mpClient = null;
function getClient() {
  if (!isConfigured()) return null;
  if (!mpClient) {
    mpClient = new MercadoPagoConfig({
      accessToken: MP_ACCESS_TOKEN,
      options: { timeout: 8000 }
    });
  }
  return mpClient;
}

/**
 * Catálogo de planos pagos — mensal e anual.
 * Valores em reais. O plano anual oferece desconto implícito (10 meses pelo preço de 12 seria
 * o oposto do que queremos — aqui aplicamos um desconto de ~15% no anual, ajustável).
 */
const PLAN_CATALOG = {
  start:     { nome: 'Start',     mensal: 29.90,  anual: 299.00,  diasMensal: 30, diasAnual: 365 },
  pro:       { nome: 'Pro',       mensal: 49.90,  anual: 499.00,  diasMensal: 30, diasAnual: 365 },
  prime:     { nome: 'Prime',     mensal: 79.90,  anual: 799.00,  diasMensal: 30, diasAnual: 365 },
};

function getPlanoPreco(planoSlug, periodicidade) {
  const plano = PLAN_CATALOG[planoSlug];
  if (!plano) return null;
  return {
    nome:  plano.nome,
    valor: periodicidade === 'anual' ? plano.anual : plano.mensal,
    dias:  periodicidade === 'anual' ? plano.diasAnual : plano.diasMensal
  };
}

/**
 * Cria uma Preference do Mercado Pago — usada para checkout completo
 * (redireciona o usuário para a tela de pagamento hospedada pelo MP,
 * que já suporta cartão, PIX e boleto nativamente).
 *
 * external_reference carrega o ID interno do pedido AGEMOB, para que o webhook
 * consiga relacionar a notificação de volta ao pedido correto.
 */
async function criarPreferencia({ pedidoId, planoSlug, periodicidade, valor, parcelas, email, nome, baseUrl }) {
  const client = getClient();
  if (!client) throw new Error('Gateway de pagamento não configurado. Adicione MP_ACCESS_TOKEN.');

  const plano = PLAN_CATALOG[planoSlug];
  if (!plano) throw new Error('Plano inválido.');

  const preference = new Preference(client);

  const body = {
    items: [{
      id: `${planoSlug}-${periodicidade}`,
      title: `AGEMOB — Plano ${plano.nome} (${periodicidade === 'anual' ? 'Anual' : 'Mensal'})`,
      quantity: 1,
      unit_price: Number(valor),
      currency_id: 'BRL'
    }],
    payer: { email, name: nome },
    external_reference: pedidoId,
    payment_methods: {
      // Parcelamento só faz sentido no plano anual; mensal é à vista
      installments: periodicidade === 'anual' ? 12 : 1,
      default_installments: 1
    },
    back_urls: {
      success: `${baseUrl}/checkout-resultado.html?status=success&pedido=${pedidoId}`,
      pending: `${baseUrl}/checkout-resultado.html?status=pending&pedido=${pedidoId}`,
      failure: `${baseUrl}/checkout-resultado.html?status=failure&pedido=${pedidoId}`
    },
    auto_return: 'approved',
    notification_url: `${baseUrl}/api/webhooks/mercadopago`,
    statement_descriptor: 'AGEMOB'
  };

  const result = await preference.create({ body });
  return {
    preferenceId: result.id,
    initPoint: result.init_point,
    sandboxInitPoint: result.sandbox_init_point
  };
}

/** Consulta um pagamento específico pelo ID (usado pelo webhook para confirmar status real) */
async function consultarPagamento(paymentId) {
  const client = getClient();
  if (!client) throw new Error('Gateway de pagamento não configurado.');
  const payment = new Payment(client);
  return payment.get({ id: paymentId });
}

/**
 * Valida a assinatura HMAC do webhook do Mercado Pago.
 * Documentação: https://www.mercadopago.com.br/developers/pt/docs/your-integrations/notifications/webhooks
 * Se MP_WEBHOOK_SECRET não estiver configurado, pula a validação (modo sandbox/dev)
 * mas registra aviso — não deve ficar assim em produção.
 */
function validarAssinaturaWebhook({ xSignature, xRequestId, dataId }) {
  if (!MP_WEBHOOK_SECRET) return { valido: true, aviso: 'MP_WEBHOOK_SECRET não configurado — validação pulada (modo dev).' };
  if (!xSignature) return { valido: false, erro: 'Header x-signature ausente.' };

  try {
    const parts = xSignature.split(',').reduce((acc, p) => {
      const [k, v] = p.split('=');
      acc[k.trim()] = v?.trim();
      return acc;
    }, {});
    const ts = parts.ts;
    const hash = parts.v1;
    if (!ts || !hash) return { valido: false, erro: 'Formato de assinatura inválido.' };

    const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET).update(manifest).digest('hex');

    return { valido: hmac === hash };
  } catch (e) {
    return { valido: false, erro: e.message };
  }
}

module.exports = {
  isConfigured,
  getPublicKey: () => MP_PUBLIC_KEY,
  PLAN_CATALOG,
  getPlanoPreco,
  criarPreferencia,
  consultarPagamento,
  validarAssinaturaWebhook
};
