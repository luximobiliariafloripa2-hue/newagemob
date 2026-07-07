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
const crypto     = require('crypto');
const { gerarAutorizacaoPDF } = require('./services/pdf');

const app  = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('ERRO FATAL: JWT_SECRET não definido. Configure a variável de ambiente JWT_SECRET antes de iniciar o servidor.');
  process.exit(1);
}

app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════
// BANCO DE DADOS — NeDB (multi-tenant por coleção)
// ═══════════════════════════════════════════════════════
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = {
  imobiliarias:        Datastore.create({ filename: path.join(DATA_DIR, 'imobiliarias.db'),        autoload: true }),
  usuarios:            Datastore.create({ filename: path.join(DATA_DIR, 'usuarios.db'),            autoload: true }),
  autorizacoes:        Datastore.create({ filename: path.join(DATA_DIR, 'autorizacoes.db'),        autoload: true }),
  planos:              Datastore.create({ filename: path.join(DATA_DIR, 'planos.db'),              autoload: true }),
  pacotes:             Datastore.create({ filename: path.join(DATA_DIR, 'pacotes.db'),             autoload: true }),
  compras:             Datastore.create({ filename: path.join(DATA_DIR, 'compras.db'),             autoload: true }),
  subscriptions:       Datastore.create({ filename: path.join(DATA_DIR, 'subscriptions.db'),       autoload: true }),
  subscription_history:Datastore.create({ filename: path.join(DATA_DIR, 'subscription_history.db'),autoload: true }),
  billing_transactions:Datastore.create({ filename: path.join(DATA_DIR, 'billing_transactions.db'),autoload: true }),
  boletos:             Datastore.create({ filename: path.join(DATA_DIR, 'boletos.db'),             autoload: true }),
  config:              Datastore.create({ filename: path.join(DATA_DIR, 'config.db'),              autoload: true }),
  logs:                Datastore.create({ filename: path.join(DATA_DIR, 'logs.db'),                autoload: true })
};

// Índice único no campo "codigo" — última linha de defesa contra colisão/duplicidade
// entre autorizações (inclusive entre imobiliárias diferentes). `sparse` evita
// conflito com qualquer documento legado que porventura não tenha o campo.
db.autorizacoes.ensureIndex({ fieldName: 'codigo', unique: true, sparse: true }).catch(e => {
  console.error('⚠️  Não foi possível criar índice único em autorizacoes.codigo (verifique duplicidade existente):', e.message);
});

const STORAGE_BASE = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
['originais','assinados'].forEach(d => fs.mkdirSync(path.join(STORAGE_BASE, d), { recursive: true }));

// ═══════════════════════════════════════════════════════
// SSE — Server-Sent Events para atualização em tempo real
// ═══════════════════════════════════════════════════════
const sseClients = new Map(); // imobiliariaId → Set of response objects

function sseNotificar(imobiliariaId, evento, dados) {
  const clientes = sseClients.get(imobiliariaId);
  if (!clientes || clientes.size === 0) return;
  const msg = `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;
  for (const res of clientes) {
    try { res.write(msg); } catch(e) { clientes.delete(res); }
  }
}

// Rota SSE — painel da imobiliária se conecta aqui
app.get('/api/sse', authMiddleware(['admin','corretor']), (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Nginx/Render: desativa buffer
  res.flushHeaders();

  const imobId = req.user.imobiliariaId;
  if (!sseClients.has(imobId)) sseClients.set(imobId, new Set());
  sseClients.get(imobId).add(res);

  // Ping a cada 25s para manter conexão viva
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.get(imobId)?.delete(res);
  });
});

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
      { slug:'trial',     nome:'Trial',     limite:1,   valorMensal:0,     maxUsuarios:1,  ativo:true },
      { slug:'start',     nome:'Start',     limite:10,  valorMensal:29.90, maxUsuarios:1,  ativo:true },
      { slug:'pro',       nome:'Pro',       limite:25,  valorMensal:49.90, maxUsuarios:2,  ativo:true },
      { slug:'prime',     nome:'Prime',     limite:40,  valorMensal:79.90, maxUsuarios:5,  ativo:true },
      { slug:'corporate', nome:'Corporate', limite:-1,  valorMensal:0,     maxUsuarios:-1, ativo:true },
      { slug:'enterprise',nome:'Enterprise',limite:100, valorMensal:0,     maxUsuarios:-1, ativo:true },
      { slug:'unlimited', nome:'Unlimited', limite:-1,  valorMensal:0,     maxUsuarios:-1, ativo:true }
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

// Gera um código de 9 caracteres usando RNG criptograficamente seguro
// (crypto.randomInt) em vez de Math.random() — mesmo formato/alfabeto de sempre,
// então códigos já emitidos continuam válidos e o link público não muda de forma.
function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = '';
  for (let i = 0; i < 9; i++) s += c[crypto.randomInt(0, c.length)];
  return s;
}

// Gera um código e garante que ele ainda não existe no banco antes de devolvê-lo.
// Usado nos pontos em que o próprio servidor decide o código (nunca quando o
// código já foi definido pelo cliente). Em caso de colisão (estatisticamente
// improvável: 32^9 combinações), tenta novamente algumas vezes.
async function gerarCodigoUnico() {
  for (let tentativa = 0; tentativa < 10; tentativa++) {
    const codigo = genCode();
    const existe = await db.autorizacoes.findOne({ codigo });
    if (!existe) return codigo;
  }
  throw new Error('Não foi possível gerar um código único. Tente novamente.');
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
// Limite dedicado para /api/enviar-email — rota pública (fluxo de OTP do proprietário,
// sem autenticação disponível), então a mitigação de abuso é via rate limit mais restrito
// em vez de exigir login.
const emailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { erro: 'Muitas tentativas de envio de e-mail. Aguarde 15 minutos.' } });
app.use('/api/auth', authLimiter);
app.use('/api', apiLimiter);

// Middleware JWT — verifica token e injeta req.user
function authMiddleware(roles = []) {
  return async (req, res, next) => {
    const header = req.headers.authorization;
    // SSE/EventSource envia token via query string pois não suporta headers customizados
    const token = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token;
    if (!token) return res.status(401).json({ erro: 'Token não fornecido.' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
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
function filtroImobiliaria(req, extra = {}) {
  if (req.user.role === 'super_admin') {
    return extra;
  }

  return {
    ...extra,
    imobiliariaId: req.user.imobiliariaId
  };
}
// ═══════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// AUTH ROUTES (CORRIGIDO)
// ═══════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;

    if (!email || !senha) {
      return res.status(422).json({ erro: 'E-mail e senha são obrigatórios.' });
    }

    const login = email.toLowerCase().trim();

    // 🔐 busca usuário
    let user = await db.usuarios.findOne({
      email: login,
      ativo: true
    });

    // 🔐 fallback do super admin (garantia)
    if (!user && login === 'admin' || login === 'admin@agemob.com.br') {
      user = await db.usuarios.findOne({
        email: 'admin@agemob.com.br',
        ativo: true
      });
    }

    if (!user) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const ok = await bcrypt.compare(senha, user.senha);

    if (!ok) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    let imobiliaria = null;

    if (user.imobiliariaId) {
      imobiliaria = await db.imobiliarias.findOne({
        _id: user.imobiliariaId
      });
    }

    const token = jwt.sign(
      {
        userId: user._id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        imobiliariaId: user.imobiliariaId || null,
        imobiliariaSlug: user.imobiliariaSlug || null,
        imobiliariaNome: imobiliaria?.nome || null
      },
      JWT_SECRET,
      { expiresIn: '8h' }
    );

    await log('auth', `Login: ${user.email} (${user.role})`, null, user.imobiliariaId);

    return res.json({
      token,
      user: {
        _id: user._id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        imobiliariaId: user.imobiliariaId || null,
        imobiliariaSlug: user.imobiliariaSlug || null,
        imobiliaria
      }
    });

  } catch (err) {
    return res.status(500).json({ erro: 'Erro interno no login' });
  }
});


// ═══════════════════════════════════════════════════════
// AUTH ME ROUTE
// ═══════════════════════════════════════════════════════

app.get('/api/auth/me', authMiddleware(), async (req, res) => {
  try {
    const user = await db.usuarios.findOne({
      _id: req.user.userId
    });

    if (!user) {
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }

    const { senha, ...safe } = user;

    return res.json(safe);

  } catch (err) {
    return res.status(500).json({ erro: 'Erro ao buscar usuário' });
  }
});// ═══════════════════════════════════════════════════════
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

// PATCH completo para edição pelo Super Admin (todos os campos)
app.patch('/api/admin/imobiliarias/:id', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { nome, nomeFantasia, cnpj, creci, cpf, telefone, whatsapp, email,
            responsavel, endereco, status, planoId, limiteAutorizacoes, novaSenha } = req.body;
    if (!nome) return res.status(422).json({ erro: 'Nome é obrigatório.' });

    const upd = {
      nome, nomeFantasia, cnpj, creci, cpf, telefone, whatsapp, email,
      responsavel, endereco, status, atualizadoEm: new Date().toISOString()
    };
    if (limiteAutorizacoes !== undefined) upd.limiteAutorizacoes = limiteAutorizacoes;

    await db.imobiliarias.update({ _id: req.params.id }, { $set: upd });

    // Atualizar plano se fornecido
    if (planoId) {
      const plano = await db.planos.findOne({ _id: planoId });
      if (plano) {
        await db.imobiliarias.update({ _id: req.params.id }, { $set: {
          planoId: plano._id, planoSlug: plano.slug, planoNome: plano.nome,
          limiteAutorizacoes: limiteAutorizacoes !== undefined ? limiteAutorizacoes : plano.limite
        }});
        await db.subscriptions.update({ imobiliariaId: req.params.id }, { $set: {
          planoId: plano._id, planoSlug: plano.slug, planoNome: plano.nome,
          limiteAutorizacoes: plano.limite, atualizadoEm: new Date().toISOString()
        }});
      }
    }

    // Atualizar senha se fornecida
    if (novaSenha && novaSenha.length >= 6) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(novaSenha, 10);
      await db.usuarios.update({ imobiliariaId: req.params.id, role: 'admin' }, { $set: { senha: hash } });
    }

    await log('admin', 'Imobiliária editada pelo Super Admin: ' + req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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
// SUBSCRIPTION SERVICE — Entidade separada de assinatura
// ═══════════════════════════════════════════════════════
const SubscriptionService = {

  async criar(imobiliariaId, planoId, status='trial') {
    const plano = await db.planos.findOne({ _id: planoId });
    if (!plano) throw new Error('Plano não encontrado.');
    const now = new Date();
    const renewal = new Date(now); renewal.setMonth(renewal.getMonth() + 1);
    const trialExp = status === 'trial' ? new Date(now.getTime() + 7*24*60*60*1000).toISOString() : null;
    const sub = await db.subscriptions.insert({
      imobiliariaId,
      planoId,
      planoSlug:            plano.slug,
      planoNome:            plano.nome,
      status,                             // trial | active | suspended | canceled | delinquent
      billingType:          'monthly',
      valorMensal:          plano.valorMensal || 0,
      limiteAutorizacoes:   plano.limite,
      usedAutorizacoes:     0,
      extraAutorizacoes:    0,
      renewalDate:          renewal.toISOString(),
      trialExpiration:      trialExp,
      criadoEm:             now.toISOString(),
      atualizadoEm:         now.toISOString()
    });
    // Sync back to imobiliaria for backward compat
    await db.imobiliarias.update({ _id: imobiliariaId }, { $set: {
      subscriptionId:       sub._id,
      planoId,
      planoSlug:            plano.slug,
      planoNome:            plano.nome,
      limiteAutorizacoes:   plano.limite,
      subscriptionStatus:   status,
      atualizadoEm:         now.toISOString()
    }});
    return sub;
  },

  async get(imobiliariaId) {
    return db.subscriptions.findOne({ imobiliariaId });
  },

  async alterarPlano(imobiliariaId, novoPlanoId, motivo, changedBy) {
    const sub = await this.get(imobiliariaId);
    const novoPlano = await db.planos.findOne({ _id: novoPlanoId });
    if (!novoPlano) throw new Error('Plano não encontrado.');
    // Histórico
    if (sub) {
      await db.subscription_history.insert({
        imobiliariaId,
        previousPlanId:   sub.planoId,
        previousPlanNome: sub.planoNome,
        newPlanId:        novoPlanoId,
        newPlanNome:      novoPlano.nome,
        changedBy:        changedBy || 'system',
        motivo:           motivo || '',
        criadoEm:         new Date().toISOString()
      });
    }
    const renewal = new Date(); renewal.setMonth(renewal.getMonth() + 1);
    const upd = {
      planoId:            novoPlanoId,
      planoSlug:          novoPlano.slug,
      planoNome:          novoPlano.nome,
      valorMensal:        novoPlano.valorMensal || 0,
      limiteAutorizacoes: novoPlano.limite,
      status:             'active',
      renewalDate:        renewal.toISOString(),
      atualizadoEm:       new Date().toISOString()
    };
    if (sub) {
      await db.subscriptions.update({ imobiliariaId }, { $set: upd });
    } else {
      await this.criar(imobiliariaId, novoPlanoId, 'active');
      return;
    }
    // Sync imobiliaria
    await db.imobiliarias.update({ _id: imobiliariaId }, { $set: {
      planoId: novoPlanoId, planoSlug: novoPlano.slug, planoNome: novoPlano.nome,
      limiteAutorizacoes: novoPlano.limite, subscriptionStatus: 'active', atualizadoEm: new Date().toISOString()
    }});
  },

  async resetarConsumo(imobiliariaId) {
    await db.subscriptions.update({ imobiliariaId }, { $set: { usedAutorizacoes: 0, atualizadoEm: new Date().toISOString() } });
  },

  async adicionarCreditos(imobiliariaId, quantidade, motivo, adminId) {
    await db.subscriptions.update({ imobiliariaId }, { $inc: { extraAutorizacoes: quantidade } });
    await db.imobiliarias.update({ _id: imobiliariaId }, { $inc: { creditosExtras: quantidade } });
    await db.billing_transactions.insert({
      imobiliariaId, tipo: 'extra_credits', quantidade,
      valor: 0, status: 'approved', motivo: motivo||'Manual admin',
      adminId: adminId||null, criadoEm: new Date().toISOString()
    });
  },

  async alterarStatus(imobiliariaId, novoStatus) {
    await db.subscriptions.update({ imobiliariaId }, { $set: { status: novoStatus, atualizadoEm: new Date().toISOString() } });
    await db.imobiliarias.update({ _id: imobiliariaId }, { $set: { subscriptionStatus: novoStatus, ativo: novoStatus==='active'||novoStatus==='trial', atualizadoEm: new Date().toISOString() } });
  }
};

// ═══════════════════════════════════════════════════════
// BILLING SERVICE — Transações e MRR
// ═══════════════════════════════════════════════════════
const BillingService = {

  async registrarPagamento(imobiliariaId, valor, tipo, metodo) {
    return db.billing_transactions.insert({
      imobiliariaId, valor: parseFloat(valor), tipo,
      metodo: metodo||'manual', status: 'approved',
      criadoEm: new Date().toISOString()
    });
  },

  async calcularMRR() {
    const subs = await db.subscriptions.find({ status: 'active' });
    return subs.reduce((s, sub) => s + (sub.valorMensal || 0), 0);
  },

  async metricas() {
    const subs      = await db.subscriptions.find({});
    const imobs     = await db.imobiliarias.find({});
    const now       = new Date();
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const ativos     = subs.filter(s => s.status === 'active');
    const trials     = subs.filter(s => s.status === 'trial');
    const suspensos  = subs.filter(s => s.status === 'suspended');
    const cancelados = subs.filter(s => s.status === 'canceled');
    const inadim     = subs.filter(s => s.status === 'delinquent');

    const mrr = ativos.reduce((s, sub) => s + (sub.valorMensal || 0), 0);
    const arr = mrr * 12;

    // Autorizações do mês
    const autMes = await db.autorizacoes.count({ criadoEm: { $gte: mesInicio } });
    // Churn: cancelados no mês atual
    const churnMes = cancelados.filter(s => s.atualizadoEm >= mesInicio).length;

    // Por plano
    const porPlano = {};
    for (const s of subs) {
      const slug = s.planoSlug || 'pro';
      if (!porPlano[slug]) porPlano[slug] = { nome: s.planoNome||slug, count: 0, mrr: 0 };
      porPlano[slug].count++;
      if (s.status === 'active') porPlano[slug].mrr += (s.valorMensal || 0);
    }

    return {
      totalContas:         subs.length,
      imobiliariasAtivas:  imobs.filter(i => i.tipoCliente==='imobiliaria' && i.ativo).length,
      corretoresAtivos:    imobs.filter(i => i.tipoCliente==='corretor' && i.ativo).length,
      assinaturasAtivas:   ativos.length,
      trialsAtivos:        trials.length,
      suspensos:           suspensos.length,
      inadimplentes:       inadim.length,
      churnMes,
      mrr:                 Math.round(mrr * 100) / 100,
      arr:                 Math.round(arr * 100) / 100,
      autorizacoesMes:     autMes,
      porPlano
    };
  }
};

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
  try {
    const { nome, limite, valorMensal, maxUsuarios, ativo } = req.body;
    if (!nome || limite === undefined) return res.status(422).json({ erro: 'Nome e limite são obrigatórios.' });
    const update = {
      nome,
      limite:       parseInt(limite),
      valorMensal:  parseFloat(valorMensal || 0),
      maxUsuarios:  parseInt(maxUsuarios  || 1),
      ativo:        ativo !== undefined ? ativo : true,
      atualizadoEm: new Date().toISOString()
    };
    await db.planos.update({ _id: req.params.id }, { $set: update });
    // Propagar preço/limite atualizado para todas as subscriptions com esse plano
    const subs = await db.subscriptions.find({ planoId: req.params.id });
    for (const sub of subs) {
      await db.subscriptions.update({ _id: sub._id }, { $set: {
        planoNome:          nome,
        valorMensal:        parseFloat(valorMensal || 0),
        limiteAutorizacoes: parseInt(limite),
        atualizadoEm:       new Date().toISOString()
      }});
      await db.imobiliarias.update({ _id: sub.imobiliariaId }, { $set: {
        planoNome:          nome,
        limiteAutorizacoes: parseInt(limite),
        atualizadoEm:       new Date().toISOString()
      }});
    }
    await log('admin', `Plano atualizado: ${nome} (limite:${limite}, valor:${valorMensal}, maxUsuarios:${maxUsuarios})`);
    res.json({ ok: true, propagados: subs.length });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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

// Auto-cadastro publico via landing page
app.post('/api/cadastro', async (req, res) => {
  try {
    const { tipoCliente, nome, cnpj, cpf, creci, responsavel, email, telefone, whatsapp, senha, plano: planoSlugBody } = req.body;
    const tipo = tipoCliente === 'corretor'
      ? 'corretor'
      : 'imobiliaria';
    if (!nome || !email || !senha || !responsavel)
      return res.status(422).json({ erro: 'Preencha todos os campos obrigatorios.' });

    if (tipo === 'imobiliaria' && !cnpj)
      return res.status(422).json({ erro: 'CNPJ obrigatório para imobiliárias.' });

    if (tipo === 'corretor' && !cpf)
      return res.status(422).json({ erro: 'CPF obrigatório para corretores autônomos.' });
    if (senha.length < 6)
      return res.status(422).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });

    const exEmail = await db.usuarios.findOne({ email: email.toLowerCase().trim() });
    if (exEmail) return res.status(422).json({ erro: 'E-mail ja cadastrado.' });

    const slugPlano = ['start', 'pro', 'prime'].includes(planoSlugBody) ? planoSlugBody : 'start';
    const plano = await db.planos.findOne({ slug: slugPlano });
    const slugBase = nome.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = slugBase + '-' + Date.now().toString(36);

    const imob = await db.imobiliarias.insert({
      tipoCliente: tipo, nome, razaoSocial:nome, nomeFantasia:nome,
      slug, cnpj: cnpj||'', cpf: cpf||'', creci: creci||'',
      email, telefone:telefone||'', whatsapp:whatsapp||'',
      responsavel:{ nome:responsavel, email },
      corPrimaria:'#04273B', corSecundaria:'#C9A227',
      planoId:plano?._id||null, planoSlug:plano?.slug||'start', planoNome:plano?.nome||'Start',
      limiteAutorizacoes:plano?.limite ?? 10, creditosExtras:0,
      status:'ativo', ativo:true, origem:'landing',
      criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString()
    });

    const hash = await bcrypt.hash(senha, 10);
    await db.usuarios.insert({
      nome:responsavel, email:email.toLowerCase().trim(), senha:hash,
      role:'admin', imobiliariaId:imob._id, imobiliariaSlug:slug,
      ativo:true, criadoEm:new Date().toISOString()
    });

    await log('cadastro', `Novo cliente via landing (${tipo}): ${nome} (${email})`);
    // Cria subscription trial
    try { await SubscriptionService.criar(imob._id, plano?._id, 'trial'); } catch(e) { /* non-fatal */ }

    const token = jwt.sign({
      userId:imob._id, nome:responsavel, email:email.toLowerCase().trim(),
      role:'admin', imobiliariaId:imob._id, imobiliariaSlug:slug, imobiliariaNome:nome
    }, JWT_SECRET, { expiresIn:'8h' });

    res.json({ ok:true, token, imobiliaria:{ nome, slug, plano: plano?.nome || 'Start', limite: plano?.limite ?? 10 } });
  } catch(e) {
    res.status(500).json({ erro: 'Falha ao criar conta. Tente novamente.' });
  }
});

app.get('/api/base-url', (req, res) => res.json({ baseUrl: getBaseUrl(req) }));

// Buscar dados de uma autorização pelo código (para pré-preencher link assistido)
app.get('/api/autorizacoes/codigo/:codigo', async (req, res) => {
  const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
  if (!aut) return res.json(null);
  // Rota pública (sem auth) — expõe só o necessário para o pré-preenchimento do
  // formulário do proprietário, sem vazar imobiliariaId/corretor/hash/evidências.
  res.json({
    preenchidoPorCorretor: aut.preenchidoPorCorretor || false,
    proprietario: aut.proprietario || null,
    imovel:       aut.imovel       || null
  });
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
  const lista = await db.autorizacoes
  .find(filtroImobiliaria(req))
  .sort({ criadoEm: -1 });
  res.json(lista);
});

// Criar rascunho (link vazio) — com verificação de limite
app.post('/api/autorizacoes', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const limite = await verificarLimite(req.user.imobiliariaId);
    if (!limite.ok) {
      // Se imobiliária não encontrada, o token está desatualizado (banco recriado)
      // Retorna 401 para forçar novo login
      if (limite.erro === 'Imobiliária não encontrada.') {
        return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
      }
      return res.status(402).json({ erro: limite.erro, usadas: limite.usadas, limiteTotal: (limite.limite||0)+(limite.extras||0) });
    }
    const codigo = await gerarCodigoUnico();
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
    sseNotificar(req.user.imobiliariaId, 'autorizacao_nova', { codigo, status: 'rascunho' });
    res.json(salvo);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar rascunho assistido (corretor preenche os dados) — com verificação de limite
app.post('/api/autorizacoes/rascunho', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const { proprietario, imovel } = req.body;
    if (!proprietario?.nome) return res.status(422).json({ erro: 'Dados incompletos.' });
    const limite = await verificarLimite(req.user.imobiliariaId);
    if (!limite.ok) {
      if (limite.erro === 'Imobiliária não encontrada.') {
        return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
      }
      return res.status(402).json({ erro: limite.erro });
    }
    const codigo = await gerarCodigoUnico();
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
    sseNotificar(req.user.imobiliariaId, 'autorizacao_nova', { codigo, status: 'rascunho', proprietario: proprietario.nome });
    res.json({ ok: true, codigo, linkPublico });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Inserir autorização manualmente (pelo corretor/admin no painel)
app.post('/api/autorizacoes/manual', async (req, res) => {
  try {
    const token = req.headers.authorization?.slice(7);
    let user = null;
    try { user = require('jsonwebtoken').verify(token, JWT_SECRET); } catch(e) {}
    if (!user) return res.status(401).json({ erro: 'Não autorizado.' });

    const { proprietario, imovel, tipo, status, vencimento, corretor, inseridoManualmente } = req.body;
    if (!proprietario?.nome || !imovel?.end) return res.status(422).json({ erro: 'Dados incompletos.' });

    const codigo = await gerarCodigoUnico();
    const aut = {
      codigo,
      proprietario,
      imovel,
      tipo:              tipo || 'simples',
      status:            status || 'assinado',
      vencimento:        vencimento || '—',
      corretorNome:      corretor || user.nome,
      corretorId:        user.userId,
      imobiliariaId:     user.imobiliariaId,
      imobiliariaSlug:   user.imobiliariaSlug,
      inseridoManualmente: !!inseridoManualmente,
      criadoEm:          new Date().toISOString(),
      atualizadoEm:      new Date().toISOString()
    };
    await db.autorizacoes.insert(aut);
    await log('autorizacao', `Inserida manualmente: ${codigo} (${proprietario.nome})`, null, user.imobiliariaId);
    res.json({ ok: true, codigo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Adapta os campos salvos no banco (formato do formulário do proprietário) para o
// formato esperado por gerarAutorizacaoPDF, sem alterar o que é persistido em `aut`
// e sem alterar services/pdf.js (layout e cláusulas permanecem intocados).
function adaptarParaPDF(aut, imob) {
  const juntarEndereco = (o) => o
    ? [
        [o.end, o.num].filter(Boolean).join(', '),
        [o.bairro, o.cidade].filter(Boolean).join(', ')
      ].filter(Boolean).join(' - ')
    : null;

  const enderecoImob = imob?.endereco
    ? [
        [imob.endereco.logradouro, imob.endereco.numero].filter(Boolean).join(', ') +
          (imob.endereco.complemento ? ' - ' + imob.endereco.complemento : ''),
        [imob.endereco.bairro, imob.endereco.cidade].filter(Boolean).join(', ')
      ].filter(Boolean).join(' - ')
    : '';

  return {
    autPdf: {
      codigo:       aut.codigo,
      tipo:         aut.tipo,
      hash:         aut.hashDadosAutorizacao || aut.hash || null,
      assinadoEm:   aut.assinadoEm || null,
      urlValidacao: `${getBaseUrl()}/validar/${aut.codigo}`,
      proprietario: {
        nome:        aut.proprietario?.nome,
        cpf:         aut.proprietario?.cpf,
        rg:          aut.proprietario?.rg,
        estadoCivil: aut.proprietario?.civil,
        profissao:   aut.proprietario?.prof,
        whatsapp:    aut.proprietario?.zap,
        email:       aut.proprietario?.email,
        endereco:    juntarEndereco(aut.proprietario)
      },
      imovel: {
        tipo:     aut.imovel?.tipo,
        endereco: juntarEndereco(aut.imovel),
        valor:    aut.imovel?.valor
      }
    },
    imobPdf: {
      razao:    imob?.razaoSocial || imob?.nomeFantasia || 'Lux House Imóveis',
      cnpj:     imob?.cnpj || '',
      endereco: enderecoImob
    }
  };
}

// Gera o PDF oficial da autorização assinada e salva em storage/assinados/.
// Falha aqui NÃO desfaz a assinatura já persistida (mesma tolerância a erro já
// usada hoje para a escrita paralela no Firebase) — apenas registra aviso no log.
async function gerarESalvarPDFAssinatura(aut) {
  try {
    const imob = aut.imobiliariaId
      ? await db.imobiliarias.findOne({ _id: aut.imobiliariaId })
      : await db.imobiliarias.findOne({ slug: 'lux-house' });

    const { autPdf, imobPdf } = adaptarParaPDF(aut, imob);
    const buffer = await gerarAutorizacaoPDF(autPdf, imobPdf);

    const pdfPath = `assinados/${aut.codigo}.pdf`;
    await fs.promises.writeFile(path.join(STORAGE_BASE, pdfPath), buffer);

    await db.autorizacoes.update({ codigo: aut.codigo }, { $set: { pdfPath } });
  } catch (e) {
    await log(
      'aviso',
      `Falha ao gerar/salvar PDF oficial da autorização ${aut.codigo}: ${e.message}`,
      null,
      aut.imobiliariaId || null
    );
  }
}

// Calcula o hash oficial dos dados principais da autorização — serialização
// determinística (chaves em ordem fixa, valores normalizados) para permitir
// que o próprio servidor recalcule e confira este valor no futuro.
function calcularHashDadosAutorizacao(aut) {
  const payload = JSON.stringify({
    codigo: aut.codigo,
    tipo:   aut.tipo,
    proprietario: {
      nome:  aut.proprietario?.nome  || '',
      cpf:   aut.proprietario?.cpf   || '',
      email: aut.proprietario?.email || '',
      zap:   aut.proprietario?.zap   || ''
    },
    imovel: {
      tipo:   aut.imovel?.tipo   || '',
      end:    aut.imovel?.end    || '',
      num:    aut.imovel?.num    || '',
      bairro: aut.imovel?.bairro || '',
      cidade: aut.imovel?.cidade || '',
      valor:  aut.imovel?.valor  || 0
    },
    assinadoEm: aut.assinadoEm
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// Serializa qualquer valor de forma canônica — chaves de objeto ordenadas
// alfabeticamente em toda profundidade, arrays preservam a ordem original.
// Usada para que hashEvidencias independa da ordem em que o cliente enviou
// os campos no JSON.
function serializarCanonico(valor) {
  if (Array.isArray(valor)) return '[' + valor.map(serializarCanonico).join(',') + ']';
  if (valor && typeof valor === 'object') {
    const chaves = Object.keys(valor).sort();
    return '{' + chaves.map(k => JSON.stringify(k) + ':' + serializarCanonico(valor[k])).join(',') + '}';
  }
  return JSON.stringify(valor);
}

// Calcula o hash de integridade sobre TODO o conteúdo de registroAssinatura
// (chamado antes de hashEvidencias existir nesse objeto — evita
// circularidade por ordem de execução, sem excluir nenhum campo manualmente).
function calcularHashEvidencias(registroAssinatura) {
  return crypto.createHash('sha256').update(serializarCanonico(registroAssinatura)).digest('hex');
}

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
      hashCliente:   hash || null,
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
    aut.hashDadosAutorizacao = calcularHashDadosAutorizacao(aut);
    aut.hash = aut.hashDadosAutorizacao;
    aut.registroAssinatura = {
      hashCliente:          aut.hashCliente,
      hashDadosAutorizacao: aut.hashDadosAutorizacao,
      hash:                 aut.hash,
      evidencias:           aut.evidencias,
      validacoes:           aut.validacoes,
      assinadoEm:           aut.assinadoEm
    };
    aut.registroAssinatura.hashEvidencias = calcularHashEvidencias(aut.registroAssinatura);
    if (rascunho) {
      await db.autorizacoes.update({ codigo }, { $set: { ...aut } });
    } else {
      await db.autorizacoes.insert(aut);
    }
    await gerarESalvarPDFAssinatura(aut);
    // Alerta se imobiliariaId ficou null — indica link gerado sem salvar rascunho
    if (!aut.imobiliariaId) {
      await log('aviso', `Autorização ${codigo} assinada SEM imobiliariaId — não aparecerá no painel`, null, null);
    }
    await log('autorizacao', `Assinada: ${codigo} (${proprietario.nome})`, null, aut.imobiliariaId);
    if (aut.imobiliariaId) sseNotificar(aut.imobiliariaId, 'autorizacao_assinada', { codigo, proprietario: proprietario.nome, status: 'assinado' });
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

app.post('/api/enviar-email', emailLimiter, async (req, res) => {
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
// BILLING & SUBSCRIPTION ROUTES
// ═══════════════════════════════════════════════════════

// Métricas billing completas para super admin
app.get('/api/admin/billing/metricas', authMiddleware(['super_admin']), async (_req, res) => {
  try { res.json(await BillingService.metricas()); }
  catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar todas as subscriptions com dados enriquecidos
app.get('/api/admin/subscriptions', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { plano, status, tipo, search } = req.query;
    let imobs = await db.imobiliarias.find({});
    if (tipo)   imobs = imobs.filter(i => i.tipoCliente === tipo);
    if (search) imobs = imobs.filter(i => i.nome?.toLowerCase().includes(search.toLowerCase()) || i.email?.toLowerCase().includes(search.toLowerCase()));

    const now = new Date();
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const result = await Promise.all(imobs.map(async imob => {
      const sub = await db.subscriptions.findOne({ imobiliariaId: imob._id });
      const usadas = await db.autorizacoes.count({ imobiliariaId: imob._id, criadoEm: { $gte: mesInicio } });
      const limite  = sub?.limiteAutorizacoes ?? imob.limiteAutorizacoes ?? 0;
      const extras  = sub?.extraAutorizacoes  ?? imob.creditosExtras     ?? 0;
      const disponiveis = limite === -1 ? -1 : Math.max(0, limite + extras - usadas);
      const pct = limite > 0 ? Math.min(Math.round(usadas / limite * 100), 100) : 0;
      return {
        _id:           imob._id,
        nome:          imob.nome,
        email:         imob.email,
        tipoCliente:   imob.tipoCliente || 'imobiliaria',
        cnpj:          imob.cnpj || '',
        cpf:           imob.cpf  || '',
        planoSlug:     sub?.planoSlug   || imob.planoSlug   || 'pro',
        planoNome:     sub?.planoNome   || imob.planoNome   || 'Pro',
        valorMensal:   sub?.valorMensal || 0,
        status:        sub?.status      || imob.subscriptionStatus || 'active',
        billingType:   sub?.billingType || 'monthly',
        limite,
        usadas,
        extras,
        disponiveis,
        pct,
        renewalDate:      sub?.renewalDate || null,
        trialExpiration:  sub?.trialExpiration || null,
        subscriptionId:   sub?._id || null,
        criadoEm:         imob.criadoEm
      };
    }));

    let filtered = result;
    if (plano)  filtered = filtered.filter(r => r.planoSlug === plano);
    if (status) filtered = filtered.filter(r => r.status === status);

    res.json(filtered.sort((a,b) => new Date(b.criadoEm) - new Date(a.criadoEm)));
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Alterar plano de uma conta
app.patch('/api/admin/subscriptions/:imobId/plano', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { planoId, motivo } = req.body;
    await SubscriptionService.alterarPlano(req.params.imobId, planoId, motivo, req.user.userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Alterar status (suspender, reativar, cancelar, trial, delinquent)
app.patch('/api/admin/subscriptions/:imobId/status', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['trial','active','suspended','canceled','delinquent'];
    if (!valid.includes(status)) return res.status(422).json({ erro: 'Status inválido.' });
    await SubscriptionService.alterarStatus(req.params.imobId, status);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Adicionar créditos
app.post('/api/admin/subscriptions/:imobId/creditos', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { quantidade, motivo } = req.body;
    if (!quantidade || quantidade < 1) return res.status(422).json({ erro: 'Quantidade inválida.' });
    await SubscriptionService.adicionarCreditos(req.params.imobId, parseInt(quantidade), motivo, req.user.userId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Resetar consumo do mês
app.patch('/api/admin/subscriptions/:imobId/resetar', authMiddleware(['super_admin']), async (req, res) => {
  try {
    await SubscriptionService.resetarConsumo(req.params.imobId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Editar limite manual
app.patch('/api/admin/subscriptions/:imobId/limite', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { limite } = req.body;
    await db.subscriptions.update({ imobiliariaId: req.params.imobId }, { $set: { limiteAutorizacoes: parseInt(limite), atualizadoEm: new Date().toISOString() } });
    await db.imobiliarias.update({ _id: req.params.imobId }, { $set: { limiteAutorizacoes: parseInt(limite), atualizadoEm: new Date().toISOString() } });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Histórico de mudanças de plano
app.get('/api/admin/subscriptions/:imobId/historico', authMiddleware(['super_admin']), async (req, res) => {
  const hist = await db.subscription_history.find({ imobiliariaId: req.params.imobId }).sort({ criadoEm: -1 });
  res.json(hist);
});

// Subscription do cliente logado (para painel da imobiliária)
app.get('/api/minha-assinatura', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const sub = await SubscriptionService.get(req.user.imobiliariaId);
    const now = new Date();
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const usadas = await db.autorizacoes.count({ imobiliariaId: req.user.imobiliariaId, criadoEm: { $gte: mesInicio } });
    const limite = sub?.limiteAutorizacoes ?? 0;
    const extras = sub?.extraAutorizacoes  ?? 0;
    const disponiveis = limite === -1 ? -1 : Math.max(0, limite + extras - usadas);
    const pct = limite > 0 ? Math.min(Math.round(usadas / limite * 100), 100) : 0;
    res.json({ sub, usadas, limite, extras, disponiveis, pct,
      alerta: pct >= 100 ? 'critico' : pct >= 90 ? 'urgente' : pct >= 80 ? 'aviso' : null });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Hook: criar subscription quando imobiliária é criada via auto-cadastro
// (já tratado no /api/cadastro, mas garantindo para cadastros do super admin)
app.post('/api/admin/subscriptions/:imobId/iniciar', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { planoId, status } = req.body;
    const sub = await SubscriptionService.criar(req.params.imobId, planoId, status||'trial');
    res.json({ ok: true, sub });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// VALIDAÇÃO PÚBLICA — QR Code / Link de verificação
// ═══════════════════════════════════════════════════════

// Rota pública — qualquer pessoa com o link pode verificar
app.get('/api/validar/:codigo', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
    if (!aut) return res.status(404).json({ valido: false, erro: 'Código não encontrado.' });

    // Retorna apenas dados necessários para validação — sem dados sensíveis
    res.json({
      valido:     true,
      codigo:     aut.codigo,
      status:     aut.status,
      tipo:       aut.tipo || 'simples',
      hash:       aut.hash || null,
      assinadoEm: aut.assinadoEm || aut.criadoEm,
      vencimento: aut.vencimento || null,
      proprietario: {
        nome:  aut.proprietario?.nome || '—',
        cpf:   aut.proprietario?.cpf  ? aut.proprietario.cpf.replace(/(\d{3})\.(\d{3})\.(\d{3})-(\d{2})/, '$1.***.***-$4') : '—'
      },
      imovel: {
        tipo:   aut.imovel?.tipo   || '—',
        bairro: aut.imovel?.bairro || '—',
        cidade: aut.imovel?.cidade || '—'
      },
      imobiliaria: {
        nome: aut.imobiliariaNome || null
      }
    });
  } catch(e) { res.status(500).json({ valido: false, erro: 'Erro interno.' }); }
});

// ═══════════════════════════════════════════════════════
// BOLETOS — Imobiliária
// ═══════════════════════════════════════════════════════

// Gera código de boleto fictício (para simulação antes de gateway)
function gerarCodigoBoleto() {
  return '34191.' + Math.random().toString().slice(2,7) + ' ' +
         Math.random().toString().slice(2,12) + ' ' +
         Math.random().toString().slice(2,12) + ' ' +
         Math.floor(Math.random()*9) + ' ' +
         Date.now().toString().slice(-13);
}

// Listar boletos da imobiliária logada
app.get('/api/boletos', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const boletos = await db.boletos.find({ imobiliariaId: req.user.imobiliariaId }).sort({ criadoEm: -1 });
    const agora = new Date();
    // Atualiza status de vencidos automaticamente
    for (const b of boletos) {
      if (b.status === 'a_vencer' && new Date(b.vencimento) < agora) {
        await db.boletos.update({ _id: b._id }, { $set: { status: 'vencido', atualizadoEm: agora.toISOString() } });
        b.status = 'vencido';
      }
    }
    const proximo = boletos.find(b => b.status === 'a_vencer') || null;
    res.json({ boletos, proximo });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// BOLETOS — Super Admin
// ═══════════════════════════════════════════════════════

// Listar todos os boletos (super admin)
app.get('/api/admin/boletos', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const boletos = await db.boletos.find({}).sort({ criadoEm: -1 });
    // Enriquecer com nome da imobiliária
    const enriquecidos = await Promise.all(boletos.map(async b => {
      const imob = b.imobiliariaId ? await db.imobiliarias.findOne({ _id: b.imobiliariaId }) : null;
      return { ...b, imobiliariaNome: imob?.nome || '—', planoNome: imob?.planoNome || '—' };
    }));
    res.json({ boletos: enriquecidos });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Emitir novo boleto (super admin)
app.post('/api/admin/boletos', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { imobiliariaId, valor, vencimento, competencia, observacao } = req.body;
    if (!imobiliariaId || !valor || !vencimento || !competencia) {
      return res.status(422).json({ erro: 'Campos obrigatórios: imobiliariaId, valor, vencimento, competencia.' });
    }
    const imob = await db.imobiliarias.findOne({ _id: imobiliariaId });
    const boleto = await db.boletos.insert({
      imobiliariaId,
      imobiliariaNome: imob?.nome || '—',
      planoNome:       imob?.planoNome || '—',
      valor:           parseFloat(valor),
      vencimento,
      competencia,
      observacao:      observacao || '',
      codigo:          gerarCodigoBoleto(),
      status:          'a_vencer',
      criadoEm:        new Date().toISOString(),
      atualizadoEm:    new Date().toISOString()
    });
    await log('boleto', `Boleto emitido: ${imob?.nome||'—'} — R$${valor} — ${competencia}`);
    res.json({ ok: true, boleto });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Alterar status de um boleto (super admin)
app.patch('/api/admin/boletos/:id/status', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ['pago','a_vencer','vencido','cancelado'];
    if (!valid.includes(status)) return res.status(422).json({ erro: 'Status inválido.' });
    const upd = { status, atualizadoEm: new Date().toISOString() };
    if (status === 'pago') upd.pagamentoEm = new Date().toISOString();
    await db.boletos.update({ _id: req.params.id }, { $set: upd });
    // Se marcado como pago, reativa subscription e renova créditos
    if (status === 'pago') {
      const boleto = await db.boletos.findOne({ _id: req.params.id });
      if (boleto?.imobiliariaId) {
        const sub = await db.subscriptions.findOne({ imobiliariaId: boleto.imobiliariaId });
        if (sub) {
          const renewal = new Date(); renewal.setMonth(renewal.getMonth()+1);
          await db.subscriptions.update({ _id: sub._id }, { $set: {
            status: 'active', usedAutorizacoes: 0, renewalDate: renewal.toISOString(), atualizadoEm: new Date().toISOString()
          }});
          await db.imobiliarias.update({ _id: boleto.imobiliariaId }, { $set: { subscriptionStatus:'active', atualizadoEm: new Date().toISOString() } });
        }
        await log('boleto', `Boleto ${req.params.id} marcado como pago — créditos renovados`);
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// CRÉDITOS — Solicitação de compra (imobiliária)
// ═══════════════════════════════════════════════════════
app.post('/api/creditos/solicitar', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const { pacoteId, quantidade, valor } = req.body;
    const compra = await db.compras.insert({
      imobiliariaId: req.user.imobiliariaId,
      pacoteId:      pacoteId || null,
      tipo:          'solicitacao',
      quantidade:    parseInt(quantidade),
      valor:         parseFloat(valor||0),
      motivo:        `Solicitação de ${quantidade} créditos via painel`,
      statusPagamento: 'pendente',
      criadoEm:      new Date().toISOString()
    });
    await log('credito', `Solicitação de créditos: ${req.user.imobiliariaId} — ${quantidade} créditos`, null, req.user.imobiliariaId);
    res.json({ ok: true, compra });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Histórico de créditos da imobiliária
app.get('/api/creditos/historico', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const hist = await db.compras.find({ imobiliariaId: req.user.imobiliariaId }).sort({ criadoEm: -1 });
    res.json(hist);
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// MODO SUPORTE — Super Admin acessa conta de imobiliária
// ═══════════════════════════════════════════════════════

// Gera token temporário de suporte para uma imobiliária
app.post('/api/admin/suporte/:imobId', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const imob = await db.imobiliarias.findOne({ _id: req.params.imobId });
    if (!imob) return res.status(404).json({ erro: 'Imobiliária não encontrada.' });

    // Busca o admin principal da imobiliária
    const adminUser = await db.usuarios.findOne({ imobiliariaId: req.params.imobId, role: 'admin', ativo: true });
    if (!adminUser) return res.status(404).json({ erro: 'Admin da imobiliária não encontrado.' });

    // Token de suporte — válido 2h, carrega flag modoSuporte
    const tokenSuporte = jwt.sign({
      userId:            adminUser._id,
      nome:              adminUser.nome,
      email:             adminUser.email,
      role:              'admin',
      imobiliariaId:     imob._id,
      imobiliariaSlug:   imob.slug,
      imobiliariaNome:   imob.nome,
      modoSuporte:       true,
      superAdminId:      req.user.userId,
      superAdminEmail:   req.user.email
    }, JWT_SECRET, { expiresIn: '2h' });

    await log('suporte', `Super admin ${req.user.email} entrou em modo suporte: ${imob.nome}`, null, imob._id);

    res.json({
      ok: true,
      token: tokenSuporte,
      imobiliaria: { nome: imob.nome, slug: imob.slug, email: imob.email }
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// SPA CATCH-ALL
// ═══════════════════════════════════════════════════════
app.get('/validar/:codigo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'validar.html'));
});

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
