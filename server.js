/**
 * AGEMOB — Servidor (Express + NeDB)
 * API REST · Links Públicos de Autorização
 */
require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const Datastore = require('nedb-promises');
const { gerarAutorizacaoPDF } = require('./services/pdf');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------- Render / Proxies reversos ----------
// Necessário para que req.protocol retorne 'https' corretamente no Render.
// Sem isso, os links gerados sairiam como http:// mesmo em produção.
app.set('trust proxy', 1);

// ---------- Banco de dados ----------
// No Render o filesystem é efêmero — dados são perdidos a cada deploy/restart.
// Para produção persistente, migrar para MongoDB Atlas ou PlanetScale.
// Por ora, o NeDB funciona para demonstração e testes em staging.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = {
  autorizacoes: Datastore.create({ filename: path.join(DATA_DIR, 'autorizacoes.db'), autoload: true }),
  config:       Datastore.create({ filename: path.join(DATA_DIR, 'config.db'),       autoload: true }),
  logs:         Datastore.create({ filename: path.join(DATA_DIR, 'logs.db'),         autoload: true })
};

const IMOBILIARIA = {
  razao:    'Lux House Imóveis Ltda.',
  cnpj:     '48.192.939/0001-21',
  endereco: 'Rua das Algas, 733 - Sala 1, Jurerê Internacional, Florianópolis/SC'
};

const STORAGE_BASE = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const STORAGE = {
  originais: path.join(STORAGE_BASE, 'originais'),
  assinados: path.join(STORAGE_BASE, 'assinados')
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

/**
 * Retorna a BASE_URL do sistema.
 * Prioridade: variável de ambiente BASE_URL > protocolo+host da request.
 * No Render, definir BASE_URL=https://seu-app.onrender.com nas env vars.
 */
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (req) return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:' + PORT;
}

function gerarLinkPublico(codigo, req) {
  return `${getBaseUrl(req)}/autorizacao/${codigo}`;
}

// ---------- Middlewares ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Expõe a BASE_URL resolvida para o frontend
app.get('/api/base-url', (req, res) => {
  res.json({ baseUrl: getBaseUrl(req) });
});

// Health check — usado pelo Render para verificar se o serviço está vivo
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// ---------- Configuração do fluxo de assinatura (etapas V2) ----------
// Persiste no banco para que todos os dispositivos vejam a mesma configuração,
// em vez de localStorage (que é por navegador/dispositivo).
app.get('/api/fluxo-config', async (_req, res) => {
  const doc = await db.config.findOne({ _key: 'fluxo' });
  res.json(doc ? doc.valor : null);
});
app.post('/api/fluxo-config', async (req, res) => {
  try {
    await db.config.update(
      { _key: 'fluxo' },
      { _key: 'fluxo', valor: req.body, atualizadoEm: new Date().toISOString() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Falha ao salvar configuração: ' + e.message });
  }
});

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
    const codigo = genCode();
    const linkPublico = gerarLinkPublico(codigo, req);
    const aut = {
      codigo,
      linkPublico,
      proprietario, imovel,
      tipo:     tipo === 'exclusiva' ? 'exclusiva' : 'simples',
      corretor: corretor || 'Lux House',
      status:   'rascunho',
      criadoEm:     new Date().toISOString(),
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

/** GERAR LINK PÚBLICO para envio ao proprietário */
app.post('/api/autorizacoes/:id/enviar', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ _id: req.params.id });
    if (!aut) return res.status(404).json({ erro: 'Autorização não encontrada.' });
    if (!['rascunho', 'recusado', 'cancelado'].includes(aut.status)) {
      return res.status(422).json({ erro: `Autorização com status "${aut.status}" não pode ser reenviada.` });
    }

    const pdfBuffer = await gerarAutorizacaoPDF(aut, IMOBILIARIA);
    const original  = path.join(STORAGE.originais, `${aut.codigo}_original.pdf`);
    fs.writeFileSync(original, pdfBuffer);

    const linkPublico = aut.linkPublico || gerarLinkPublico(aut.codigo, req);

    await db.autorizacoes.update({ _id: aut._id }, {
      $set: {
        status:      'aguardando',
        linkPublico,
        pdfOriginal:  original,
        enviadoEm:    new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      }
    });
    await log('autorizacao', `Autorização ${aut.codigo} aguardando assinatura`, { linkPublico });
    res.json({ ok: true, status: 'aguardando', linkPublico });
  } catch (e) {
    await log('erro', 'Erro ao gerar link: ' + e.message);
    res.status(500).json({ erro: 'Falha ao gerar o link: ' + e.message });
  }
});

/** Cancelar autorização */
app.post('/api/autorizacoes/:id/cancelar', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ _id: req.params.id });
    if (!aut) return res.status(404).json({ erro: 'Autorização não encontrada.' });
    await db.autorizacoes.update({ _id: aut._id }, {
      $set: { status: 'cancelado', atualizadoEm: new Date().toISOString() }
    });
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
  if (!aut?.pdfAssinado || !fs.existsSync(aut.pdfAssinado)) {
    return res.status(404).json({ erro: 'PDF assinado ainda não disponível.' });
  }
  res.download(aut.pdfAssinado);
});
app.get('/api/autorizacoes/:id/certificado', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ _id: req.params.id });
  if (!aut?.certificado || !fs.existsSync(aut.certificado)) {
    return res.status(404).json({ erro: 'Certificado ainda não disponível.' });
  }
  res.download(aut.certificado);
});

// ---------- Dashboard ----------
app.get('/api/dashboard', async (_req, res) => {
  const lista     = await db.autorizacoes.find({});
  const enviadas  = lista.filter(a => a.enviadoEm).length;
  const assinadas = lista.filter(a => a.status === 'assinado');
  const pendentes = lista.filter(a => ['aguardando', 'visualizado'].includes(a.status)).length;
  const taxa      = enviadas ? Math.round((assinadas.length / enviadas) * 100) : 0;
  const tempos    = assinadas
    .filter(a => a.enviadoEm && a.assinadoEm)
    .map(a => (new Date(a.assinadoEm) - new Date(a.enviadoEm)) / 36e5);
  const tempoMedioH = tempos.length ? (tempos.reduce((s, t) => s + t, 0) / tempos.length) : null;

  res.json({
    total:       lista.length,
    rascunhos:   lista.filter(a => a.status === 'rascunho').length,
    enviadas,
    pendentes,
    visualizadas: lista.filter(a => a.status === 'visualizado').length,
    assinadas:   assinadas.length,
    recusadas:   lista.filter(a => a.status === 'recusado').length,
    canceladas:  lista.filter(a => a.status === 'cancelado').length,
    exclusivas:  lista.filter(a => a.tipo === 'exclusiva').length,
    taxaAssinatura:  taxa,
    tempoMedioHoras: tempoMedioH !== null ? Math.round(tempoMedioH * 10) / 10 : null,
    vgv: lista.reduce((s, a) => s + (a.imovel?.valor || 0), 0)
  })
});

// ---------- Logs ----------
app.get('/api/logs', async (_req, res) => {
  const logs = await db.logs.find({}).sort({ em: -1 }).limit(100);
  res.json(logs);
});

// ---------- SPA catch-all ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  AGEMOB rodando em http://localhost:${PORT}`);
  console.log(`  BASE_URL: ${process.env.BASE_URL || '(automático pelo host da request)'}\n`);
});
