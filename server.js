/**
 * AGEMOB v2 — Plataforma SaaS de Autorizações Imobiliárias
 * Multi-tenant · JWT Auth · Super Admin · RBAC
 */
require('dotenv').config();
const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const Datastore  = require('nedb-promises');
const { gerarAutorizacaoPDF } = require('./services/pdf');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'agemob-dev-secret-mude-em-producao';

app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════
// BANCO DE DADOS — NeDB (multi-tenant por coleção)
// ═══════════════════════════════════════════════════════
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = {
  imobiliarias:  Datastore.create({ filename: path.join(DATA_DIR, 'imobiliarias.db'),  autoload: true }),
  usuarios:      Datastore.create({ filename: path.join(DATA_DIR, 'usuarios.db'),      autoload: true }),
  autorizacoes:  Datastore.create({ filename: path.join(DATA_DIR, 'autorizacoes.db'),  autoload: true }),
  config:        Datastore.create({ filename: path.join(DATA_DIR, 'config.db'),        autoload: true }),
  logs:          Datastore.create({ filename: path.join(DATA_DIR, 'logs.db'),          autoload: true })
};

const STORAGE_BASE = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
['originais','assinados'].forEach(d => fs.mkdirSync(path.join(STORAGE_BASE, d), { recursive: true }));

// ═══════════════════════════════════════════════════════
// SEED — Super Admin + Lux House (só na primeira execução)
// ═══════════════════════════════════════════════════════
async function seed() {
  // Super admin
  const superAdmin = await db.usuarios.findOne({ role: 'super_admin' });
  if (!superAdmin) {
    const hash = await bcrypt.hash(process.env.SUPER_ADMIN_PASS || 'LuxAdmin2026!', 10);
    await db.usuarios.insert({
      nome:  'Super Admin AGEMOB',
      email: process.env.SUPER_ADMIN_EMAIL || 'admin@agemob.com.br',
      senha: hash,
      role:  'super_admin',
      ativo: true,
      criadoEm: new Date().toISOString()
    });
    console.log('  ✓ Super admin criado');
  }
  // Lux House (imobiliária padrão)
  const luxHouse = await db.imobiliarias.findOne({ slug: 'lux-house' });
  if (!luxHouse) {
    const imob = await db.imobiliarias.insert({
      nome:      'Lux House Imóveis',
      slug:      'lux-house',
      cnpj:      '48.192.939/0001-21',
      endereco:  'Rua das Algas, 733 - Sala 1, Jurerê Internacional, Florianópolis/SC',
      email:     'luximobiliariafloripa2@gmail.com',
      corPrimaria: '#04273B',
      corSecundaria: '#C9A227',
      plano:     'pro',
      ativo:     true,
      criadoEm:  new Date().toISOString()
    });
    // Admin da Lux House
    const hash = await bcrypt.hash(process.env.LUX_ADMIN_PASS || 'lux2026', 10);
    await db.usuarios.insert({
      nome:          'Admin Lux House',
      email:         'admin',
      senha:         hash,
      role:          'admin',
      imobiliariaId: imob._id,
      imobiliariaSlug: 'lux-house',
      ativo:         true,
      criadoEm:      new Date().toISOString()
    });
    console.log('  ✓ Lux House criada');
  }
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════
async function log(tipo, mensagem, dados, imobiliariaId) {
  try { await db.logs.insert({ tipo, mensagem, dados: dados||null, imobiliariaId: imobiliariaId||null, em: new Date().toISOString() }); }
  catch(e) { console.error('Log error:', e.message); }
}

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 9; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (req) return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:' + PORT;
}

// ═══════════════════════════════════════════════════════
// MIDDLEWARES
// ═══════════════════════════════════════════════════════
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting — proteção brute force
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { erro: 'Muitas tentativas. Aguarde 15 minutos.' } });
const apiLimiter  = rateLimit({ windowMs: 60 * 1000, max: 100 });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// Middleware JWT — verifica token e injeta req.user
function authMiddleware(roles = []) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ erro: 'Token não fornecido.' });
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.user = payload;
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ erro: 'Acesso negado.' });
      }
      next();
    } catch(e) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }
  };
}

// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════
app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(422).json({ erro: 'E-mail e senha são obrigatórios.' });
  const user = await db.usuarios.findOne({ email: email.toLowerCase().trim(), ativo: true });
  if (!user) return res.status(401).json({ erro: 'Credenciais inválidas.' });
  const ok = await bcrypt.compare(senha, user.senha);
  if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas.' });

  let imobiliaria = null;
  if (user.imobiliariaId) {
    imobiliaria = await db.imobiliarias.findOne({ _id: user.imobiliariaId });
  }

  const token = jwt.sign({
    userId:          user._id,
    nome:            user.nome,
    email:           user.email,
    role:            user.role,
    imobiliariaId:   user.imobiliariaId   || null,
    imobiliariaSlug: user.imobiliariaSlug || null,
    imobiliariaNome: imobiliaria?.nome    || null
  }, JWT_SECRET, { expiresIn: '8h' });

  await log('auth', `Login: ${user.email} (${user.role})`, null, user.imobiliariaId);
  res.json({ token, user: { nome: user.nome, email: user.email, role: user.role, imobiliaria } });
});

app.get('/api/auth/me', authMiddleware(), async (req, res) => {
  const user = await db.usuarios.findOne({ _id: req.user.userId });
  if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
  const { senha, ...safe } = user;
  res.json(safe);
});

// ═══════════════════════════════════════════════════════
// SUPER ADMIN ROUTES — /api/admin/*
// ═══════════════════════════════════════════════════════

// Listar todas as imobiliárias
app.get('/api/admin/imobiliarias', authMiddleware(['super_admin']), async (_req, res) => {
  const lista = await db.imobiliarias.find({}).sort({ criadoEm: -1 });
  // Adiciona contagem de autorizações para cada imobiliária
  const result = await Promise.all(lista.map(async imob => {
    const total = await db.autorizacoes.count({ imobiliariaId: imob._id });
    const assinadas = await db.autorizacoes.count({ imobiliariaId: imob._id, status: 'assinado' });
    return { ...imob, _stats: { total, assinadas } };
  }));
  res.json(result);
});

// Criar nova imobiliária
app.post('/api/admin/imobiliarias', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { nome, cnpj, email, endereco, corPrimaria, plano, adminEmail, adminSenha, adminNome } = req.body;
    if (!nome || !cnpj || !email || !adminEmail || !adminSenha) {
      return res.status(422).json({ erro: 'Nome, CNPJ, e-mail, admin e-mail e senha são obrigatórios.' });
    }
    // Slug a partir do nome
    const slug = nome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const existe = await db.imobiliarias.findOne({ slug });
    if (existe) return res.status(422).json({ erro: 'Já existe uma imobiliária com esse nome.' });

    const imob = await db.imobiliarias.insert({
      nome, cnpj, email, endereco: endereco || '',
      slug,
      corPrimaria:   corPrimaria   || '#04273B',
      corSecundaria: '#C9A227',
      plano:         plano || 'starter',
      ativo:         true,
      criadoEm:      new Date().toISOString(),
      atualizadoEm:  new Date().toISOString()
    });

    // Cria admin da imobiliária
    const hash = await bcrypt.hash(adminSenha, 10);
    await db.usuarios.insert({
      nome:            adminNome || 'Admin',
      email:           adminEmail.toLowerCase().trim(),
      senha:           hash,
      role:            'admin',
      imobiliariaId:   imob._id,
      imobiliariaSlug: slug,
      ativo:           true,
      criadoEm:        new Date().toISOString()
    });

    await log('admin', `Imobiliária criada: ${nome} (${slug})`);
    res.json({ ok: true, imobiliaria: imob });
  } catch(e) {
    res.status(500).json({ erro: 'Falha ao criar imobiliária: ' + e.message });
  }
});

// Editar imobiliária
app.put('/api/admin/imobiliarias/:id', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { nome, cnpj, email, endereco, corPrimaria, plano, ativo } = req.body;
    await db.imobiliarias.update({ _id: req.params.id }, {
      $set: { nome, cnpj, email, endereco, corPrimaria, plano, ativo, atualizadoEm: new Date().toISOString() }
    });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: 'Falha ao atualizar.' });
  }
});

// Desativar/ativar imobiliária
app.patch('/api/admin/imobiliarias/:id/status', authMiddleware(['super_admin']), async (req, res) => {
  const { ativo } = req.body;
  await db.imobiliarias.update({ _id: req.params.id }, { $set: { ativo: !!ativo, atualizadoEm: new Date().toISOString() } });
  res.json({ ok: true });
});

// Métricas globais para o super admin
app.get('/api/admin/metricas', authMiddleware(['super_admin']), async (_req, res) => {
  const imobs   = await db.imobiliarias.count({ ativo: true });
  const total   = await db.autorizacoes.count({});
  const assinadas = await db.autorizacoes.count({ status: 'assinado' });
  const hoje    = new Date(); hoje.setHours(0,0,0,0);
  const hoje30  = new Date(hoje); hoje30.setDate(hoje30.getDate()-30);
  const recentes = await db.autorizacoes.count({ criadoEm: { $gte: hoje30.toISOString() } });
  res.json({ imobiliarias: imobs, autorizacoesTotal: total, autorizacoesAssinadas: assinadas, autorizacoesUltimos30Dias: recentes });
});

// Listar usuários de uma imobiliária
app.get('/api/admin/imobiliarias/:id/usuarios', authMiddleware(['super_admin']), async (req, res) => {
  const lista = await db.usuarios.find({ imobiliariaId: req.params.id });
  res.json(lista.map(({ senha, ...u }) => u));
});

// ═══════════════════════════════════════════════════════
// ROTAS PÚBLICAS (sem auth)
// ═══════════════════════════════════════════════════════
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString(), version: '2.0.0' }));

app.get('/api/base-url', (req, res) => res.json({ baseUrl: getBaseUrl(req) }));

// Buscar dados de uma autorização pelo código (para pré-preencher link assistido)
app.get('/api/autorizacoes/codigo/:codigo', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
  if (!aut) return res.json(null);
  res.json(aut);
});

// Buscar dados da imobiliária pelo slug (para branding no link do proprietário)
app.get('/api/imobiliaria/:slug', async (req, res) => {
  const imob = await db.imobiliarias.findOne({ slug: req.params.slug, ativo: true });
  if (!imob) return res.status(404).json({ erro: 'Imobiliária não encontrada.' });
  // Retorna apenas dados públicos (sem dados sensíveis)
  const { _id, nome, slug, corPrimaria, corSecundaria, endereco } = imob;
  res.json({ _id, nome, slug, corPrimaria, corSecundaria, endereco });
});

// ═══════════════════════════════════════════════════════
// ROTAS AUTENTICADAS — Autorizações (admin + corretor)
// ═══════════════════════════════════════════════════════

// Configuração do fluxo de assinatura (por imobiliária)
app.get('/api/fluxo-config', authMiddleware(['admin','corretor','super_admin']), async (req, res) => {
  const key = `fluxo_${req.user.imobiliariaId || 'global'}`;
  const doc = await db.config.findOne({ _key: key });
  res.json(doc ? doc.valor : null);
});
app.post('/api/fluxo-config', authMiddleware(['admin','super_admin']), async (req, res) => {
  try {
    const key = `fluxo_${req.user.imobiliariaId || 'global'}`;
    await db.config.update({ _key: key }, { _key: key, valor: req.body, atualizadoEm: new Date().toISOString() }, { upsert: true });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar autorizações (filtradas por imobiliária)
app.get('/api/autorizacoes', authMiddleware(['admin','corretor','super_admin']), async (req, res) => {
  const query = req.user.role === 'super_admin' ? {} : { imobiliariaId: req.user.imobiliariaId };
  const lista = await db.autorizacoes.find(query).sort({ criadoEm: -1 });
  res.json(lista);
});

// Criar rascunho (link vazio)
app.post('/api/autorizacoes', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const codigo = genCode();
    const linkPublico = `${getBaseUrl(req)}/autorizacao/${codigo}`;
    const aut = {
      codigo, linkPublico,
      imobiliariaId:   req.user.imobiliariaId,
      imobiliariaSlug: req.user.imobiliariaSlug,
      corretorId:      req.user.userId,
      corretorNome:    req.user.nome,
      status:          'rascunho',
      criadoEm:        new Date().toISOString(),
      atualizadoEm:    new Date().toISOString()
    };
    const salvo = await db.autorizacoes.insert(aut);
    await log('autorizacao', `Link vazio gerado: ${codigo}`, null, req.user.imobiliariaId);
    res.json(salvo);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar rascunho assistido (corretor preenche os dados)
app.post('/api/autorizacoes/rascunho', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const { codigo, proprietario, imovel } = req.body;
    if (!codigo || !proprietario?.nome) return res.status(422).json({ erro: 'Dados incompletos.' });
    const linkPublico = `${getBaseUrl(req)}/autorizacao/${codigo}`;
    const aut = {
      codigo, linkPublico,
      proprietario, imovel,
      tipo:            null,
      status:          'rascunho',
      preenchidoPorCorretor: true,
      imobiliariaId:   req.user.imobiliariaId,
      imobiliariaSlug: req.user.imobiliariaSlug,
      corretorId:      req.user.userId,
      corretorNome:    req.user.nome,
      criadoEm:        new Date().toISOString(),
      atualizadoEm:    new Date().toISOString()
    };
    await db.autorizacoes.insert(aut);
    await log('autorizacao', `Rascunho assistido: ${codigo} (${proprietario.nome})`, null, req.user.imobiliariaId);
    res.json({ ok: true, codigo, linkPublico });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Salvar autorização assinada (chamado pelo proprietário — sem auth)
app.post('/api/autorizacoes/assinar', async (req, res) => {
  try {
    const { codigo, proprietario, imovel, tipo, hash, evidencias, otp, facial, liveness, uploads } = req.body;
    if (!codigo || !proprietario?.nome) return res.status(422).json({ erro: 'Dados incompletos.' });
    const venc = new Date(); venc.setDate(venc.getDate() + 365);
    // Busca rascunho existente para preservar imobiliariaId
    const rascunho = await db.autorizacoes.findOne({ codigo });
    const aut = {
      codigo, proprietario, imovel,
      tipo:          tipo || 'simples',
      status:        'assinado',
      hash:          hash || null,
      evidencias:    evidencias || null,
      validacoes:    { otp: otp||[], facial: facial||null, liveness: liveness||null, uploads: uploads||[] },
      imobiliariaId:   rascunho?.imobiliariaId   || null,
      imobiliariaSlug: rascunho?.imobiliariaSlug || null,
      corretorId:      rascunho?.corretorId      || null,
      corretorNome:    rascunho?.corretorNome    || 'Lux House',
      criadoEm:      new Date().toISOString(),
      assinadoEm:    new Date().toISOString(),
      vencimento:    venc.toLocaleDateString('pt-BR'),
      atualizadoEm:  new Date().toISOString()
    };
    if (rascunho) {
      await db.autorizacoes.update({ codigo }, { $set: { ...aut } });
    } else {
      await db.autorizacoes.insert(aut);
    }
    await log('autorizacao', `Assinada: ${codigo} (${proprietario.nome})`, null, aut.imobiliariaId);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// Cancelar autorização
app.post('/api/autorizacoes/:id/cancelar', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ _id: req.params.id, imobiliariaId: req.user.imobiliariaId });
    if (!aut) return res.status(404).json({ erro: 'Não encontrada.' });
    await db.autorizacoes.update({ _id: aut._id }, { $set: { status: 'cancelado', atualizadoEm: new Date().toISOString() } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Dashboard (por imobiliária)
app.get('/api/dashboard', authMiddleware(['admin','corretor','super_admin']), async (req, res) => {
  const query = req.user.role === 'super_admin' ? {} : { imobiliariaId: req.user.imobiliariaId };
  const lista = await db.autorizacoes.find(query);
  const assinadas = lista.filter(a => a.status === 'assinado');
  res.json({
    total:       lista.length,
    rascunhos:   lista.filter(a => a.status === 'rascunho').length,
    assinadas:   assinadas.length,
    canceladas:  lista.filter(a => a.status === 'cancelado').length,
    exclusivas:  lista.filter(a => a.tipo === 'exclusiva').length,
    vgv:         lista.reduce((s,a) => s + (a.imovel?.valor||0), 0)
  });
});

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

app.post('/api/enviar-email', async (req, res) => {
  try {
    const { destino, assunto, texto, html, nomeImob } = req.body;
    if (!destino || !assunto || (!texto && !html)) return res.status(422).json({ erro: 'Campos obrigatórios.' });
    if (!process.env.BREVO_API_KEY) return res.status(503).json({ erro: 'E-mail não configurado.' });
    await enviarEmailBrevo(destino, assunto, texto, html, nomeImob);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Configuração fluxo pública (para o proprietário buscar sem auth)
app.get('/api/fluxo-config-publico/:slug', async (req, res) => {
  const key = `fluxo_${req.params.slug}`;
  const imob = await db.imobiliarias.findOne({ slug: req.params.slug });
  if (!imob) return res.json(null);
  const doc = await db.config.findOne({ _key: `fluxo_${imob._id}` });
  res.json(doc ? doc.valor : null);
});

// ═══════════════════════════════════════════════════════
// SPA CATCH-ALL
// ═══════════════════════════════════════════════════════
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════
seed().then(() => {
  app.listen(PORT, () => {
    console.log(`\n  AGEMOB v2 rodando em http://localhost:${PORT}`);
    console.log(`  BASE_URL: ${process.env.BASE_URL || '(automático)'}\n`);
  });
}).catch(console.error);
