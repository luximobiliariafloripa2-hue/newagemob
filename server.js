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
  planos:        Datastore.create({ filename: path.join(DATA_DIR, 'planos.db'),        autoload: true }),
  pacotes:       Datastore.create({ filename: path.join(DATA_DIR, 'pacotes.db'),       autoload: true }),
  compras:       Datastore.create({ filename: path.join(DATA_DIR, 'compras.db'),       autoload: true }),
  config:        Datastore.create({ filename: path.join(DATA_DIR, 'config.db'),        autoload: true }),
  logs:          Datastore.create({ filename: path.join(DATA_DIR, 'logs.db'),          autoload: true })
};

const STORAGE_BASE = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
['originais','assinados'].forEach(d => fs.mkdirSync(path.join(STORAGE_BASE, d), { recursive: true }));

// ═══════════════════════════════════════════════════════
// SEED — Super Admin + Planos + Pacotes + Lux House
// ═══════════════════════════════════════════════════════
async function seed() {
  // Super admin
  const superAdmin = await db.usuarios.findOne({ role: 'super_admin' });
  if (!superAdmin) {
    const hash = await bcrypt.hash(process.env.SUPER_ADMIN_PASS || 'LuxAdmin2026!', 10);
    await db.usuarios.insert({
      nome: 'Super Admin AGEMOB', email: process.env.SUPER_ADMIN_EMAIL || 'admin@agemob.com.br',
      senha: hash, role: 'super_admin', ativo: true, criadoEm: new Date().toISOString()
    });
    console.log('  ✓ Super admin criado');
  }

  // Planos padrão
  const planoCount = await db.planos.count({});
  if (planoCount === 0) {
    for (const p of [
      { slug:'basic', nome:'Basic', limite:15, valor:0, ativo:true },
      { slug:'pro', nome:'Pro', limite:30, valor:0, ativo:true },
      { slug:'premium', nome:'Premium', limite:50, valor:0, ativo:true },
      { slug:'enterprise', nome:'Enterprise', limite:100, valor:0, ativo:true },
      { slug:'unlimited', nome:'Unlimited', limite:-1, valor:0, ativo:true }
    ]) await db.planos.insert({ ...p, criadoEm: new Date().toISOString() });
    console.log('  ✓ Planos criados');
  }

  // Pacotes de créditos padrão
  const pacoteCount = await db.pacotes.count({});
  if (pacoteCount === 0) {
    for (const p of [
      { nome:'Starter', quantidade:5, valor:0, ativo:true },
      { nome:'Growth', quantidade:10, valor:0, ativo:true },
      { nome:'Business', quantidade:20, valor:0, ativo:true },
      { nome:'Max', quantidade:50, valor:0, ativo:true }
    ]) await db.pacotes.insert({ ...p, criadoEm: new Date().toISOString() });
    console.log('  ✓ Pacotes criados');
  }

  // Lux House
  const luxHouse = await db.imobiliarias.findOne({ slug: 'lux-house' });
  if (!luxHouse) {
    const plano = await db.planos.findOne({ slug: 'pro' });
    const imob = await db.imobiliarias.insert({
      tipoCliente:'imobiliaria', nome:'Lux House Imóveis',
      razaoSocial:'Lux House Imóveis Ltda.', nomeFantasia:'Lux House Imóveis',
      slug:'lux-house', cnpj:'48.192.939/0001-21', creci:'', telefone:'', whatsapp:'',
      email:'luximobiliariafloripa2@gmail.com', site:'',
      endereco:{ cep:'', logradouro:'Rua das Algas', numero:'733',
        complemento:'Sala 1', bairro:'Jurerê Internacional', cidade:'Florianópolis', estado:'SC' },
      responsavel:{ nome:'Bruno Amorim Costa', cpf:'', creci:'', telefone:'', whatsapp:'', email:'luximobiliariafloripa2@gmail.com' },
      corPrimaria:'#04273B', corSecundaria:'#C9A227',
      planoId: plano?._id||null, planoSlug:'pro', planoNome:'Pro',
      limiteAutorizacoes:30, creditosExtras:0, status:'ativo', ativo:true,
      criadoEm: new Date().toISOString()
    });
    const hash = await bcrypt.hash(process.env.LUX_ADMIN_PASS || 'lux2026', 10);
    await db.usuarios.insert({
      nome:'Admin Lux House', email:'admin', senha:hash, role:'admin',
      imobiliariaId:imob._id, imobiliariaSlug:'lux-house', ativo:true, criadoEm:new Date().toISOString()
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

// Criar novo cliente (Imobiliária PJ ou Corretor Autônomo)
app.post('/api/admin/imobiliarias', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const {
      tipoCliente, nome, razaoSocial, nomeFantasia, cnpj, cpf, creci,
      telefone, whatsapp, email, site, endereco, responsavel,
      corPrimaria, planoId, adminEmail, adminSenha, adminNome, status
    } = req.body;

    // Validações básicas
    if (!nome || !email || !adminEmail || !adminSenha) {
      return res.status(422).json({ erro: 'Nome, e-mail, e-mail de admin e senha são obrigatórios.' });
    }
    if (tipoCliente === 'imobiliaria' && !cnpj) {
      return res.status(422).json({ erro: 'CNPJ obrigatório para imobiliárias.' });
    }
    if (tipoCliente === 'corretor' && !cpf) {
      return res.status(422).json({ erro: 'CPF obrigatório para corretores autônomos.' });
    }

    // Duplicidade
    if (cnpj) { const ex = await db.imobiliarias.findOne({ cnpj }); if(ex) return res.status(422).json({ erro: 'CNPJ já cadastrado.' }); }
    if (cpf)  { const ex = await db.imobiliarias.findOne({ cpf });  if(ex) return res.status(422).json({ erro: 'CPF já cadastrado.' }); }
    if (creci){ const ex = await db.imobiliarias.findOne({ creci }); if(ex) return res.status(422).json({ erro: 'CRECI já cadastrado.' }); }

    // Busca plano
    let plano = null;
    if (planoId) plano = await db.planos.findOne({ _id: planoId });
    if (!plano) plano = await db.planos.findOne({ slug: 'pro' });

    const slug = nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
               + '-' + Date.now().toString(36);

    const imob = await db.imobiliarias.insert({
      tipoCliente:    tipoCliente || 'imobiliaria',
      nome, razaoSocial: razaoSocial || nome, nomeFantasia: nomeFantasia || nome,
      slug, cnpj: cnpj||'', cpf: cpf||'', creci: creci||'',
      telefone: telefone||'', whatsapp: whatsapp||'', email, site: site||'',
      endereco:   endereco   || {},
      responsavel: responsavel || {},
      corPrimaria: corPrimaria || '#04273B', corSecundaria: '#C9A227',
      planoId: plano?._id||null, planoSlug: plano?.slug||'pro', planoNome: plano?.nome||'Pro',
      limiteAutorizacoes: plano?.limite ?? 30,
      creditosExtras: 0,
      status: status || 'ativo',
      ativo: true,
      criadoEm:     new Date().toISOString(),
      atualizadoEm: new Date().toISOString()
    });

    const hash = await bcrypt.hash(adminSenha, 10);
    await db.usuarios.insert({
      nome: adminNome || nome, email: adminEmail.toLowerCase().trim(),
      senha: hash, role: 'admin',
      imobiliariaId: imob._id, imobiliariaSlug: slug,
      ativo: true, criadoEm: new Date().toISOString()
    });

    await log('admin', `Cliente criado: ${nome} (${tipoCliente||'imobiliaria'})`);
    res.json({ ok: true, imobiliaria: imob });
  } catch(e) {
    res.status(500).json({ erro: 'Falha ao criar cliente: ' + e.message });
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
// HELPERS SAAS — Controle de limite e créditos
// ═══════════════════════════════════════════════════════
async function verificarLimite(imobiliariaId) {
  const imob = await db.imobiliarias.findOne({ _id: imobiliariaId });
  if (!imob) return { ok: false, erro: 'Imobiliária não encontrada.' };
  if (imob.status === 'suspenso') return { ok: false, erro: 'Conta suspensa. Entre em contato com o suporte.' };
  if (imob.status === 'inativo') return { ok: false, erro: 'Conta inativa.' };

  // Unlimited — sem limite
  if (imob.limiteAutorizacoes === -1) return { ok: true };

  // Conta autorizações do mês atual
  const now = new Date();
  const inicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const usadas = await db.autorizacoes.count({
    imobiliariaId,
    criadoEm: { $gte: inicio }
  });

  const limite = imob.limiteAutorizacoes || 0;
  const extras = imob.creditosExtras || 0;

  if (usadas < limite) return { ok: true, usadas, limite, extras, tipo: 'plano' };
  if (usadas < limite + extras) return { ok: true, usadas, limite, extras, tipo: 'credito_extra' };

  return {
    ok: false,
    erro: 'Você atingiu o limite de autorizações do seu plano. Adquira créditos adicionais ou faça upgrade.',
    usadas, limite, extras
  };
}

async function consumirCredito(imobiliariaId, tipo) {
  if (tipo === 'credito_extra') {
    await db.imobiliarias.update({ _id: imobiliariaId }, { $inc: { creditosExtras: -1 } });
  }
}

function calcularPorcentagem(usadas, limite) {
  if (limite === -1) return 0;
  return Math.round((usadas / Math.max(limite, 1)) * 100);
}

// ═══════════════════════════════════════════════════════
// PLANOS — CRUD
// ═══════════════════════════════════════════════════════
app.get('/api/admin/planos', authMiddleware(['super_admin']), async (_req, res) => {
  const lista = await db.planos.find({}).sort({ limite: 1 });
  res.json(lista);
});

app.post('/api/admin/planos', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { nome, limite, valor } = req.body;
    if (!nome || limite === undefined) return res.status(422).json({ erro: 'Nome e limite são obrigatórios.' });
    const slug = nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const plano = await db.planos.insert({ slug, nome, limite: parseInt(limite), valor: parseFloat(valor||0), ativo: true, criadoEm: new Date().toISOString() });
    res.json(plano);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.put('/api/admin/planos/:id', authMiddleware(['super_admin']), async (req, res) => {
  const { nome, limite, valor, ativo } = req.body;
  await db.planos.update({ _id: req.params.id }, { $set: { nome, limite: parseInt(limite), valor: parseFloat(valor||0), ativo, atualizadoEm: new Date().toISOString() } });
  res.json({ ok: true });
});

app.delete('/api/admin/planos/:id', authMiddleware(['super_admin']), async (req, res) => {
  await db.planos.remove({ _id: req.params.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// PACOTES DE CRÉDITOS — CRUD
// ═══════════════════════════════════════════════════════
app.get('/api/admin/pacotes', authMiddleware(['super_admin']), async (_req, res) => {
  res.json(await db.pacotes.find({}).sort({ quantidade: 1 }));
});

app.get('/api/pacotes', async (_req, res) => {
  res.json(await db.pacotes.find({ ativo: true }).sort({ quantidade: 1 }));
});

app.post('/api/admin/pacotes', authMiddleware(['super_admin']), async (req, res) => {
  const { nome, quantidade, valor } = req.body;
  if (!nome || !quantidade) return res.status(422).json({ erro: 'Nome e quantidade obrigatórios.' });
  const pacote = await db.pacotes.insert({ nome, quantidade: parseInt(quantidade), valor: parseFloat(valor||0), ativo: true, criadoEm: new Date().toISOString() });
  res.json(pacote);
});

app.put('/api/admin/pacotes/:id', authMiddleware(['super_admin']), async (req, res) => {
  const { nome, quantidade, valor, ativo } = req.body;
  await db.pacotes.update({ _id: req.params.id }, { $set: { nome, quantidade: parseInt(quantidade), valor: parseFloat(valor||0), ativo, atualizadoEm: new Date().toISOString() } });
  res.json({ ok: true });
});

app.delete('/api/admin/pacotes/:id', authMiddleware(['super_admin']), async (req, res) => {
  await db.pacotes.remove({ _id: req.params.id });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// CRÉDITOS — Operações manuais pelo Super Admin
// ═══════════════════════════════════════════════════════
app.post('/api/admin/imobiliarias/:id/creditos', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { quantidade, motivo } = req.body;
    if (!quantidade) return res.status(422).json({ erro: 'Quantidade obrigatória.' });
    const imob = await db.imobiliarias.findOne({ _id: req.params.id });
    if (!imob) return res.status(404).json({ erro: 'Não encontrada.' });
    const novoSaldo = (imob.creditosExtras || 0) + parseInt(quantidade);
    await db.imobiliarias.update({ _id: req.params.id }, { $set: { creditosExtras: novoSaldo, atualizadoEm: new Date().toISOString() } });
    await db.compras.insert({
      imobiliariaId: req.params.id,
      tipo: 'manual',
      quantidade: parseInt(quantidade),
      motivo: motivo || 'Crédito manual pelo admin',
      statusPagamento: 'aprovado',
      criadoEm: new Date().toISOString()
    });
    await log('credito', `Crédito manual: +${quantidade} para ${imob.nome}. Motivo: ${motivo||'—'}`);
    res.json({ ok: true, novoSaldo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Alterar plano de uma imobiliária
app.patch('/api/admin/imobiliarias/:id/plano', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { planoId } = req.body;
    const plano = await db.planos.findOne({ _id: planoId });
    if (!plano) return res.status(404).json({ erro: 'Plano não encontrado.' });
    await db.imobiliarias.update({ _id: req.params.id }, {
      $set: { planoId, planoSlug: plano.slug, planoNome: plano.nome, limiteAutorizacoes: plano.limite, atualizadoEm: new Date().toISOString() }
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// SUPER ADMIN — Cadastro expandido de imobiliária
// ═══════════════════════════════════════════════════════
// Validação de CPF
function validarCPF(cpf) {
  const c = cpf.replace(/\D/g,'');
  if (c.length !== 11 || /^(\d)+$/.test(c)) return false;
  let s = 0; for(let i=0;i<9;i++) s += +c[i]*(10-i);
  let r = s%11<2?0:11-s%11; if(r!==+c[9]) return false;
  s=0; for(let i=0;i<10;i++) s+=+c[i]*(11-i);
  r=s%11<2?0:11-s%11; return r===+c[10];
}
function validarCNPJ(cnpj) {
  const c = cnpj.replace(/\D/g,'');
  if (c.length !== 14 || /^(\d)+$/.test(c)) return false;
  const calc = (c, n) => { let s=0,p=n-7; for(let i=0;i<n-1;i++){s+=+c[i]*(p--); if(p<2)p=9;} const r=s%11; return r<2?0:11-r; };
  return calc(c,10)===+c[9] && calc(c,11)===+c[10];
}

// ═══════════════════════════════════════════════════════
// DASHBOARD SAAS — Uso do plano por imobiliária
// ═══════════════════════════════════════════════════════
app.get('/api/uso-plano', authMiddleware(['admin','corretor']), async (req, res) => {
  const imob = await db.imobiliarias.findOne({ _id: req.user.imobiliariaId });
  if (!imob) return res.status(404).json({ erro: 'Não encontrada.' });
  const now = new Date();
  const inicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const usadas = await db.autorizacoes.count({ imobiliariaId: req.user.imobiliariaId, criadoEm: { $gte: inicio } });
  const limite = imob.limiteAutorizacoes || 0;
  const extras = imob.creditosExtras || 0;
  const pct = calcularPorcentagem(usadas, limite);
  res.json({
    planoNome: imob.planoNome || imob.planoSlug || 'Pro',
    limite, usadas, disponiveis: Math.max(0, limite - usadas + extras),
    creditosExtras: extras, pct,
    alerta: pct >= 100 ? 'critico' : pct >= 90 ? 'urgente' : pct >= 80 ? 'aviso' : null
  });
});

// Métricas globais ampliadas
app.get('/api/admin/metricas', authMiddleware(['super_admin']), async (_req, res) => {
  const imobs   = await db.imobiliarias.find({});
  const total   = await db.autorizacoes.count({});
  const assinadas = await db.autorizacoes.count({ status: 'assinado' });
  const now = new Date();
  const inicio30 = new Date(now.getFullYear(), now.getMonth(), 1);
  inicio30.setDate(inicio30.getDate() - 30);
  const recentes = await db.autorizacoes.count({ criadoEm: { $gte: inicio30.toISOString() } });

  // Por plano
  const porPlano = {};
  for (const imob of imobs) {
    const slug = imob.planoSlug || 'pro';
    porPlano[slug] = (porPlano[slug] || 0) + 1;
  }

  // Imobiliárias próximas do limite
  const alertas = [];
  for (const imob of imobs.filter(i => i.ativo && i.status === 'ativo')) {
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const usadas = await db.autorizacoes.count({ imobiliariaId: imob._id, criadoEm: { $gte: mesInicio } });
    const pct = calcularPorcentagem(usadas, imob.limiteAutorizacoes || 0);
    if (pct >= 80) alertas.push({ nome: imob.nome, pct, usadas, limite: imob.limiteAutorizacoes });
  }

  res.json({
    imobiliariasAtivas: imobs.filter(i => i.ativo && i.tipoCliente==='imobiliaria').length,
    corretoresAtivos:   imobs.filter(i => i.ativo && i.tipoCliente==='corretor').length,
    clientesAtivos:     imobs.filter(i => i.ativo).length,
    clientesSuspensos:  imobs.filter(i => i.status==='suspenso').length,
    autorizacoesTotal:  total,
    autorizacoesAssinadas: assinadas,
    autorizacoesUltimos30Dias: recentes,
    porPlano,
    alertasLimite: alertas.sort((a,b) => b.pct - a.pct)
  });
});

// Ranking de utilização
app.get('/api/admin/ranking', authMiddleware(['super_admin']), async (_req, res) => {
  const imobs = await db.imobiliarias.find({ ativo: true });
  const now = new Date();
  const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const ranking = [];
  for (const imob of imobs) {
    const usadas = await db.autorizacoes.count({ imobiliariaId: imob._id, criadoEm: { $gte: mesInicio } });
    const pct = calcularPorcentagem(usadas, imob.limiteAutorizacoes || 0);
    ranking.push({ nome: imob.nome, plano: imob.planoNome||'Pro', usadas, limite: imob.limiteAutorizacoes, pct });
  }
  res.json(ranking.sort((a,b) => b.usadas - a.usadas).slice(0, 10));
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

// Criar rascunho (link vazio) — com verificação de limite
app.post('/api/autorizacoes', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const limite = await verificarLimite(req.user.imobiliariaId);
    if (!limite.ok) return res.status(402).json({ erro: limite.erro, usadas: limite.usadas, limiteTotal: (limite.limite||0)+(limite.extras||0) });
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
    if (limite.tipo === 'credito_extra') await consumirCredito(req.user.imobiliariaId, 'credito_extra');
    await log('autorizacao', `Link vazio gerado: ${codigo}`, null, req.user.imobiliariaId);
    res.json(salvo);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar rascunho assistido (corretor preenche os dados) — com verificação de limite
app.post('/api/autorizacoes/rascunho', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const { codigo, proprietario, imovel } = req.body;
    if (!codigo || !proprietario?.nome) return res.status(422).json({ erro: 'Dados incompletos.' });
    const limite = await verificarLimite(req.user.imobiliariaId);
    if (!limite.ok) return res.status(402).json({ erro: limite.erro });
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
