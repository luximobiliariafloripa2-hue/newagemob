'use strict';

// AGEMOB — cliente HTTP da InfinitePay (checkout por link). M9-02.
//
// Só dois endpoints: POST /links (cria o checkout) e POST /payment_check
// (confirma o pagamento). O webhook da InfinitePay não é assinado: nada aqui
// confia nele — a confirmação é sempre o payment_check com a API key.
//
// Erros saem com código genérico (ErroInfinitepay.codigo); status HTTP e
// motivo ficam em .detalhe, para log. A API key nunca entra em mensagem.

const URL_OFICIAL = 'https://api.checkout.infinitepay.io';
const TIMEOUT_MS = 8000;

class ErroInfinitepay extends Error {
  constructor(codigo, detalhe) {
    super(codigo);
    this.codigo = codigo;
    this.detalhe = detalhe || codigo;
  }
}

// Produção: API key e handle obrigatórios, URL sempre a oficial.
// INFINITEPAY_API_URL só existe para o servidor fake de development/test.
function carregarConfiguracao(env = process.env) {
  const producao = env.NODE_ENV === 'production';
  const apiKey = (env.INFINITEPAY_API_KEY || '').trim();
  const handle = (env.INFINITEPAY_HANDLE || '').trim();
  const urlCustom = (env.INFINITEPAY_API_URL || '').trim();
  if (producao) {
    if (!apiKey) throw new Error('INFINITEPAY_API_KEY_ausente');
    if (!handle) throw new Error('INFINITEPAY_HANDLE_ausente');
    if (urlCustom) throw new Error('INFINITEPAY_API_URL_proibida_em_producao');
  }
  if (handle && !/^[A-Za-z0-9_.-]{1,64}$/.test(handle)) throw new Error('INFINITEPAY_HANDLE_invalido');
  let apiUrl = URL_OFICIAL;
  if (!producao && urlCustom) {
    let u;
    try { u = new URL(urlCustom); } catch { throw new Error('INFINITEPAY_API_URL_invalida'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('INFINITEPAY_API_URL_invalida');
    apiUrl = urlCustom.replace(/\/+$/, '');
  }
  return { configurado: !!(apiKey && handle), apiKey, handle, apiUrl };
}

// O nome do campo da URL na resposta de POST /links não está documentado
// (a doc diz só "a URL do link que vem na resposta"). Isolado aqui para ser
// confirmado no gate real de R$ 1,00; qualquer outro formato falha fechado.
function extrairUrlCheckout(resposta) {
  return resposta && typeof resposta.url === 'string' ? resposta.url : null;
}

// https e host exatamente infinitepay.io ou subdomínio dele — endsWith
// ingênuo aceitaria "fraudeinfinitepay.io".
function validarUrlCheckout(valor) {
  if (typeof valor !== 'string' || valor.length > 2048) return null;
  let u;
  try { u = new URL(valor); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (host !== 'infinitepay.io' && !host.endsWith('.infinitepay.io')) return null;
  return u.href;
}

// Pago só com success && paid, valor original igual ao esperado e valor
// efetivamente pago não menor (parcelado com juros repassados pode ser maior).
function avaliarConfirmacao(resposta, valorCentavos) {
  if (!resposta || typeof resposta !== 'object') return { pago: false, motivo: 'resposta_invalida' };
  if (resposta.success !== true) return { pago: false, motivo: 'success_false' };
  if (resposta.paid !== true) return { pago: false, motivo: 'nao_pago' };
  if (!Number.isInteger(resposta.amount) || resposta.amount !== valorCentavos) return { pago: false, motivo: 'valor_divergente' };
  if (!Number.isInteger(resposta.paid_amount) || resposta.paid_amount < resposta.amount) return { pago: false, motivo: 'valor_pago_menor' };
  const metodo = typeof resposta.capture_method === 'string' ? resposta.capture_method.slice(0, 32) : null;
  return { pago: true, metodo };
}

function criarInfinitepayService(config) {
  async function post(caminho, corpo) {
    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(config.apiUrl + caminho, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.apiKey },
        body: JSON.stringify(corpo),
        signal: controle.signal
      });
    } catch (e) {
      throw new ErroInfinitepay('indisponivel', `${caminho} ${e.name === 'AbortError' ? 'timeout' : 'rede'}`);
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw new ErroInfinitepay('indisponivel', `${caminho} http_${r.status}`);
    try {
      return await r.json();
    } catch {
      throw new ErroInfinitepay('resposta_invalida', `${caminho} json`);
    }
  }

  async function criarLink({ orderNsu, valorCentavos, descricao, redirectUrl, webhookUrl, cliente, validoAte }) {
    if (!config.configurado) throw new ErroInfinitepay('nao_configurado');
    const corpo = {
      handle: config.handle,
      items: [{ quantity: 1, price: valorCentavos, description: descricao }],
      order_nsu: orderNsu,
      redirect_url: redirectUrl,
      webhook_url: webhookUrl,
      options: { single_payment: true, valid_until: validoAte, assured_installments: 0 }
    };
    if (cliente && (cliente.nome || cliente.email)) {
      corpo.customer = {};
      if (cliente.nome) corpo.customer.name = cliente.nome;
      if (cliente.email) corpo.customer.email = cliente.email;
    }
    const resposta = await post('/links', corpo);
    const url = validarUrlCheckout(extrairUrlCheckout(resposta));
    if (!url) throw new ErroInfinitepay('resposta_invalida', '/links url_ausente_ou_invalida');
    return { checkoutUrl: url };
  }

  // Lança ErroInfinitepay só em falha temporária/de transporte; pagamento não
  // confirmado volta como { pago:false, motivo }.
  async function verificarPagamento({ orderNsu, transactionNsu, slug, valorCentavos }) {
    if (!config.configurado) throw new ErroInfinitepay('nao_configurado');
    const resposta = await post('/payment_check', {
      handle: config.handle, order_nsu: orderNsu, transaction_nsu: transactionNsu, slug
    });
    return avaliarConfirmacao(resposta, valorCentavos);
  }

  return { configurado: config.configurado, criarLink, verificarPagamento };
}

module.exports = {
  URL_OFICIAL,
  ErroInfinitepay,
  carregarConfiguracao,
  extrairUrlCheckout,
  validarUrlCheckout,
  avaliarConfirmacao,
  criarInfinitepayService
};
