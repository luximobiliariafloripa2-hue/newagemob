/**
 * AGEMOB — Serviço de integração com a Clicksign (API v3 / Envelopes)
 * Documentação: https://developers.clicksign.com
 *
 * Credenciais NUNCA vão ao frontend. São lidas da configuração
 * salva no banco (área administrativa) ou de variáveis de ambiente.
 */
const crypto = require('crypto');

function baseUrl(ambiente) {
  return ambiente === 'producao'
    ? 'https://app.clicksign.com'
    : 'https://sandbox.clicksign.com';
}

function headers(apiKey) {
  return {
    'Authorization': apiKey,
    'Content-Type': 'application/vnd.api+json',
    'Accept': 'application/vnd.api+json'
  };
}

async function request(cfg, method, path, body) {
  const url = baseUrl(cfg.ambiente) + path;
  const res = await fetch(url, {
    method,
    headers: headers(cfg.apiKey),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* resposta não-JSON */ }
  if (!res.ok) {
    const msg = (json && JSON.stringify(json.errors || json)) || text || res.statusText;
    const err = new Error(`Clicksign ${method} ${path} → HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

/** 1. Cria o envelope */
async function criarEnvelope(cfg, nome) {
  const body = {
    data: {
      type: 'envelopes',
      attributes: {
        name: nome,
        locale: 'pt-BR',
        auto_close: true,
        ...(cfg.prazoDias ? { deadline_at: new Date(Date.now() + cfg.prazoDias * 864e5).toISOString() } : {})
      }
    }
  };
  const r = await request(cfg, 'POST', '/api/v3/envelopes', body);
  return r.data.id;
}

/** 2. Anexa o documento PDF (base64) ao envelope */
async function adicionarDocumento(cfg, envelopeId, filename, pdfBase64) {
  const body = {
    data: {
      type: 'documents',
      attributes: {
        filename,
        content_base64: `data:application/pdf;base64,${pdfBase64}`
      }
    }
  };
  const r = await request(cfg, 'POST', `/api/v3/envelopes/${envelopeId}/documents`, body);
  return r.data.id;
}

/** 3. Adiciona o signatário (proprietário) */
async function adicionarSignatario(cfg, envelopeId, { nome, email, telefone, cpf }) {
  const attributes = {
    name: nome,
    email,
    ...(telefone ? { phone_number: telefone.replace(/\D/g, '') } : {}),
    ...(cpf ? { has_documentation: true, documentation: cpf } : {}),
    refusable: true
  };
  const body = { data: { type: 'signers', attributes } };
  const r = await request(cfg, 'POST', `/api/v3/envelopes/${envelopeId}/signers`, body);
  return r.data.id;
}

/** 4. Requisitos: qualificação (assinar) + autenticação (e-mail) */
async function adicionarRequisitos(cfg, envelopeId, documentId, signerId) {
  const rel = {
    document: { data: { type: 'documents', id: documentId } },
    signer: { data: { type: 'signers', id: signerId } }
  };
  await request(cfg, 'POST', `/api/v3/envelopes/${envelopeId}/requirements`, {
    data: { type: 'requirements', attributes: { action: 'agree', role: 'sign' }, relationships: rel }
  });
  await request(cfg, 'POST', `/api/v3/envelopes/${envelopeId}/requirements`, {
    data: { type: 'requirements', attributes: { action: 'provide_evidence', auth: cfg.autenticacao || 'email' }, relationships: rel }
  });
}

/** 5. Ativa o envelope (status: running) */
async function ativarEnvelope(cfg, envelopeId) {
  await request(cfg, 'PATCH', `/api/v3/envelopes/${envelopeId}`, {
    data: { type: 'envelopes', id: envelopeId, attributes: { status: 'running' } }
  });
}

/** 6. Dispara as notificações por e-mail aos signatários */
async function notificarSignatarios(cfg, envelopeId, mensagem) {
  await request(cfg, 'POST', `/api/v3/envelopes/${envelopeId}/notifications`, {
    data: { type: 'notifications', attributes: { message: mensagem || 'Você recebeu uma Autorização de Venda para assinatura.' } }
  });
}

/** Consulta documentos do envelope (para obter o PDF assinado / certificado) */
async function obterDocumentos(cfg, envelopeId) {
  const r = await request(cfg, 'GET', `/api/v3/envelopes/${envelopeId}/documents`);
  return r.data || [];
}

/** Cancela o envelope */
async function cancelarEnvelope(cfg, envelopeId) {
  await request(cfg, 'PATCH', `/api/v3/envelopes/${envelopeId}`, {
    data: { type: 'envelopes', id: envelopeId, attributes: { status: 'canceled' } }
  });
}

/**
 * Fluxo completo: envelope → documento → signatário → requisitos → ativar → notificar
 * Retorna os IDs gerados na Clicksign.
 */
async function enviarParaAssinatura(cfg, { nomeEnvelope, filename, pdfBase64, signatario, mensagem }) {
  const envelopeId = await criarEnvelope(cfg, nomeEnvelope);
  const documentId = await adicionarDocumento(cfg, envelopeId, filename, pdfBase64);
  const signerId = await adicionarSignatario(cfg, envelopeId, signatario);
  await adicionarRequisitos(cfg, envelopeId, documentId, signerId);
  await ativarEnvelope(cfg, envelopeId);
  await notificarSignatarios(cfg, envelopeId, mensagem);
  return { envelopeId, documentId, signerId };
}

/** Validação HMAC SHA-256 do webhook (header Content-Hmac: sha256=<hex>) */
function validarWebhook(rawBody, headerHmac, secret) {
  if (!secret) return true; // segredo não configurado → aceita, mas registra em log
  if (!headerHmac) return false;
  const esperado = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(headerHmac));
  } catch (_) {
    return false;
  }
}

module.exports = {
  enviarParaAssinatura,
  obterDocumentos,
  cancelarEnvelope,
  validarWebhook,
  baseUrl
};
