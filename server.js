/**
 * AGEMOB — Servidor (Express + NeDB)
 * API REST · Integração Clicksign · Webhook · Armazenamento de PDFs
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');
const clicksign = require('./services/clicksign');
const { gerarAutorizacaoPDF } = require('./services/pdf');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Banco de dados ----------
const db = {
  autorizacoes: Datastore.create({ filename: path.join(__dirname, 'data/autorizacoes.db'), autoload: true }),
  config:       Datastore.create({ filename: path.join(__dirname, 'data/config.db'), autoload: true }),
  logs:         Datastore.create({ filename: path.join(__dirname, 'data/logs.db'), autoload: true })
};

const IMOBILIARIA = {
  razao: 'Lux House Imóveis Ltda.',
  cnpj: '48.192.939/0001-21',
  endereco: 'Rua das Algas, 733 - Sala 1, Jurerê Internacional, Florianópolis/SC'
};

const STORAGE = {
  originais: path.join(__dirname, 'storage/originais'),
  assinados: path.join(__dirname, 'storage/assinados')
};
Object.values(STORAGE).forEach(d => fs.mkdirSync(d, { recursive: true }));

async function log(tipo, mensagem, dados) {
  try { await db.logs.insert({ tipo, mensagem, dados: dados || null, em: new Date().toISOString() }); }
  catch (e) { console.error('Falha ao gravar log:', e.message); }
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 9; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

// ---------- Configuração da Clicksign ----------
async function getConfig() {
  const saved = await db.config.findOne({ _tipo: 'clicksign' }) || {};
  return {
    apiKey: saved.apiKey || process.env.CLICKSIGN_API_KEY || '',
    ambiente: saved.ambiente || process.env.CLICKSIGN_AMBIENTE || 'sandbox',
    emailRemetente: saved.emailRemetente || process.env.EMAIL_REMETENTE || '',
    webhookUrl: saved.webhookUrl || process.env.WEBHOOK_URL || '',
    webhookSecret: saved.webhookSecret || process.env.CLICKSIGN_WEBHOOK_SECRET || '',
    autenticacao: saved.autenticacao || 'email',
    prazoDias: saved.prazoDias || 30,
    mensagem: saved.mensagem || 'Olá! Você recebeu sua Autorização de Venda da Lux House Imóveis para assinatura digital.'
  };
}

// ---------- Webhook (RAW body — necessário p/ validação HMAC) ----------
app.post('/api/webhook/clicksign', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  try {
    const cfg = await getConfig();
    const hmacOk = clicksign.validarWebhook(raw, req.headers['content-hmac'], cfg.webhookSecret);
    if (!hmacOk) {
      await log('webhook_rejeitado', 'HMAC inválido', { headers: req.headers['content-hmac'] });
      return res.status(401).json({ erro: 'Assinatura HMAC inválida' });
    }

    const payload = JSON.parse(raw || '{}');
    const evento = payload?.event?.name || payload?.event?.type || payload?.data?.type || 'desconhecido';
    const envelopeId =
      payload?.event?.data?.envelope?.id ||
      payload?.document?.envelope_id ||
      payload?.envelope?.id || null;
    const documentKey = payload?.document?.key || payload?.event?.data?.document?.id || null;

    await log('webhook', `Evento recebido: ${evento}`, { envelopeId, documentKey });

    // Mapeamento de eventos → status do sistema
    const mapa = {
      'upload': 'aguardando', 'add_signer': 'aguardando', 'run': 'aguardando', 'sent': 'aguardando',
      'view': 'visualizado', 'document_viewed': 'visualizado', 'open': 'visualizado',
      'sign': 'assinado', 'close': 'assinado', 'auto_close': 'assinado', 'document_closed': 'assinado',
      'refusal': 'recusado', 'refuse': 'recusado',
      'cancel': 'cancelado', 'deadline': 'cancelado'
    };
    const novoStatus = mapa[evento];

    if (novoStatus) {
      const query = envelopeId ? { 'clicksign.envelopeId': envelopeId } : { 'clicksign.documentId': documentKey };
      const aut = await db.autorizacoes.findOne(query);
      if (aut) {
        const update = { status: novoStatus, atualizadoEm: new Date().toISOString() };
        if (novoStatus === 'visualizado' && !aut.visualizadoEm) update.visualizadoEm = new Date().toISOString();
        if (novoStatus === 'assinado') {
          update.assinadoEm = new Date().toISOString();
          update.ipAssinatura = payload?.event?.data?.signer?.ip || payload?.signer?.ip || null;
        }
        await db.autorizacoes.update({ _id: aut._id }, { $set: update });
        await log('status', `Autorização ${aut.codigo}: ${aut.status} → ${novoStatus}`, { evento });

        // Documento finalizado → busca e salva o PDF assinado + certificado
        if (novoStatus === 'assinado' && aut.clicksign?.envelopeId) {
          baixarAssinado(aut).catch(e => log('erro', 'Falha ao baixar PDF assinado: ' + e.message));
        }
      } else {
        await log('webhook_orfao', 'Evento sem autorização correspondente', { evento, envelopeId });
      }
    }
    res.json({ ok: true });
  } catch (e) {
    await log('erro', 'Erro no webhook: ' + e.message);
    res.status(500).json({ erro: 'Falha ao processar webhook' });
  }
});

async function baixarAssinado(aut) {
  const cfg = await getConfig();
  const docs = await clicksign.obterDocumentos(cfg, aut.clicksign.envelopeId);
  for (const d of docs) {
    const links = d.attributes?.links || d.links || {};
    const urlAssinado = links.signed_file_url || links.signed || null;
    const urlCertificado = links.certificate_url || links.certificate || null;
    const salvar = async (url, sufixo) => {
      if (!url) return null;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`download ${sufixo} HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const file = path.join(STORAGE.assinados, `${aut.codigo}_${sufixo}.pdf`);
      fs.writeFileSync(file, buf);
      return file;
    };
    const arquivoAssinado = await salvar(urlAssinado, 'assinado');
    const arquivoCertificado = await salvar(urlCertificado, 'certificado');
    await db.autorizacoes.update({ _id: aut._id }, {
      $set: { pdfAssinado: arquivoAssinado, certificado: arquivoCertificado }
    });
    await log('arquivo', `PDF assinado/certificado salvos para ${aut.codigo}`);
  }
}

// ---------- Middlewares padrão (após o webhook raw) ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Autorizações ----------
app.get('/api/autorizacoes', async (_req, res) => {
  const lista = await db.autorizacoes.find({}).sort({ criadoEm: -1 });
  res.json(lista);
});

app.post('/api/autorizacoes', async (req, res) => {
  try {
    const { proprietario, imovel, tipo, corretor } = req.body;
    if (!proprietario?.nome || !proprietario?.email || !imovel?.valor) {
      return res.status(422).json({ erro: 'Nome, e-mail do proprietário e valor do imóvel são obrigatórios.' });
    }
    const aut = {
      codigo: genCode(),
      proprietario, imovel,
      tipo: tipo === 'exclusiva' ? 'exclusiva' : 'simples',
      corretor: corretor || 'Lux House',
      status: 'rascunho',
      clicksign: null,
      criadoEm: new Date().toISOString(),
      atualizadoEm: new Date().toISOString()
    };
    const salvo = await db.autorizacoes.insert(aut);
    await log('autorizacao', `Captação criada: ${salvo.codigo} (${proprietario.nome})`);
    res.json(salvo);
  } catch (e) {
    await log('erro', 'Erro ao criar autorização: ' + e.message);
    res.status(500).json({ erro: 'Falha ao criar a autorização.' });
  }
});

/** ENVIAR PARA ASSINATURA — fluxo completo Clicksign */
app.post('/api/autorizacoes/:id/enviar', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ _id: req.params.id });
    if (!aut) return res.status(404).json({ erro: 'Autorização não encontrada.' });
    if (!['rascunho', 'recusado', 'cancelado'].includes(aut.status)) {
      return res.status(422).json({ erro: `Autorização com status "${aut.status}" não pode ser reenviada.` });
    }

    const cfg = await getConfig();
    if (!cfg.apiKey) {
      return res.status(422).json({ erro: 'API Key da Clicksign não configurada. Acesse Configurações.' });
    }

    // 1. Gera o PDF
    const pdfBuffer = await gerarAutorizacaoPDF(aut, IMOBILIARIA);
    const original = path.join(STORAGE.originais, `${aut.codigo}_original.pdf`);
    fs.writeFileSync(original, pdfBuffer);

    // 2-6. Envelope → documento → signatário → requisitos → ativar → notificar
    const ids = await clicksign.enviarParaAssinatura(cfg, {
      nomeEnvelope: `Autorização de Venda ${aut.tipo === 'exclusiva' ? 'com Exclusividade' : ''} — ${aut.proprietario.nome} (${aut.codigo})`,
      filename: `AGEMOB_Autorizacao_${aut.codigo}.pdf`,
      pdfBase64: pdfBuffer.toString('base64'),
      signatario: {
        nome: aut.proprietario.nome,
        email: aut.proprietario.email,
        telefone: aut.proprietario.whatsapp,
        cpf: aut.proprietario.cpf
      },
      mensagem: cfg.mensagem
    });

    await db.autorizacoes.update({ _id: aut._id }, {
      $set: {
        status: 'aguardando',
        clicksign: { ...ids, ambiente: cfg.ambiente },
        pdfOriginal: original,
        enviadoEm: new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      }
    });
    await log('clicksign', `Autorização ${aut.codigo} enviada para assinatura`, ids);
    res.json({ ok: true, status: 'aguardando', clicksign: ids });
  } catch (e) {
    await log('erro', 'Erro ao enviar para Clicksign: ' + e.message, e.payload || null);
    res.status(502).json({ erro: 'Falha na comunicação com a Clicksign: ' + e.message });
  }
});

/** Cancelar processo de assinatura */
app.post('/api/autorizacoes/:id/cancelar', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ _id: req.params.id });
    if (!aut) return res.status(404).json({ erro: 'Autorização não encontrada.' });
    if (aut.clicksign?.envelopeId) {
      const cfg = await getConfig();
      await clicksign.cancelarEnvelope(cfg, aut.clicksign.envelopeId).catch(e => log('erro', 'Cancelamento Clicksign: ' + e.message));
    }
    await db.autorizacoes.update({ _id: aut._id }, { $set: { status: 'cancelado', atualizadoEm: new Date().toISOString() } });
    await log('status', `Autorização ${aut.codigo} cancelada`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao cancelar.' });
  }
});

/** Downloads — PDF original / assinado / certificado */
app.get('/api/autorizacoes/:id/pdf', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ _id: req.params.id });
  if (!aut) return res.status(404).json({ erro: 'Autorização não encontrada.' });
  const buffer = await gerarAutorizacaoPDF(aut, IMOBILIARIA);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename=AGEMOB_Autorizacao_${aut.codigo}.pdf`);
  res.send(buffer);
});
app.get('/api/autorizacoes/:id/pdf-assinado', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ _id: req.params.id });
  if (!aut?.pdfAssinado || !fs.existsSync(aut.pdfAssinado)) return res.status(404).json({ erro: 'PDF assinado ainda não disponível.' });
  res.download(aut.pdfAssinado);
});
app.get('/api/autorizacoes/:id/certificado', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ _id: req.params.id });
  if (!aut?.certificado || !fs.existsSync(aut.certificado)) return res.status(404).json({ erro: 'Certificado ainda não disponível.' });
  res.download(aut.certificado);
});

// ---------- Dashboard ----------
app.get('/api/dashboard', async (_req, res) => {
  const lista = await db.autorizacoes.find({});
  const enviadas = lista.filter(a => a.enviadoEm).length;
  const assinadas = lista.filter(a => a.status === 'assinado');
  const pendentes = lista.filter(a => ['aguardando', 'visualizado'].includes(a.status)).length;
  const taxa = enviadas ? Math.round((assinadas.length / enviadas) * 100) : 0;
  const tempos = assinadas
    .filter(a => a.enviadoEm && a.assinadoEm)
    .map(a => (new Date(a.assinadoEm) - new Date(a.enviadoEm)) / 36e5);
  const tempoMedioH = tempos.length ? (tempos.reduce((s, t) => s + t, 0) / tempos.length) : null;

  res.json({
    total: lista.length,
    rascunhos: lista.filter(a => a.status === 'rascunho').length,
    enviadas,
    pendentes,
    visualizadas: lista.filter(a => a.status === 'visualizado').length,
    assinadas: assinadas.length,
    recusadas: lista.filter(a => a.status === 'recusado').length,
    canceladas: lista.filter(a => a.status === 'cancelado').length,
    exclusivas: lista.filter(a => a.tipo === 'exclusiva').length,
    taxaAssinatura: taxa,
    tempoMedioHoras: tempoMedioH !== null ? Math.round(tempoMedioH * 10) / 10 : null,
    vgv: lista.reduce((s, a) => s + (a.imovel?.valor || 0), 0)
  });
});

// ---------- Configurações (admin) ----------
app.get('/api/config', async (_req, res) => {
  const cfg = await getConfig();
  // Nunca expõe a chave completa ao frontend
  res.json({
    ...cfg,
    apiKey: cfg.apiKey ? '••••••' + cfg.apiKey.slice(-4) : '',
    webhookSecret: cfg.webhookSecret ? '••••••' : '',
    apiKeyConfigurada: !!cfg.apiKey
  });
});
app.post('/api/config', async (req, res) => {
  try {
    const { apiKey, ambiente, emailRemetente, webhookUrl, webhookSecret, autenticacao, prazoDias, mensagem } = req.body;
    const atual = await db.config.findOne({ _tipo: 'clicksign' }) || { _tipo: 'clicksign' };
    const novo = {
      ...atual,
      _tipo: 'clicksign',
      ...(apiKey && !apiKey.startsWith('••') ? { apiKey } : {}),
      ...(webhookSecret && !webhookSecret.startsWith('••') ? { webhookSecret } : {}),
      ambiente: ambiente === 'producao' ? 'producao' : 'sandbox',
      emailRemetente: emailRemetente || '',
      webhookUrl: webhookUrl || '',
      autenticacao: autenticacao || 'email',
      prazoDias: Number(prazoDias) || 30,
      mensagem: mensagem || ''
    };
    if (atual._id) await db.config.update({ _id: atual._id }, novo);
    else await db.config.insert(novo);
    await log('config', 'Configurações da Clicksign atualizadas');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao salvar configurações.' });
  }
});

// ---------- Logs ----------
app.get('/api/logs', async (_req, res) => {
  const logs = await db.logs.find({}).sort({ em: -1 }).limit(100);
  res.json(logs);
});

app.listen(PORT, () => {
  console.log(`\n  AGEMOB rodando em http://localhost:${PORT}`);
  console.log(`  Webhook Clicksign: POST /api/webhook/clicksign\n`);
});
