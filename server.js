/**
 * AGEMOB v2 — Plataforma SaaS de Autorizações Imobiliárias
 * Multi-tenant · JWT Auth · Super Admin · RBAC
 */
require('dotenv').config();

// Modo de execução explícito, antes de qualquer outra coisa: sem isso a
// produção cairia em modo desenvolvimento e desligaria as proteções de
// produção (seed, BASE_URL, Ed25519, TSA). Mensagens fixas, sem o valor.
const MODOS_EXECUCAO = ['development', 'production'];
if (!MODOS_EXECUCAO.includes(process.env.NODE_ENV)) {
  console.error('ERRO FATAL: NODE_ENV deve ser "development" ou "production".');
  process.exit(1);
}
if (process.env.RENDER === 'true' && process.env.NODE_ENV !== 'production') {
  console.error('ERRO FATAL: ambiente Render exige NODE_ENV="production".');
  process.exit(1);
}

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const Datastore  = require('nedb-promises');
const crypto     = require('crypto');
const { gerarAutorizacaoPDF } = require('./services/pdf');
const { LIMITES_EVIDENCIA } = require('./src/services/evidence/constants');
const { criarEvidenceIngestionOrchestrator } = require('./src/services/evidence/EvidenceIngestionOrchestrator');
const { ATORES_EVENTO } = require('./src/services/events/constants');
const { validarEstrutura: validarEstruturaEventos, EventValidationError } = require('./src/services/events/EventShapeValidator');
const { normalizarEventos } = require('./src/services/events/EventNormalizer');
const { enriquecerEventosComServidor } = require('./src/services/events/EventServerEnrichment');
const { construirEventoBackend } = require('./src/services/events/EventBackendEmitter');
const { carregarConfiguracaoTsa, solicitarCarimboTempo, verificarTokenArmazenado } = require('./src/services/tsa/Rfc3161TimestampClient');
const { DIAS_TRIAL, avaliarAcessoImobiliaria, normalizarStatusFinanceiro } = require('./src/services/acesso/AcessoTenant');
const { carregarConfiguracao: carregarConfiguracaoInfinitepay, criarInfinitepayService } = require('./services/infinitepayService');
const rotasInfinitepay = require('./routes/infinitepay');
const logoTenant = require('./services/logoTenant');

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
  pagamentos:          Datastore.create({ filename: path.join(DATA_DIR, 'pagamentos.db'),          autoload: true }),
  resetSenha:          Datastore.create({ filename: path.join(DATA_DIR, 'reset_senha.db'),         autoload: true }),
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
['originais','assinados','dossies','temporarios','backups'].forEach(d => fs.mkdirSync(path.join(STORAGE_BASE, d), { recursive: true }));
const evidenceOrchestrator = criarEvidenceIngestionOrchestrator({ storageBase: STORAGE_BASE });

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
// SEED — Super Admin + Planos + Pacotes (nenhum tenant é criado por código)
// ═══════════════════════════════════════════════════════
// Senha padrão do Super Admin só em desenvolvimento. Ela e as senhas padrão de
// versões anteriores ficam proibidas em produção: nunca criam conta e, se uma
// conta existente ainda as aceitar, o startup é recusado — sem rotação
// automática e sem tocar no hash. Erros carregam só um código fixo.
const SENHA_DEV_SUPER_ADMIN = 'AgemobDev2026!';
const SENHAS_PADRAO_SEED = [SENHA_DEV_SUPER_ADMIN, 'LuxAdmin2026!', 'lux2026'];

class ErroSeed extends Error {
  constructor(codigo) {
    super(codigo);
    this.codigo = codigo;
  }
}

function senhaSeedAusente(valor) {
  return !(valor || '').trim();
}

async function aceitaSenhaPadraoSeed(usuario) {
  for (const senha of SENHAS_PADRAO_SEED) {
    if (await bcrypt.compare(senha, usuario.senha || '')) return true;
  }
  return false;
}

// Roda antes de qualquer escrita do seed, só em produção. Confere os Super
// Admins e as contas com o login legado 'admin' criado por versões antigas do
// seed — de qualquer tenant, sem tratamento por slug.
async function verificarCredenciaisSeedProducao() {
  const superAdmins = await db.usuarios.find({ role: 'super_admin' });

  if (superAdmins.length === 0) {
    if (senhaSeedAusente(process.env.SUPER_ADMIN_PASS)) throw new ErroSeed('SUPER_ADMIN_PASS_ausente');
    if (SENHAS_PADRAO_SEED.includes(process.env.SUPER_ADMIN_PASS)) throw new ErroSeed('credencial_padrao_ativa');
  }

  const contasLegadas = await db.usuarios.find({ email: 'admin' });
  for (const usuario of [...superAdmins, ...contasLegadas]) {
    if (await aceitaSenhaPadraoSeed(usuario)) throw new ErroSeed('credencial_padrao_ativa');
  }
}

async function seed() {
  if (process.env.NODE_ENV === 'production') await verificarCredenciaisSeedProducao();

  // Super admin
  const superAdmin = await db.usuarios.findOne({ role: 'super_admin' });
  if (!superAdmin) {
    const hash = await bcrypt.hash(process.env.SUPER_ADMIN_PASS || SENHA_DEV_SUPER_ADMIN, 10);
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

// Origem pública oficial. Em produção é obrigatória e validada no startup
// (antes do seed e do listen): entra na URL de validação do PDF oficial, que é
// selado no Dossiê. Só origem HTTPS pura; erros usam código fixo, sem o valor.
function normalizarBaseUrlProducao(valor) {
  const texto = (valor || '').trim();
  if (!texto) throw new Error('BASE_URL_ausente');
  let url;
  try {
    url = new URL(texto);
  } catch {
    throw new Error('BASE_URL_invalida');
  }
  if (url.protocol !== 'https:') throw new Error('BASE_URL_nao_https');
  // [?#] cobre "?" e "#" vazios, que o URL descarta de search/hash.
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || /[?#]/.test(texto)) {
    throw new Error('BASE_URL_formato_invalido');
  }
  return url.origin;
}

let baseUrlProducao = null;
if (process.env.NODE_ENV === 'production') {
  try {
    baseUrlProducao = normalizarBaseUrlProducao(process.env.BASE_URL);
  } catch (e) {
    console.error(`ERRO FATAL: BASE_URL invalida (${e.message}).`);
    process.exit(1);
  }
}

// Gateway InfinitePay (M9-02). Em produção API key e handle são obrigatórios
// e a URL da API é sempre a oficial; erros com código fixo, sem o valor.
let infinitepay;
try {
  infinitepay = criarInfinitepayService(carregarConfiguracaoInfinitepay(process.env));
} catch (e) {
  console.error(`ERRO FATAL: configuracao InfinitePay invalida (${e.message}).`);
  process.exit(1);
}
if (infinitepay.desativado) {
  console.warn('AVISO: InfinitePay DESATIVADA (INFINITEPAY_DESATIVADO=true) — homologacao, sem cobranca. Remover antes do lancamento.');
}

function getBaseUrl(req) {
  if (baseUrlProducao) return baseUrlProducao;
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, '');
  if (req) return `${req.protocol}://${req.get('host')}`;
  return 'http://localhost:' + PORT;
}

// ═══════════════════════════════════════════════════════
// MIDDLEWARES
// ═══════════════════════════════════════════════════════
// express.json recebe o corpo em Base64: ~4/3 do tamanho binário decodificado,
// mais margem para o restante do JSON (proprietario, imovel, otp, evidencias,
// prefixos "data:<mime>;base64,"). O teto real dos buffers decodificados é só
// LIMITES_EVIDENCIA.bodyGlobalBytes, aplicado pelo EvidenceBinaryValidator —
// aqui só compensamos a expansão do transporte, nunca uma política própria.
const LIMITE_BODY_HTTP_BYTES =
  Math.ceil(LIMITES_EVIDENCIA.bodyGlobalBytes * 4 / 3) +
  3 * 1024 * 1024;

app.use(express.json({ limit: LIMITE_BODY_HTTP_BYTES }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'landing.html' }));

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
    } catch(e) {
      return res.status(401).json({ erro: 'Token inválido ou expirado.' });
    }
    // Regra central: token de tenant só vale enquanto a conta pode ser consultada
    // (token de 8h de conta desativada para na hora). Super Admin e modo suporte
    // não passam por aqui.
    if ((req.user.role === 'admin' || req.user.role === 'corretor') && !req.user.modoSuporte) {
      try {
        const { acesso } = await carregarAcessoTenant(req.user.imobiliariaId);
        if (acesso.statusEfetivo === 'inexistente') return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
        if (!acesso.podeConsultar) return res.status(403).json({ erro: acesso.motivo });
      } catch(e) {
        return res.status(500).json({ erro: 'Erro interno.' });
      }
    }
    next();
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

    // 🔐 busca usuário pelo próprio identificador (Super Admin incluído)
    const user = await db.usuarios.findOne({
      email: login,
      ativo: true
    });

    if (!user) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    const ok = await bcrypt.compare(senha, user.senha);

    if (!ok) {
      return res.status(401).json({ erro: 'Credenciais inválidas.' });
    }

    if (user.role === 'admin' || user.role === 'corretor') {
      const { acesso } = await carregarAcessoTenant(user.imobiliariaId);
      if (!acesso.podeLogin) return res.status(403).json({ erro: acesso.motivo });
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

    const statusAdm = statusAdministrativoEntrada(status === undefined ? 'ativo' : status);
    if (!statusAdm) return res.status(422).json({ erro: 'Status inválido.' });

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
      status: statusAdm,
      ativo: statusAdm !== 'inativo',
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
      responsavel, endereco, atualizadoEm: new Date().toISOString()
    };
    if (status !== undefined) {
      const statusAdm = statusAdministrativoEntrada(status);
      if (!statusAdm) return res.status(422).json({ erro: 'Status inválido.' });
      upd.status = statusAdm;
      upd.ativo = statusAdm !== 'inativo';
    }
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
  await db.imobiliarias.update({ _id: req.params.id }, { $set: { status: ativo ? 'ativo' : 'inativo', ativo: !!ativo, atualizadoEm: new Date().toISOString() } });
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
    if (!STATUS_FINANCEIROS.includes(status)) throw new Error('Status de assinatura inválido.');
    const plano = await db.planos.findOne({ _id: planoId });
    if (!plano) throw new Error('Plano não encontrado.');
    const now = new Date();
    const renewal = new Date(now); renewal.setMonth(renewal.getMonth() + 1);
    const trialExp = status === 'trial' ? new Date(now.getTime() + DIAS_TRIAL*24*60*60*1000).toISOString() : null;
    const sub = await db.subscriptions.insert({
      imobiliariaId,
      planoId,
      planoSlug:            plano.slug,
      planoNome:            plano.nome,
      status,                             // trial | active | pending (eixo financeiro)
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

  // Pagamento confirmado (M9-02): aplica o plano pago por mais 30 dias a
  // partir do vencimento ainda válido, ou de agora. Nunca toca imob.status /
  // imob.ativo — conta suspensa pelo Super Admin continua suspensa. O plano e
  // o valor vêm do registro do pagamento (snapshot do que foi pago).
  async ativarPorPagamento(imobiliariaId, pagamento, agora) {
    const plano = await db.planos.findOne({ _id: pagamento.planoId });
    if (!plano) throw new Error('Plano do pagamento não encontrado.');
    let sub = await this.get(imobiliariaId);
    if (!sub) {
      await this.criar(imobiliariaId, plano._id, 'active');
      sub = await this.get(imobiliariaId);
    }
    const vencAtual = sub.planoVencimento ? new Date(sub.planoVencimento) : null;
    const base = normalizarStatusFinanceiro(sub.status) === 'active' && vencAtual && vencAtual > agora ? vencAtual : agora;
    const vencimento = new Date(base.getTime() + DIAS_CICLO_PAGO*24*60*60*1000).toISOString();
    if (sub.planoId !== plano._id) {
      await db.subscription_history.insert({
        imobiliariaId,
        previousPlanId:   sub.planoId,
        previousPlanNome: sub.planoNome,
        newPlanId:        plano._id,
        newPlanNome:      plano.nome,
        changedBy:        'pagamento',
        motivo:           `Pagamento ${pagamento.orderNsu}`,
        criadoEm:         agora.toISOString()
      });
    }
    // suspended/canceled legados pertencem ao eixo administrativo: preservados.
    const statusSub = ['suspended', 'canceled'].includes(sub.status) ? sub.status : 'active';
    await db.subscriptions.update({ _id: sub._id }, { $set: {
      status:             statusSub,
      planoId:            plano._id,
      planoSlug:          plano.slug,
      planoNome:          plano.nome,
      valorMensal:        pagamento.valorCentavos / 100,
      limiteAutorizacoes: plano.limite,
      planoVencimento:    vencimento,
      renewalDate:        vencimento,
      atualizadoEm:       agora.toISOString()
    }});
    await db.imobiliarias.update({ _id: imobiliariaId }, { $set: {
      planoId:            plano._id,
      planoSlug:          plano.slug,
      planoNome:          plano.nome,
      limiteAutorizacoes: plano.limite,
      subscriptionStatus: 'active',
      atualizadoEm:       agora.toISOString()
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

  // Ações do painel (contrato da rota mantido) mapeadas nos dois eixos:
  // suspended/canceled/active mexem no eixo administrativo (imob.status);
  // active/delinquent/trial no financeiro (sub.status). Motivo financeiro
  // nunca altera imob.ativo — isso derrubaria os links públicos.
  async alterarStatus(imobiliariaId, novoStatus) {
    const agora = new Date().toISOString();
    const adm = { suspended: 'suspenso', canceled: 'inativo', active: 'ativo' }[novoStatus];
    if (adm) {
      await db.imobiliarias.update({ _id: imobiliariaId }, { $set: { status: adm, ativo: adm !== 'inativo', atualizadoEm: agora } });
    }
    const fin = { active: 'active', delinquent: 'pending', trial: 'trial' }[novoStatus];
    if (fin) {
      const set = { status: fin, atualizadoEm: agora };
      if (fin === 'trial') set.trialExpiration = new Date(Date.now() + DIAS_TRIAL*24*60*60*1000).toISOString();
      await db.subscriptions.update({ imobiliariaId }, { $set: set });
      await db.imobiliarias.update({ _id: imobiliariaId }, { $set: { subscriptionStatus: fin, atualizadoEm: agora } });
    }
  }
};

const STATUS_FINANCEIROS = ['trial', 'active', 'pending'];
const DIAS_CICLO_PAGO = 30;

// Entrada do Super Admin para o eixo administrativo; 'cancelado' (opção do
// formulário de edição) equivale a inativo. Retorna null se inválido.
function statusAdministrativoEntrada(status) {
  if (status === 'cancelado') return 'inativo';
  return ['ativo', 'suspenso', 'inativo'].includes(status) ? status : null;
}

// Carrega imobiliária + subscription (+ plano trial e uso, só se em trial) e
// aplica a regra central. Única porta de entrada para decisões de acesso.
async function carregarAcessoTenant(imobiliariaId) {
  const imob = imobiliariaId ? await db.imobiliarias.findOne({ _id: imobiliariaId }) : null;
  const sub = imob ? await db.subscriptions.findOne({ imobiliariaId }) : null;
  let planoTrial = null, usoTrial = 0;
  if (sub && normalizarStatusFinanceiro(sub.status) === 'trial') {
    planoTrial = await db.planos.findOne({ slug: 'trial' });
    usoTrial = await db.autorizacoes.count({ imobiliariaId });
  }
  return { imob, sub, planoTrial, acesso: avaliarAcessoImobiliaria({ imob, sub, planoTrial, usoTrial, agora: new Date() }) };
}

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
// Consumo da cota mensal do plano: autorizações do mês que não foram pagas
// com crédito extra (registros antigos, sem `consumo`, contam como plano).
async function contarUsoPlanoMes(imobiliariaId) {
  const now = new Date();
  const inicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  return db.autorizacoes.count({ imobiliariaId, criadoEm: { $gte: inicio }, consumo: { $ne: 'credito_extra' } });
}

// Decide se a imobiliária pode criar mais uma autorização e qual cota ela
// consome: 'trial' | 'plano' | 'credito_extra'. O crédito extra é debitado
// aqui, de forma atômica (só debita se ainda houver saldo).
async function reservarAutorizacao(imobiliariaId) {
  const { imob, acesso } = await carregarAcessoTenant(imobiliariaId);
  // Token desatualizado (banco recriado) → 401 força novo login
  if (acesso.statusEfetivo === 'inexistente') return { ok: false, status: 401, erro: 'Sessão expirada. Faça login novamente.' };
  if (!acesso.podeOperar) return { ok: false, status: 402, erro: acesso.motivo, statusEfetivo: acesso.statusEfetivo };
  if (acesso.trial) return { ok: true, consumo: 'trial' };

  if (imob.limiteAutorizacoes === -1) return { ok: true, consumo: 'plano' };
  const limite = imob.limiteAutorizacoes || 0;
  const usadas = await contarUsoPlanoMes(imobiliariaId);
  if (usadas < limite) return { ok: true, consumo: 'plano' };

  const debitado = await db.imobiliarias.update({ _id: imobiliariaId, creditosExtras: { $gt: 0 } }, { $inc: { creditosExtras: -1 } });
  if (debitado === 1) return { ok: true, consumo: 'credito_extra' };

  return {
    ok: false, status: 402,
    erro: 'Você atingiu o limite de autorizações do seu plano. Adquira créditos adicionais ou faça upgrade.',
    usadas, limite, extras: 0
  };
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

// Planos vendáveis para a landing e a pré-seleção do checkout (M9-03), público
// e só leitura. Mesma regra de vendável do checkout InfinitePay (ativo, não
// trial, preço ≥ R$ 1,00); o checkout continua decidindo preço pelo planoId.
app.get('/api/planos/publicos', async (_req, res) => {
  try {
    const planos = await db.planos.find({ ativo: true });
    res.json(planos
      .filter(p => p.slug !== 'trial' && typeof p.valorMensal === 'number' && Number.isFinite(p.valorMensal) && Math.round(p.valorMensal * 100) >= 100)
      .sort((a, b) => a.valorMensal - b.valorMensal)
      .map(p => ({ _id: p._id, slug: p.slug, nome: p.nome, valorMensal: p.valorMensal, limite: p.limite, maxUsuarios: p.maxUsuarios })));
  } catch(e) { res.status(500).json({ erro: 'Erro interno.' }); }
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

// Auto-cadastro publico via landing page — toda conta nova nasce em trial
// (plano 'trial' de db.planos). O plano escolhido na landing não é aplicado.
app.post('/api/cadastro', async (req, res) => {
  const criados = { imob: null, usuario: null };
  try {
    const { tipoCliente, nome, cnpj, cpf, creci, responsavel, email, telefone, whatsapp, senha } = req.body;
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

    const planoTrial = await db.planos.findOne({ slug: 'trial' });
    if (!planoTrial) return res.status(503).json({ erro: 'Cadastro temporariamente indisponível. Tente novamente mais tarde.' });

    const slugBase = nome.toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slug = slugBase + '-' + Date.now().toString(36);

    // Nasce inativa: se qualquer passo abaixo falhar e o desfazer também
    // falhar, a sobra nunca é uma conta operacional sem assinatura.
    criados.imob = await db.imobiliarias.insert({
      tipoCliente: tipo, nome, razaoSocial:nome, nomeFantasia:nome,
      slug, cnpj: cnpj||'', cpf: cpf||'', creci: creci||'',
      email, telefone:telefone||'', whatsapp:whatsapp||'',
      responsavel:{ nome:responsavel, email },
      corPrimaria:'#04273B', corSecundaria:'#C9A227',
      planoId:planoTrial._id, planoSlug:planoTrial.slug, planoNome:planoTrial.nome,
      limiteAutorizacoes:planoTrial.limite, creditosExtras:0,
      status:'inativo', ativo:false, origem:'landing',
      criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString()
    });
    const imobId = criados.imob._id;

    const hash = await bcrypt.hash(senha, 10);
    criados.usuario = await db.usuarios.insert({
      nome:responsavel, email:email.toLowerCase().trim(), senha:hash,
      role:'admin', imobiliariaId:imobId, imobiliariaSlug:slug,
      ativo:true, criadoEm:new Date().toISOString()
    });

    await SubscriptionService.criar(imobId, planoTrial._id, 'trial');
    await db.imobiliarias.update({ _id: imobId }, { $set: { status:'ativo', ativo:true, atualizadoEm:new Date().toISOString() } });

    const { imob, acesso } = await carregarAcessoTenant(imobId);
    if (acesso.statusEfetivo !== 'trial_ativo') throw new Error('Trial não ficou válido após o cadastro.');

    await log('cadastro', `Novo cliente via landing (${tipo}): ${nome} (${email}) — trial`);

    const usuario = criados.usuario;
    const token = jwt.sign({
      userId:usuario._id, nome:usuario.nome, email:usuario.email,
      role:'admin', imobiliariaId:imobId, imobiliariaSlug:slug, imobiliariaNome:nome
    }, JWT_SECRET, { expiresIn:'8h' });

    res.json({
      ok:true, token,
      user:{ _id:usuario._id, nome:usuario.nome, email:usuario.email, role:'admin', imobiliariaId:imobId, imobiliariaSlug:slug, imobiliaria:imob },
      imobiliaria:{ nome, slug, plano: planoTrial.nome, limite: acesso.trial.limite, trialExpiracao: acesso.trial.expiraEm }
    });
    enviarBoasVindas({ email: usuario.email, responsavel, nomeConta: nome, tipo, imobiliariaId: imobId, baseUrl: getBaseUrl(req) });
  } catch(e) {
    // Desfaz o que foi criado; nunca devolve token de conta parcial.
    if (criados.imob) {
      try { await db.subscriptions.remove({ imobiliariaId: criados.imob._id }, { multi: true }); } catch(_) {}
      try { await db.usuarios.remove({ imobiliariaId: criados.imob._id }, { multi: true }); } catch(_) {}
      try { await db.imobiliarias.remove({ _id: criados.imob._id }); } catch(_) {}
    }
    res.status(500).json({ erro: 'Falha ao criar conta. Tente novamente.' });
  }
});

app.get('/api/base-url', (req, res) => res.json({ baseUrl: getBaseUrl(req) }));

// Campos que o formulário público do proprietário pré-preenche — nada além
// disso sai pela rota, mesmo que o rascunho tenha outros campos gravados.
const CAMPOS_PREENCHIMENTO_PROPRIETARIO = ['nome', 'cpf', 'nasc', 'civil', 'prof', 'zap', 'email'];
const CAMPOS_PREENCHIMENTO_IMOVEL = ['tipo', 'valor', 'end', 'num', 'comp', 'bairro', 'cidade'];

function selecionarCampos(obj, campos) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const selecionado = {};
  for (const campo of campos) {
    if (obj[campo] !== undefined) selecionado[campo] = obj[campo];
  }
  return selecionado;
}

// Identidade pública do tenant dono da autorização: só o que identifica a parte
// autorizada. Corretor autônomo sai com nome e CRECI — CPF nunca é exposto.
function identidadePublicaTenant(imob) {
  if (!imob) return null;
  const corretor = imob.tipoCliente === 'corretor';
  return {
    nome:        imob.razaoSocial || imob.nomeFantasia || imob.nome || '',
    tipoCliente: corretor ? 'corretor' : 'imobiliaria',
    documento:   corretor ? null : (imob.cnpj || null),
    creci:       imob.creci || imob.responsavel?.creci || null,
    logoUrl:     logoTenant.urlLogo(imob)
  };
}

// Buscar dados de uma autorização pelo código (para pré-preencher link assistido)
app.get('/api/autorizacoes/codigo/:codigo', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
    // Rota pública (sem auth): só o rascunho é pré-preenchível. Assinada,
    // cancelada ou inexistente respondem igual (null), sem revelar o status —
    // a consulta pública da assinada é /api/validar/:codigo, com dados mascarados.
    if (!aut || aut.status !== 'rascunho') return res.json(null);
    // Tenant sempre o da própria autorização (backend), nunca um padrão.
    const imob = aut.imobiliariaId ? await db.imobiliarias.findOne({ _id: aut.imobiliariaId }) : null;
    res.json({
      imobiliaria: identidadePublicaTenant(imob),
      preenchidoPorCorretor: aut.preenchidoPorCorretor || false,
      proprietario: selecionarCampos(aut.proprietario, CAMPOS_PREENCHIMENTO_PROPRIETARIO),
      imovel:       selecionarCampos(aut.imovel, CAMPOS_PREENCHIMENTO_IMOVEL)
    });
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno.' });
  }
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

// ═══════════════════════════════════════════════════════
// GESTÃO DE CORRETORES — Admin cadastra corretores do próprio tenant
// ═══════════════════════════════════════════════════════

// Camada de autorização reutilizável — centraliza a regra "quem pode criar
// usuário em qual tenant", antes espalhada como checagem inline em cada rota.
async function autorizarCriacaoUsuario(actor) {
  const { imob, planoTrial, acesso } = await carregarAcessoTenant(actor.imobiliariaId);
  if (!imob) return { permitido: false, status: 404, erro: 'Imobiliária não encontrada.' };
  if (imob.tipoCliente !== 'imobiliaria') {
    return { permitido: false, status: 403, erro: 'Corretor autônomo não pode cadastrar subusuários.' };
  }
  if (!acesso.podeOperar) return { permitido: false, status: 402, erro: acesso.motivo };
  // maxUsuarios conta todos os usuários do tenant, administrador incluído.
  // Em trial vale o plano 'trial', nunca o plano gravado na imobiliária.
  const plano = acesso.trial ? planoTrial : await db.planos.findOne({ _id: imob.planoId });
  const maxUsuarios = plano?.maxUsuarios ?? 1;
  if (maxUsuarios !== -1) {
    const total = await db.usuarios.count({ imobiliariaId: actor.imobiliariaId });
    if (total >= maxUsuarios) return { permitido: false, status: 403, erro: 'Limite de usuários do plano atingido.' };
  }
  return { permitido: true };
}

// Criação de usuário interno de um tenant — parâmetro `role` existe apenas
// para preparar reuso futuro; nesta micro-etapa é sempre chamado com
// role:'corretor', sem mudança de comportamento.
async function criarUsuarioTenant(actor, dados, role) {
  const { nome, email, senha, creci, telefone } = dados;
  if (!nome || !email || !senha) return { ok:false, status:422, erro:'Nome, e-mail e senha são obrigatórios.' };
  if (senha.length < 6)          return { ok:false, status:422, erro:'A senha deve ter pelo menos 6 caracteres.' };

  const autorizacao = await autorizarCriacaoUsuario(actor);
  if (!autorizacao.permitido) return { ok:false, status:autorizacao.status, erro:autorizacao.erro };

  const exEmail = await db.usuarios.findOne({ email: email.toLowerCase().trim() });
  if (exEmail) return { ok:false, status:422, erro:'E-mail já cadastrado.' };

  const hash = await bcrypt.hash(senha, 10);
  const usuario = await db.usuarios.insert({
    nome, email: email.toLowerCase().trim(), senha: hash,
    role, creci: creci||'', telefone: telefone||'',
    imobiliariaId: actor.imobiliariaId, imobiliariaSlug: actor.imobiliariaSlug,
    convidadoPor: actor.userId,
    ativo: true, criadoEm: new Date().toISOString(), atualizadoEm: new Date().toISOString()
  });

  await log('corretor', `Corretor criado: ${nome} (${email})`, null, actor.imobiliariaId);
  const { senha:_senha, ...usuarioSafe } = usuario;
  return { ok:true, usuario: usuarioSafe };
}

// Rota unificada de criação de usuário interno do tenant
app.post('/api/usuarios', authMiddleware(['admin']), async (req, res) => {
  try {
    const r = await criarUsuarioTenant(req.user, req.body, 'corretor');
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    res.json({ ok: true, usuario: r.usuario });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Criar corretor vinculado à imobiliária do Admin logado — mantida por
// compatibilidade; contrato externo idêntico, agora só delega a criarUsuarioTenant.
app.post('/api/corretores', authMiddleware(['admin']), async (req, res) => {
  try {
    const r = await criarUsuarioTenant(req.user, req.body, 'corretor');
    if (!r.ok) return res.status(r.status).json({ erro: r.erro });
    res.json({ ok: true, corretor: r.usuario });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Listar corretores do próprio tenant (Admin) — allowlist estrita de campos,
// resposta já envelopada em objeto para permitir adicionar metadados de
// paginação (total, page, pageSize) no futuro sem quebrar contrato existente.
app.get('/api/corretores', authMiddleware(['admin']), async (req, res) => {
  try {
    const lista = await db.usuarios
      .find({ imobiliariaId: req.user.imobiliariaId, role: 'corretor' })
      .sort({ nome: 1 });
    const corretores = lista.map(({ _id, nome, email, creci, telefone, ativo, criadoEm }) => ({
      _id, nome, email, creci, telefone, ativo, criadoEm
    }));
    res.json({ corretores });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Editar corretor do próprio tenant (Admin) — allowlist estrita de campos
// editáveis; findOne com _id + imobiliariaId + role:'corretor' garante que
// "não existe" e "pertence a outro tenant" retornem o mesmo 404, sem revelar
// a existência de um recurso em outro tenant. Bloqueio/reativação (ativo)
// não é editável aqui — fica reservado para PATCH /api/corretores/:id/status.
app.patch('/api/corretores/:id', authMiddleware(['admin']), async (req, res) => {
  try {
    const alvo = await db.usuarios.findOne({
      _id: req.params.id, imobiliariaId: req.user.imobiliariaId, role: 'corretor'
    });
    if (!alvo) return res.status(404).json({ erro: 'Corretor não encontrado.' });

    const { nome, email, telefone, creci } = req.body;
    const novoEmail = email !== undefined ? email.toLowerCase().trim() : undefined;

    if (novoEmail && novoEmail !== alvo.email) {
      const exEmail = await db.usuarios.findOne({ email: novoEmail });
      if (exEmail) return res.status(422).json({ erro: 'E-mail já cadastrado.' });
    }

    const upd = { atualizadoEm: new Date().toISOString() };
    if (nome !== undefined)      upd.nome = nome;
    if (novoEmail !== undefined) upd.email = novoEmail;
    if (telefone !== undefined)  upd.telefone = telefone;
    if (creci !== undefined)     upd.creci = creci;

    await db.usuarios.update({ _id: alvo._id }, { $set: upd });
    const atualizado = { ...alvo, ...upd };

    await log('corretor', `Corretor atualizado: ${atualizado.nome} (${atualizado.email})`, null, req.user.imobiliariaId);

    res.json({ ok: true, corretor: {
      _id: atualizado._id, nome: atualizado.nome, email: atualizado.email,
      telefone: atualizado.telefone, creci: atualizado.creci, ativo: atualizado.ativo,
      criadoEm: atualizado.criadoEm, atualizadoEm: atualizado.atualizadoEm
    }});
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Ativar/desativar corretor do próprio tenant (Admin) — único campo mutável é
// `ativo`; login já filtra por ativo:true, então desativar aqui já basta para
// bloquear acesso, sem precisar revogar token (expira em até 8h).
app.patch('/api/corretores/:id/status', authMiddleware(['admin']), async (req, res) => {
  try {
    const alvo = await db.usuarios.findOne({
      _id: req.params.id, imobiliariaId: req.user.imobiliariaId, role: 'corretor'
    });
    if (!alvo) return res.status(404).json({ erro: 'Corretor não encontrado.' });

    const { ativo } = req.body;
    if (typeof ativo !== 'boolean') {
      return res.status(422).json({ erro: 'Campo "ativo" deve ser booleano.' });
    }

    const upd = { ativo, atualizadoEm: new Date().toISOString() };
    await db.usuarios.update({ _id: alvo._id }, { $set: upd });
    const atualizado = { ...alvo, ...upd };

    await log('corretor',
      `${ativo ? 'Corretor ativado' : 'Corretor desativado'}: ${atualizado.nome} (${atualizado.email})`,
      null, req.user.imobiliariaId);

    res.json({ ok: true, corretor: {
      _id: atualizado._id, nome: atualizado.nome, email: atualizado.email,
      telefone: atualizado.telefone, creci: atualizado.creci, ativo: atualizado.ativo,
      criadoEm: atualizado.criadoEm, atualizadoEm: atualizado.atualizadoEm
    }});
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Redefinir senha de corretor do próprio tenant (Admin) — único campo mutável
// é `senha` (sempre re-hasheada); não retorna hash nem qualquer dado sensível,
// só confirmação { ok:true }.
app.patch('/api/corretores/:id/senha', authMiddleware(['admin']), async (req, res) => {
  try {
    const alvo = await db.usuarios.findOne({
      _id: req.params.id, imobiliariaId: req.user.imobiliariaId, role: 'corretor'
    });
    if (!alvo) return res.status(404).json({ erro: 'Corretor não encontrado.' });

    const { senha } = req.body;
    if (!senha || senha.length < 6) {
      return res.status(422).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
    }

    const hash = await bcrypt.hash(senha, 10);
    const upd = { senha: hash, atualizadoEm: new Date().toISOString() };
    await db.usuarios.update({ _id: alvo._id }, { $set: upd });

    await log('corretor', `Senha redefinida para corretor: ${alvo.nome} (${alvo.email})`, null, req.user.imobiliariaId);

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
    const reserva = await reservarAutorizacao(req.user.imobiliariaId);
    if (!reserva.ok) {
      return res.status(reserva.status).json({ erro: reserva.erro, usadas: reserva.usadas, limiteTotal: (reserva.limite||0)+(reserva.extras||0) });
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
      consumo:         reserva.consumo,
      criadoEm:        new Date().toISOString(),
      atualizadoEm:    new Date().toISOString()
    };
    const salvo = await db.autorizacoes.insert(aut);
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
    const reserva = await reservarAutorizacao(req.user.imobiliariaId);
    if (!reserva.ok) return res.status(reserva.status).json({ erro: reserva.erro });
    const codigo = await gerarCodigoUnico();
    const linkPublico = `${getBaseUrl(req)}/autorizacao/${codigo}`;
    const aut = {
      codigo, linkPublico,
      proprietario, imovel,
      tipo:            null,
      status:          'rascunho',
      consumo:         reserva.consumo,
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
// Conta na cota como qualquer outra autorização (no trial, consome a gratuita).
app.post('/api/autorizacoes/manual', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const user = req.user;

    const { proprietario, imovel, tipo, status, vencimento, corretor, inseridoManualmente } = req.body;
    if (!proprietario?.nome || !imovel?.end) return res.status(422).json({ erro: 'Dados incompletos.' });

    const reserva = await reservarAutorizacao(user.imobiliariaId);
    if (!reserva.ok) return res.status(reserva.status).json({ erro: reserva.erro });

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
      consumo:           reserva.consumo,
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
      tipo:     imob?.tipoCliente === 'corretor' ? 'corretor' : 'imobiliaria',
      razao:    imob?.razaoSocial || imob?.nomeFantasia || imob?.nome || '',
      cnpj:     imob?.tipoCliente === 'corretor' ? '' : (imob?.cnpj || ''),
      creci:    imob?.creci || imob?.responsavel?.creci || '',
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
      : null;

    const { autPdf, imobPdf } = adaptarParaPDF(aut, imob);
    imobPdf.logo = await logoTenant.lerLogo(STORAGE_BASE, imob);
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

// ═══════════════════════════════════════════════════════
// DOSSIÊ DIGITAL — estrutura oficial (Constituição Técnica, Cap. 4)
// Esta seção cria apenas a fundação estrutural do Dossiê: pastas e arquivos
// com o schema definitivo, ainda em conteúdo mínimo/placeholder. Assinatura
// do manifesto, criptografia, TSA e cadeia de custódia completa pertencem
// a sprints futuras.
// ═══════════════════════════════════════════════════════
const VERSAO_SCHEMA_DOSSIE = 1;

// Carrega a chave Ed25519 de assinatura do Dossie.
// Deriva a chave publica da propria privada.
function carregarChaveAssinaturaDossie(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('algoritmo de chave invalido');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const keyId = crypto.createHash('sha256').update(spkiDer).digest('hex');
  return {
    privateKey: privateKey,
    publicKey: publicKey,
    publicKeyPem: publicKeyPem,
    keyId: keyId
  };
}

let dossieSigningPrivateKey = null;
let dossieSigningPublicKey = null;
let dossieSigningPublicKeyPem = null;
let dossieSigningKeyId = null;

if (process.env.DOSSIE_SIGNING_PRIVATE_KEY) {
  try {
    const chave = carregarChaveAssinaturaDossie(
      process.env.DOSSIE_SIGNING_PRIVATE_KEY
    );
    dossieSigningPrivateKey = chave.privateKey;
    dossieSigningPublicKey = chave.publicKey;
    dossieSigningPublicKeyPem = chave.publicKeyPem;
    dossieSigningKeyId = chave.keyId;
  } catch (e) {
    if (process.env.NODE_ENV === 'production') {
      console.error('ERRO FATAL: chave Ed25519 do Dossie invalida.');
      process.exit(1);
    }
    console.warn('AVISO: Dossie sem assinatura criptografica do servidor.');
  }
} else if (process.env.NODE_ENV === 'production') {
  console.error('ERRO FATAL: chave Ed25519 do Dossie nao configurada.');
  process.exit(1);
} else {
  console.warn('AVISO: Dossie sem assinatura criptografica do servidor.');
}

// Chaves Ed25519 confiáveis para a verificação pública do Dossiê, indexadas
// por keyId (SHA-256 do SPKI DER, mesmo cálculo de carregarChaveAssinaturaDossie).
// A chave derivada de DOSSIE_SIGNING_PRIVATE_KEY entra automaticamente;
// DOSSIE_TRUSTED_PUBLIC_KEYS (opcional) acrescenta chaves históricas em
// SPKI PEM. Erros usam códigos fixos, nunca conteúdo de chave no log.
function carregarChavesPublicasConfiaveisDossie(conteudo) {
  const padraoBloco = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
  const blocos = conteudo.match(padraoBloco) || [];
  if (blocos.length === 0) throw new Error('nenhuma_chave');
  if (conteudo.replace(padraoBloco, '').trim() !== '') throw new Error('conteudo_invalido');
  return blocos.map((bloco) => {
    if (!bloco.startsWith('-----BEGIN PUBLIC KEY-----') || !bloco.endsWith('-----END PUBLIC KEY-----')) {
      throw new Error('bloco_nao_publico');
    }
    let publicKey;
    try {
      publicKey = crypto.createPublicKey(bloco);
    } catch {
      throw new Error('chave_ilegivel');
    }
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('algoritmo_invalido');
    const keyId = crypto.createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    return { keyId, publicKey };
  });
}

const dossieChavesConfiaveis = new Map();

if (dossieSigningKeyId) {
  dossieChavesConfiaveis.set(dossieSigningKeyId, dossieSigningPublicKey);
}

if ((process.env.DOSSIE_TRUSTED_PUBLIC_KEYS || '').trim()) {
  try {
    const chaves = carregarChavesPublicasConfiaveisDossie(process.env.DOSSIE_TRUSTED_PUBLIC_KEYS);
    for (const { keyId, publicKey } of chaves) dossieChavesConfiaveis.set(keyId, publicKey);
  } catch (e) {
    if (process.env.NODE_ENV === 'production') {
      console.error(`ERRO FATAL: DOSSIE_TRUSTED_PUBLIC_KEYS invalida (${e.message}).`);
      process.exit(1);
    }
    console.warn(`AVISO: DOSSIE_TRUSTED_PUBLIC_KEYS invalida (${e.message}); ignorada.`);
  }
}

// Configuração do carimbo de tempo RFC 3161 (Marco 5 — TSA). Mesmo padrão
// da chave Ed25519: em produção, ausente/incompleta/inválida é erro fatal;
// em desenvolvimento, o Dossiê segue com carimboTempo 'nao_configurado'.
// Só o código do erro é registrado — nunca valores das variáveis.
let configuracaoTsa = null;

try {
  configuracaoTsa = carregarConfiguracaoTsa(process.env);
} catch (e) {
  if (process.env.NODE_ENV === 'production') {
    console.error(`ERRO FATAL: configuracao TSA invalida (${e.codigo || 'desconhecido'}).`);
    process.exit(1);
  }
  console.warn(`AVISO: configuracao TSA invalida (${e.codigo || 'desconhecido'}); Dossie sem carimbo de tempo.`);
}

if (!configuracaoTsa) {
  if (process.env.NODE_ENV === 'production') {
    console.error('ERRO FATAL: TSA do Dossie nao configurado (TSA_URL e TSA_TRUSTED_ROOTS).');
    process.exit(1);
  }
  console.warn('AVISO: Dossie sem carimbo de tempo RFC 3161.');
}

// Assina os 32 bytes do hashRaiz com Ed25519 e verifica a
// propria assinatura antes de devolve-la.
function assinarHashRaizDossie(hashRaiz) {
  if (!dossieSigningPrivateKey) {
    return null;
  }

  const dados = Buffer.from(hashRaiz, 'hex');

  const assinaturaBuffer = crypto.sign(
    null,
    dados,
    dossieSigningPrivateKey
  );

  const assinaturaValida = crypto.verify(
    null,
    dados,
    dossieSigningPublicKey,
    assinaturaBuffer
  );

  if (assinaturaValida !== true) {
    throw new Error('falha na verificacao da assinatura do Dossie');
  }

  return {
    algoritmo: 'Ed25519',
    keyId: dossieSigningKeyId,
    valor: assinaturaBuffer.toString('base64'),
    encoding: 'base64',
    assinadoEm: new Date().toISOString(),
    hashRaiz: hashRaiz,
    chavePublica: dossieSigningPublicKeyPem
  };
}

// Categorias fixas de evidência do Dossiê — única fonte da verdade, usada
// tanto para criar as subpastas físicas quanto para o índice do manifesto.
const CATEGORIAS_DOSSIE = ['assinatura', 'biometria', 'documentos', 'anexos', 'assinantes_adicionais', 'custodia'];

// Resolve o caminho do Dossiê a partir do código e da data de assinatura.
// Nenhuma outra função deve recalcular esse caminho — ele é gravado no NeDB
// e sempre lido de lá (Constituição, Cap. 4).
function resolverCaminhoDossie(codigo, assinadoEm) {
  const data = new Date(assinadoEm);
  const ano  = String(data.getFullYear());
  const mes  = String(data.getMonth() + 1).padStart(2, '0');
  const relativo = path.join('dossies', ano, mes, codigo);
  return { relativo, absoluto: path.join(STORAGE_BASE, relativo) };
}

// Cria a árvore de diretórios do Dossiê (raiz + subpastas de evidência).
function criarEstruturaDossie(absoluto) {
  fs.mkdirSync(absoluto, { recursive: true });
  CATEGORIAS_DOSSIE.forEach(p =>
    fs.mkdirSync(path.join(absoluto, p), { recursive: true })
  );
}

// Grava o manifesto.json — índice estrutural do Dossiê. Não contém dado
// pessoal do proprietário (esse dado já pertence ao documento da autorização
// no NeDB); só referências e metadados necessários para auditoria/preservação.
// write-once: gravado apenas aqui, nunca reescrito (Constituição Técnica,
// Cap. 4 — Decisão 1 da Micro-Sprint 8.2.A). Informação operacional mutável
// (status de preservação, verificação de integridade) pertence exclusivamente
// a metadata.json.
// Conta evidências reais por categoria a partir de aut.evidenciasRecebidas —
// mesma fonte e mesma validação de categoria já usadas por criarHashes
// (categoriaDoCaminhoRelativo, Marco 5.2). Não lê nem duplica hashes.json,
// só resume quantidade por categoria. Ordem determinística: segue a ordem
// de iteração de CATEGORIAS_EVIDENCIA_VALIDAS.
function contarEvidenciasPorCategoria(aut) {
  const arquivos = aut.evidenciasRecebidas?.arquivos || [];
  const contagem = {};
  CATEGORIAS_EVIDENCIA_VALIDAS.forEach((categoria) => { contagem[categoria] = 0; });
  arquivos.forEach((arquivo) => {
    const categoria = categoriaDoCaminhoRelativo(arquivo.caminhoRelativo);
    contagem[categoria] += 1;
  });
  return contagem;
}

// Monta o campo componentes do manifesto — status real de cada peça do
// Dossiê no instante em que o manifesto é gravado (Microetapa 5.3). Chaves
// lógicas estáveis (não nomes de arquivo), com o caminho relativo declarado
// em cada uma. metadata/timeline/custodia já existem em disco nesse ponto
// (nova ordem em criarEstruturaInicialDossie: gravados antes do manifesto)
// — presenteNoMomentoDoManifesto vem de fs.existsSync real, nunca presumido.
// hashes só pode ser gravado depois do manifesto (hashManifesto depende do
// conteúdo já gravado do manifesto — ver criarHashes), por isso
// presenteNoMomentoDoManifesto é sempre false e ordemGeracao documenta que
// vem em seguida, na mesma operação. pdfOficial.presenteNoMomentoDoManifesto
// reflete o estado real do PDF, já gerado antes do Dossiê na rota de
// assinatura (gerarESalvarPDFAssinatura), reaproveitando o caminho canônico
// já existente (caminhoPdfAssinatura, Marco 4). evidencias só resume
// quantidade por categoria — detalhe (hash, caminho, mimeType) continua
// exclusivamente em hashes.json, sem duplicação. Nenhum hash é recalculado,
// nenhum arquivo é copiado ou movido.
function montarComponentesManifesto(absoluto, aut, { eventosTimeline, eventosCustodia }) {
  const evidenciasPorCategoria = contarEvidenciasPorCategoria(aut);
  const categorias = {};
  CATEGORIAS_EVIDENCIA_VALIDAS.forEach((categoria) => {
    const quantidade = evidenciasPorCategoria[categoria];
    categorias[categoria] = { quantidade, estado: quantidade > 0 ? 'presente' : 'vazio' };
  });

  return {
    hashes: {
      caminho: 'hashes.json',
      presenteNoMomentoDoManifesto: false,
      ordemGeracao: 'apos_manifesto'
    },
    metadata: {
      caminho: 'metadata.json',
      presenteNoMomentoDoManifesto: fs.existsSync(path.join(absoluto, 'metadata.json')),
      estadoConteudo: 'parcial'
    },
    timeline: {
      caminho: 'timeline.json',
      presenteNoMomentoDoManifesto: fs.existsSync(path.join(absoluto, 'timeline.json')),
      estadoConteudo: eventosTimeline.length > 0 ? 'preenchido' : 'vazio'
    },
    custodia: {
      caminho: 'custodia/eventos.json',
      presenteNoMomentoDoManifesto: fs.existsSync(path.join(absoluto, 'custodia', 'eventos.json')),
      estadoConteudo: eventosCustodia.length > 0 ? 'preenchido' : 'vazio'
    },
    pdfOficial: {
      caminho: `assinados/${aut.codigo}.pdf`,
      presenteNoMomentoDoManifesto: fs.existsSync(caminhoPdfAssinatura(aut.codigo))
    },
    evidencias: {
      detalhesEm: 'hashes.json',
      categorias
    }
  };
}

function criarManifesto(absoluto, aut, { eventosTimeline, eventosCustodia }) {
  const manifesto = {
    versaoSchema:  VERSAO_SCHEMA_DOSSIE,
    codigo:        aut.codigo,
    versaoFluxo:     null,
    versaoDocumento: null,
    versaoSistema:   null,
    imobiliariaId: aut.imobiliariaId || null,
    corretorId:    aut.corretorId    || null,
    estrutura: {
      categorias: CATEGORIAS_DOSSIE,
      arquivosIndice: {
        hashes:   'hashes.json',
        metadata: 'metadata.json',
        timeline: 'timeline.json',
        custodia: 'custodia/eventos.json'
      }
    },
    componentes:       montarComponentesManifesto(
      absoluto,
      aut,
      { eventosTimeline, eventosCustodia }
    ),
    criadoEm:          aut.criadoEm   || null,
    assinadoEm:        aut.assinadoEm || null,
    preservadoEm:      new Date().toISOString(),
    origem:            'nativo',
    politicaAssinaturaId: null,
    politicaVersao:       null
  };
  fs.writeFileSync(path.join(absoluto, 'manifesto.json'), JSON.stringify(manifesto, null, 2));
}

// Calcula o hash SHA-256 do conteúdo real de um arquivo do Dossiê já
// gravado em disco — hash do arquivo, não de uma reconstrução em memória,
// para que a verificação futura seja sempre "reler o arquivo e recalcular".
function calcularHashArquivoDossie(absoluto, caminhoRelativo) {
  const conteudo = fs.readFileSync(path.join(absoluto, caminhoRelativo));
  return crypto.createHash('sha256').update(conteudo).digest('hex');
}

// Calcula o hash do manifesto.json utilizando o helper genérico de hash
// dos arquivos oficiais do Dossiê Digital.
function calcularHashManifesto(absoluto) {
  return calcularHashArquivoDossie(absoluto, 'manifesto.json');
}

// Grava o hashes.json — núcleo imutável de integridade.
// Categorias reais de evidência do catálogo oficial
// (CATALOGO_ARQUIVOS_INCOMING, src/services/evidence/constants.js).
// Não inclui 'custodia' — essa não é uma categoria de arquivo de evidência,
// é a trilha de custódia do próprio Dossiê (criarCustodiaEventos).
const CATEGORIAS_EVIDENCIA_VALIDAS = new Set(['assinatura', 'biometria', 'documentos', 'assinantes_adicionais', 'anexos']);

// Extrai e valida a categoria a partir de caminhoRelativo — formato
// "categoria/nome" garantido pelo catálogo oficial. categoria não existe
// como campo próprio em nenhum objeto do pipeline de evidências hoje; nunca
// aceita caminho malformado ou categoria fora do conjunto oficial em silêncio.
function categoriaDoCaminhoRelativo(caminhoRelativo) {
  if (typeof caminhoRelativo !== 'string' || caminhoRelativo.length === 0) {
    throw new Error(`Dossiê: caminhoRelativo de evidência inválido: ${String(caminhoRelativo)}`);
  }
  const partes = caminhoRelativo.split('/');
  if (partes.length !== 2 || !partes[0] || !partes[1]) {
    throw new Error(`Dossiê: caminhoRelativo fora do formato categoria/nome: ${caminhoRelativo}`);
  }
  const [categoria] = partes;
  if (!CATEGORIAS_EVIDENCIA_VALIDAS.has(categoria)) {
    throw new Error(`Dossiê: categoria de evidência desconhecida: ${categoria}`);
  }
  return categoria;
}

// Referencia (sem copiar/mover) os arquivos já gravados pelo EvidenceStorage,
// usando exclusivamente dados já persistidos em aut.evidenciasRecebidas —
// nenhum hash recalculado, nenhum acesso a disco, nenhuma mutação da lista
// original. Autorizações sem evidenciasRecebidas (nenhuma hoje, mas sem
// pressupor) resultam em lista vazia. Ordenada por caminhoRelativo para não
// depender da ordem de submissão do formulário (Marco 5.2).
function montarArquivosEvidenciaParaHashes(aut) {
  const arquivos = aut.evidenciasRecebidas?.arquivos || [];
  const caminhoIncoming = aut.evidenciasRecebidas?.caminhoIncoming || '';

  const lista = arquivos.map((arquivo) => ({
    categoria:       categoriaDoCaminhoRelativo(arquivo.caminhoRelativo),
    caminhoRelativo: arquivo.caminhoRelativo,
    caminhoStorage:  path.posix.join(caminhoIncoming, arquivo.caminhoRelativo),
    mimeType:        arquivo.mimeType,
    tamanhoBytes:    arquivo.tamanhoBytes,
    sha256:          arquivo.sha256,
    criadoEm:        arquivo.criadoEm
  }));

  return lista.sort((a, b) => a.caminhoRelativo.localeCompare(b.caminhoRelativo));
}

// Calcula o SHA-256 agregado sobre o conjunto protegido do Dossiê — hash
// canônico agregado (opção aprovada na auditoria do hash raiz), não Merkle
// Tree. Conjunto protegido: hashDadosAutorizacao, hashEvidencias, os sha256
// de arquivos (na ordem determinística já existente) e os sha256 de cada
// componentesDossie (manifesto, timeline, custodia, pdfOficial). Nunca
// inclui metadata.json (mutável), assinadoPeloServidor/carimboTempo (ainda
// não preenchidos nesta fase — incluí-los invalidaria retroativamente o
// hashRaiz quando forem preenchidos) nem o próprio hashRaiz. Recebe o
// objeto hashes já montado (antes de hashRaiz existir nele) e só lê dele os
// campos do conjunto protegido — nunca serializa hashes.json inteiro, para
// que o valor seja sempre recalculável relendo apenas os campos já
// persistidos em hashes.json.
function calcularHashRaizDossie(hashes) {
  const conjuntoProtegido = {
    hashDadosAutorizacao: hashes.hashDadosAutorizacao,
    hashEvidencias:       hashes.hashEvidencias,
    arquivos:             hashes.arquivos.map((arquivo) => arquivo.sha256),
    componentesDossie: {
      manifesto:  hashes.componentesDossie.manifesto.sha256,
      timeline:   hashes.componentesDossie.timeline.sha256,
      custodia:   hashes.componentesDossie.custodia.sha256,
      pdfOficial: hashes.componentesDossie.pdfOficial.sha256
    }
  };
  return crypto.createHash('sha256').update(serializarCanonico(conjuntoProtegido)).digest('hex');
}

// Representação protegida pelo carimbo de tempo RFC 3161: hashRaiz mais a
// assinatura Ed25519 que o cobre, para provar que ambos existiam em genTime.
// Só esses quatro campos, serializados canonicamente; carimboTempo nunca
// entra no hashRaiz. Devolve os bytes canônicos e o SHA-256 deles.
function calcularDigestCarimboTempo(hashes) {
  const representacao = Buffer.from(serializarCanonico({
    algoritmo:  hashes.assinatura.algoritmo,
    hashRaiz:   hashes.hashRaiz,
    keyId:      hashes.assinatura.keyId,
    assinatura: hashes.assinatura.valor
  }), 'utf8');
  return {
    representacao,
    digest: crypto.createHash('sha256').update(representacao).digest()
  };
}

async function criarHashes(absoluto, aut) {
  const hashes = {
    versaoSchema: VERSAO_SCHEMA_DOSSIE,

    // Versão do formato específico de hashes.json.
    // Independente da versão global do schema do Dossiê Digital.
    versaoFormatoHashes: 2,

    algoritmo:    'SHA-256',
    hashDadosAutorizacao: aut.hashDadosAutorizacao || null,
    hashEvidencias:       aut.registroAssinatura?.hashEvidencias || null,
    arquivos:             montarArquivosEvidenciaParaHashes(aut),
    componentesDossie: {
      manifesto: {
        caminho: 'manifesto.json',
        sha256: calcularHashArquivoDossie(absoluto, 'manifesto.json')
      },
      timeline: {
        caminho: 'timeline.json',
        sha256: calcularHashArquivoDossie(absoluto, 'timeline.json')
      },
      custodia: {
        caminho: 'custodia/eventos.json',
        sha256: calcularHashArquivoDossie(absoluto, 'custodia/eventos.json')
      },
      pdfOficial: {
        caminho: `assinados/${aut.codigo}.pdf`,
        sha256: calcularHashArquivoDossie(
          path.dirname(caminhoPdfAssinatura(aut.codigo)),
          path.basename(caminhoPdfAssinatura(aut.codigo))
        )
      }
    },
    assinadoPeloServidor: false,
    carimboTempo:         null
  };
  hashes.hashRaiz = calcularHashRaizDossie(hashes);

  const assinatura = assinarHashRaizDossie(hashes.hashRaiz);

  if (assinatura) {
    hashes.assinatura = assinatura;
    hashes.assinadoPeloServidor = true;
  } else {
    hashes.assinatura = null;
    hashes.assinadoPeloServidor = false;
  }

  // Sem assinatura Ed25519 (só em desenvolvimento) não há o que carimbar.
  // Falha da TSA nunca impede a gravação: fica registrada em carimboTempo.
  if (hashes.assinatura) {
    hashes.carimboTempo = await solicitarCarimboTempo(calcularDigestCarimboTempo(hashes), configuracaoTsa);
    hashes.carimboTempo.representacao = {
      campos: ['algoritmo', 'hashRaiz', 'keyId', 'assinatura'],
      serializacao: 'canonica-v1'
    };
    if (configuracaoTsa && hashes.carimboTempo.status !== 'valido') {
      console.warn(`AVISO: carimbo de tempo do Dossie ${aut.codigo} nao obtido (${hashes.carimboTempo.status}/${hashes.carimboTempo.motivo}).`);
    }
  } else {
    hashes.carimboTempo = {
      padrao:        'RFC3161',
      status:        'nao_aplicado',
      motivo:        'sem_assinatura_servidor',
      algoritmoHash: 'SHA-256',
      hashCarimbado: null,
      tentadoEm:     null,
      token:         null
    };
  }

  fs.writeFileSync(path.join(absoluto, 'hashes.json'), JSON.stringify(hashes, null, 2));
}

// Grava o metadata.json — bookkeeping operacional, mutável.
function criarMetadata(absoluto) {
  const metadata = {
    versaoSchema: VERSAO_SCHEMA_DOSSIE,
    statusPreservacao: 'ativo',
    ultimaVerificacaoIntegridade: null,
    tags: []
  };
  fs.writeFileSync(path.join(absoluto, 'metadata.json'), JSON.stringify(metadata, null, 2));
}

// Grava o timeline.json — serializa eventosTimeline, já filtrado por
// categoria 'timeline'/'ambas' exclusivamente em criarEstruturaInicialDossie
// (Microetapa 5.5.5). Não filtra, não reconstrói, não gera evento algum —
// só recebe o array pronto e grava. Contrato de eventosTimeline (array) já
// garantido por quem chama.
function criarTimeline(absoluto, eventosTimeline) {
  const timeline = { versaoSchema: VERSAO_SCHEMA_DOSSIE, eventos: eventosTimeline };
  fs.writeFileSync(path.join(absoluto, 'timeline.json'), JSON.stringify(timeline, null, 2));
}

// Grava o custodia/eventos.json — serializa eventosCustodia, já filtrado por
// categoria 'custodia'/'ambas' exclusivamente em criarEstruturaInicialDossie
// (Microetapa 5.5.5). Mesmas garantias de criarTimeline: sem filtro, sem
// reconstrução, sem geração, array já pronto recebido por parâmetro.
function criarCustodiaEventos(absoluto, eventosCustodia) {
  const eventos = { versaoSchema: VERSAO_SCHEMA_DOSSIE, eventos: eventosCustodia };
  fs.writeFileSync(path.join(absoluto, 'custodia', 'eventos.json'), JSON.stringify(eventos, null, 2));
}

// Orquestra a criação dos arquivos do Dossiê — cada arquivo continua sendo
// responsabilidade de uma função própria; esta só coordena a sequência.
// Valida o contrato de eventosNormalizados ANTES de qualquer gravação —
// nenhuma pasta/arquivo é criado se o argumento for inválido, evitando
// Dossiê parcialmente criado em disco (Microetapa 5.5.4). Único ponto de
// filtragem por categoria do Dossiê (Microetapa 5.5.5): eventosTimeline e
// eventosCustodia são derivados aqui, uma única vez, e repassados prontos
// para Timeline, Custódia e Manifesto — nenhuma dessas funções filtra por
// conta própria.
async function criarEstruturaInicialDossie(absoluto, aut, eventosNormalizados) {
  if (!Array.isArray(eventosNormalizados)) {
    throw new TypeError(
      'criarEstruturaInicialDossie: eventosNormalizados deve ser um array.'
    );
  }
  const eventosTimeline = eventosNormalizados.filter(
    (evento) => evento.categoria === 'timeline' || evento.categoria === 'ambas'
  );
  const eventosCustodia = eventosNormalizados.filter(
    (evento) => evento.categoria === 'custodia' || evento.categoria === 'ambas'
  );

  criarEstruturaDossie(absoluto);
  criarMetadata(absoluto);
  criarTimeline(absoluto, eventosTimeline);
  criarCustodiaEventos(absoluto, eventosCustodia);
  criarManifesto(absoluto, aut, { eventosTimeline, eventosCustodia });
  await criarHashes(absoluto, aut);
}

// Cria o Dossiê Digital completo para uma autorização recém-assinada e
// persiste seu caminho no NeDB. Falha aqui NÃO desfaz a assinatura já
// persistida (mesmo padrão de tolerância a erro já usado em
// gerarESalvarPDFAssinatura) — apenas registra aviso no log.
async function criarDossieDigital(aut, eventosNormalizados) {
  try {
    const { relativo, absoluto } = resolverCaminhoDossie(aut.codigo, aut.assinadoEm);
    await criarEstruturaInicialDossie(absoluto, aut, eventosNormalizados);
    await db.autorizacoes.update({ codigo: aut.codigo }, { $set: { dossiePath: relativo } });
  } catch (e) {
    await log(
      'aviso',
      `Falha ao criar estrutura do Dossiê Digital da autorização ${aut.codigo}: ${e.message}`,
      null,
      aut.imobiliariaId || null
    );
    throw e;
  }
}

// ═══════════════════════════════════════════════════════
// VERIFICAÇÃO PÚBLICA DO DOSSIÊ (Marco 5) — somente leitura.
// integridade = conteúdo protegido por hashRaiz + assinatura Ed25519.
// carimboTempo = verificação RFC 3161 separada; não é protegido pelo
// hashRaiz e nunca altera o resultado da integridade.
// ═══════════════════════════════════════════════════════
const HEX_SHA256 = /^[0-9a-f]{64}$/;

const MENSAGENS_VERIFICACAO_DOSSIE = {
  integro_com_carimbo: 'Dossiê Digital íntegro: conteúdo e assinatura do servidor conferem, com carimbo de tempo RFC 3161 válido.',
  integro_sem_carimbo: 'Dossiê Digital íntegro: conteúdo e assinatura do servidor conferem. Carimbo de tempo RFC 3161 ausente ou não verificável.',
  inconsistente:       'O Dossiê Digital desta autorização não confere com os registros oficiais.',
  nao_disponivel:      'Não existe Dossiê Digital disponível para verificação desta autorização.'
};

// Inconsistência detectada na verificação. A mensagem é sempre um código
// fixo — nunca caminho, conteúdo ou detalhe de exceção.
class InconsistenciaDossie extends Error {
  constructor(motivo) {
    super(motivo);
    this.motivo = motivo;
  }
}

function inconsistenciaDossie(motivo) {
  throw new InconsistenciaDossie(motivo);
}

// Resolve `relativo` a partir de `base` e exige que o resultado fique
// estritamente dentro de `limite` — recusa '..', caminho absoluto e
// qualquer escape por normalização.
function resolverCaminhoContido(base, relativo, limite) {
  if (typeof relativo !== 'string' || relativo.length === 0 || relativo.includes('\0')) {
    inconsistenciaDossie('caminho_invalido');
  }
  const alvo = path.resolve(base, relativo);
  if (!alvo.startsWith(path.resolve(limite) + path.sep)) {
    inconsistenciaDossie('caminho_invalido');
  }
  return alvo;
}

// Relê o arquivo e compara o SHA-256 atual com o gravado (mesma função de
// hash usada na criação do Dossiê).
function conferirHashArquivoDossie(caminhoAbsoluto, sha256Gravado, tipo) {
  if (typeof sha256Gravado !== 'string' || !HEX_SHA256.test(sha256Gravado)) {
    inconsistenciaDossie(`${tipo}_formato_invalido`);
  }
  let atual;
  try {
    atual = calcularHashArquivoDossie(path.dirname(caminhoAbsoluto), path.basename(caminhoAbsoluto));
  } catch {
    inconsistenciaDossie(`${tipo}_ilegivel`);
  }
  if (atual !== sha256Gravado) inconsistenciaDossie(`${tipo}_divergente`);
}

// Normaliza uma lista de evidências para o par caminhoRelativo → sha256,
// ordenada por caminhoRelativo, sem modificar a lista original. Recusa
// formato inválido e caminhoRelativo duplicado.
function normalizarArquivosEvidencia(lista) {
  const vistos = new Set();
  const normalizada = lista.map((arquivo) => {
    if (!arquivo || typeof arquivo !== 'object' ||
        typeof arquivo.caminhoRelativo !== 'string' || arquivo.caminhoRelativo.length === 0 ||
        typeof arquivo.sha256 !== 'string' || !HEX_SHA256.test(arquivo.sha256)) {
      inconsistenciaDossie('evidencia_formato_invalido');
    }
    if (vistos.has(arquivo.caminhoRelativo)) inconsistenciaDossie('evidencia_duplicada');
    vistos.add(arquivo.caminhoRelativo);
    return { caminhoRelativo: arquivo.caminhoRelativo, sha256: arquivo.sha256 };
  });
  return normalizada.sort((a, b) => {
    if (a.caminhoRelativo < b.caminhoRelativo) return -1;
    if (a.caminhoRelativo > b.caminhoRelativo) return 1;
    return 0;
  });
}

// Conteúdo protegido: caminho do Dossiê, hashes.json, vínculo com o NeDB,
// evidências, componentes oficiais e hashRaiz. Devolve hashes já conferido.
function conferirConteudoProtegidoDossie(aut) {
  // Caminho do Dossiê: só a partir do dossiePath persistido, contido em
  // STORAGE_BASE/dossies e no formato AAAA/MM/<codigo>.
  const baseDossies = path.resolve(STORAGE_BASE, 'dossies');
  const absoluto = resolverCaminhoContido(STORAGE_BASE, aut.dossiePath, baseDossies);
  const partesDossie = path.relative(baseDossies, absoluto).split(path.sep);
  if (partesDossie.length !== 3 || !/^\d{4}$/.test(partesDossie[0]) ||
      !/^\d{2}$/.test(partesDossie[1]) || partesDossie[2] !== aut.codigo) {
    inconsistenciaDossie('caminho_invalido');
  }

  let hashes;
  try {
    hashes = JSON.parse(fs.readFileSync(path.join(absoluto, 'hashes.json'), 'utf8'));
  } catch {
    inconsistenciaDossie('hashes_ilegivel');
  }
  if (!hashes || typeof hashes !== 'object' ||
      hashes.versaoFormatoHashes !== 2 || hashes.algoritmo !== 'SHA-256' ||
      !Array.isArray(hashes.arquivos) ||
      !hashes.componentesDossie || typeof hashes.componentesDossie !== 'object' ||
      typeof hashes.hashRaiz !== 'string' || !HEX_SHA256.test(hashes.hashRaiz)) {
    inconsistenciaDossie('hashes_formato_invalido');
  }

  // Vínculo NeDB ↔ Dossiê: os dados públicos exibidos saem do NeDB e
  // precisam corresponder aos hashes protegidos pelo hashRaiz.
  if (hashes.hashDadosAutorizacao !== aut.hashDadosAutorizacao ||
      hashes.hashDadosAutorizacao !== calcularHashDadosAutorizacao(aut)) {
    inconsistenciaDossie('vinculo_autorizacao_divergente');
  }
  const registro = aut.registroAssinatura;
  if (!registro || typeof registro !== 'object') inconsistenciaDossie('vinculo_evidencias_divergente');
  // hashEvidencias é calculado sobre o registroAssinatura antes de o
  // próprio campo hashEvidencias ser acrescentado a ele.
  const { hashEvidencias: hashEvidenciasRegistro, ...registroSemHash } = registro;
  if (hashes.hashEvidencias !== hashEvidenciasRegistro ||
      hashes.hashEvidencias !== calcularHashEvidencias(registroSemHash)) {
    inconsistenciaDossie('vinculo_evidencias_divergente');
  }

  // Evidências: localizadas pela pasta de incoming persistida no NeDB e pelo
  // caminhoRelativo validado (categoria/nome) — nunca por caminhoStorage.
  const baseTenants = path.resolve(STORAGE_BASE, 'tenants');
  const dirIncoming = resolverCaminhoContido(STORAGE_BASE, aut.evidenciasRecebidas?.caminhoIncoming, baseTenants);
  const partesIncoming = path.relative(baseTenants, dirIncoming).split(path.sep);
  if (partesIncoming.length !== 3 || partesIncoming[1] !== 'incoming' || partesIncoming[2] !== aut.codigo) {
    inconsistenciaDossie('caminho_invalido');
  }
  // O hashRaiz cobre só a lista de sha256, não o par caminhoRelativo →
  // sha256; esse par é ancorado item a item em evidenciasRecebidas.arquivos
  // persistido no NeDB.
  const arquivosRegistro = aut.evidenciasRecebidas?.arquivos;
  if (!Array.isArray(arquivosRegistro) || arquivosRegistro.length !== hashes.arquivos.length) {
    inconsistenciaDossie('vinculo_arquivos_divergente');
  }
  const arquivosDossie = normalizarArquivosEvidencia(hashes.arquivos);
  const arquivosNeDB = normalizarArquivosEvidencia(arquivosRegistro);
  arquivosDossie.forEach((arquivo, indice) => {
    if (arquivo.caminhoRelativo !== arquivosNeDB[indice].caminhoRelativo ||
        arquivo.sha256 !== arquivosNeDB[indice].sha256) {
      inconsistenciaDossie('vinculo_arquivos_divergente');
    }
  });
  for (const arquivo of hashes.arquivos) {
    if (!arquivo || typeof arquivo !== 'object') inconsistenciaDossie('evidencia_formato_invalido');
    try {
      categoriaDoCaminhoRelativo(arquivo.caminhoRelativo);
    } catch {
      inconsistenciaDossie('evidencia_formato_invalido');
    }
    const caminhoEvidencia = resolverCaminhoContido(dirIncoming, arquivo.caminhoRelativo, dirIncoming);
    conferirHashArquivoDossie(caminhoEvidencia, arquivo.sha256, 'evidencia');
  }

  // Componentes oficiais em caminhos fixos; o PDF oficial sempre pelo
  // caminho canônico do código, nunca pelo texto gravado.
  const componentes = hashes.componentesDossie;
  const caminhosComponentes = {
    manifesto: 'manifesto.json',
    timeline:  'timeline.json',
    custodia:  'custodia/eventos.json'
  };
  for (const [nome, caminhoRelativo] of Object.entries(caminhosComponentes)) {
    const componente = componentes[nome];
    if (!componente || componente.caminho !== caminhoRelativo) inconsistenciaDossie('componente_formato_invalido');
    conferirHashArquivoDossie(resolverCaminhoContido(absoluto, caminhoRelativo, absoluto), componente.sha256, 'componente');
  }
  const pdfOficial = componentes.pdfOficial;
  if (!pdfOficial || pdfOficial.caminho !== `assinados/${aut.codigo}.pdf`) {
    inconsistenciaDossie('componente_formato_invalido');
  }
  conferirHashArquivoDossie(caminhoPdfAssinatura(aut.codigo), pdfOficial.sha256, 'componente');

  // hashRaiz pela mesma função canônica da criação.
  if (calcularHashRaizDossie(hashes) !== hashes.hashRaiz) inconsistenciaDossie('hash_raiz_divergente');

  return hashes;
}

// Assinatura Ed25519 do servidor sobre os 32 bytes do hashRaiz. O keyId
// precisa pertencer a dossieChavesConfiaveis (chave atual ou histórica
// configurada); a chave pública embutida no Dossiê só é conferida por
// coerência com o keyId, e crypto.verify usa sempre a chave confiável.
function conferirAssinaturaServidorDossie(hashes) {
  const assinatura = hashes.assinatura;
  if (!assinatura || typeof assinatura !== 'object' || hashes.assinadoPeloServidor !== true) {
    inconsistenciaDossie('assinatura_ausente');
  }
  if (assinatura.algoritmo !== 'Ed25519' || assinatura.encoding !== 'base64' ||
      assinatura.hashRaiz !== hashes.hashRaiz || typeof assinatura.valor !== 'string' ||
      typeof assinatura.chavePublica !== 'string' || typeof assinatura.keyId !== 'string') {
    inconsistenciaDossie('assinatura_formato_invalido');
  }
  const chaveConfiavel = dossieChavesConfiaveis.get(assinatura.keyId);
  if (!chaveConfiavel) inconsistenciaDossie('assinatura_chave_nao_confiavel');
  let chavePublicaEmbutida;
  try {
    chavePublicaEmbutida = crypto.createPublicKey(assinatura.chavePublica);
  } catch {
    inconsistenciaDossie('assinatura_chave_invalida');
  }
  if (chavePublicaEmbutida.asymmetricKeyType !== 'ed25519') inconsistenciaDossie('assinatura_chave_invalida');
  const keyIdEmbutida = crypto.createHash('sha256')
    .update(chavePublicaEmbutida.export({ type: 'spki', format: 'der' }))
    .digest('hex');
  if (keyIdEmbutida !== assinatura.keyId) inconsistenciaDossie('assinatura_keyid_divergente');
  const valor = Buffer.from(assinatura.valor, 'base64');
  if (valor.length !== 64 || valor.toString('base64') !== assinatura.valor) {
    inconsistenciaDossie('assinatura_formato_invalido');
  }
  if (crypto.verify(null, Buffer.from(hashes.hashRaiz, 'hex'), chaveConfiavel, valor) !== true) {
    inconsistenciaDossie('assinatura_invalida');
  }
}

// Carimbo de tempo, verificado à parte: hashCarimbado precisa corresponder
// à representação canônica atual e, quando gravado como 'valido', o token é
// validado offline. Sem TSA_TRUSTED_ROOTS o token fica 'nao_verificavel'.
async function conferirCarimboTempoDossie(hashes) {
  const carimbo = hashes.carimboTempo;
  if (carimbo === null || carimbo === undefined) return { situacao: 'nao_disponivel' };
  if (typeof carimbo !== 'object' || carimbo.padrao !== 'RFC3161') {
    return { situacao: 'invalido', motivo: 'carimbo_formato_invalido' };
  }
  const { representacao, digest } = calcularDigestCarimboTempo(hashes);
  if (carimbo.hashCarimbado !== digest.toString('hex')) {
    return { situacao: 'invalido', motivo: 'hash_carimbado_divergente' };
  }
  switch (carimbo.status) {
    case 'valido':
      return verificarTokenArmazenado(carimbo, { representacao, digest }, configuracaoTsa ? configuracaoTsa.raizes : null);
    case 'indisponivel':
    case 'falha_validacao':
      return { situacao: 'indisponivel' };
    case 'nao_configurado':
      return { situacao: 'nao_configurado' };
    default:
      return { situacao: 'invalido', motivo: 'carimbo_status_desconhecido' };
  }
}

// Autorização assinada pelo fluxo que exige Dossiê Digital: só esse fluxo
// grava evidenciasRecebidas. Critério único usado pela idempotência da
// assinatura e por verificarIntegridadeDossie (Marco 6, Bloqueador 2).
function pertenceAoFluxoComDossie(aut) {
  return Boolean(aut && aut.evidenciasRecebidas);
}

// Verificação completa, somente leitura. Inconsistências viram veredito
// 'inconsistente'; exceção inesperada (defeito interno) é propagada.
async function verificarIntegridadeDossie(aut) {
  if (!aut.dossiePath && pertenceAoFluxoComDossie(aut)) {
    return {
      situacao:           'inconsistente',
      integridade:        'invalida',
      assinaturaServidor: 'nao_disponivel',
      carimboTempo:       { situacao: 'nao_disponivel' },
      motivo:             'dossie_ausente'
    };
  }
  if (!aut.dossiePath) {
    return {
      situacao:           'nao_disponivel',
      integridade:        'nao_disponivel',
      assinaturaServidor: 'nao_disponivel',
      carimboTempo:       { situacao: 'nao_disponivel' },
      motivo:             'dossie_inexistente'
    };
  }

  let hashes;
  let assinaturaServidor = 'nao_verificada';
  try {
    hashes = conferirConteudoProtegidoDossie(aut);
    assinaturaServidor = 'invalida';
    conferirAssinaturaServidorDossie(hashes);
    assinaturaServidor = 'valida';
  } catch (e) {
    if (!(e instanceof InconsistenciaDossie)) throw e;
    return {
      situacao:           'inconsistente',
      integridade:        'invalida',
      assinaturaServidor: e.motivo === 'assinatura_ausente' ? 'ausente' : assinaturaServidor,
      carimboTempo:       { situacao: 'nao_verificado' },
      motivo:             e.motivo
    };
  }

  const carimboTempo = await conferirCarimboTempoDossie(hashes);
  // Um carimbo gravado que não confere indica adulteração do Dossiê, mas a
  // integridade do conteúdo protegido continua reportada à parte.
  if (carimboTempo.situacao === 'invalido') {
    return {
      situacao:           'inconsistente',
      integridade:        'valida',
      assinaturaServidor,
      carimboTempo,
      motivo:             'carimbo_tempo_invalido'
    };
  }
  return {
    situacao:           carimboTempo.situacao === 'valido' ? 'integro_com_carimbo' : 'integro_sem_carimbo',
    integridade:        'valida',
    assinaturaServidor,
    carimboTempo,
    motivo:             null
  };
}

// Erro específico de decodificação de dataURL — nunca inclui o conteúdo
// recebido na mensagem (a rota devolve 422 sem expor Base64).
class EvidenceDataUrlError extends Error {}

// Validação estrita de Base64 sem grupo repetido em regex — o padrão
// ^(?:X{4})*$ estoura a pilha do motor de regex do V8 para strings grandes
// (~7MB+ decodificados); esta versão usa apenas checagens O(n) simples,
// testada até arquivos no teto de LIMITES_EVIDENCIA sem estouro.
function base64ValidoEstrito(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return false;
  if (base64.length % 4 !== 0) return false;
  if (/[\r\n\s]/.test(base64)) return false;
  const semPadding = base64.replace(/=+$/, '');
  const qtdPadding = base64.length - semPadding.length;
  if (qtdPadding > 2) return false;
  if (semPadding.includes('=')) return false;
  if (!/^[A-Za-z0-9+/]*$/.test(semPadding)) return false;
  return true;
}

function base64EquivalentePadding(a, b) {
  return a.replace(/=+$/, '') === b.replace(/=+$/, '');
}

// Decodifica uma dataURL (data:<mime>;base64,<payload>) em { mimeType, buffer },
// validando estritamente o Base64 antes e depois da decodificação. Fronteira
// HTTP — só aqui o texto vira Buffer; a camada de evidências nunca vê string.
function decodificarDataUrl(dataUrl, nomeCampo) {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
    throw new EvidenceDataUrlError(`${nomeCampo}: dataURL ausente ou vazia.`);
  }
  const casamento = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!casamento) {
    throw new EvidenceDataUrlError(`${nomeCampo}: dataURL malformada — esperado "data:<mime>;base64,<payload>".`);
  }
  const [, mimeType, base64] = casamento;
  if (!base64ValidoEstrito(base64)) {
    throw new EvidenceDataUrlError(`${nomeCampo}: Base64 com caracteres, padding ou comprimento inválidos.`);
  }
  const buffer = Buffer.from(base64, 'base64');
  if (!base64EquivalentePadding(buffer.toString('base64'), base64)) {
    throw new EvidenceDataUrlError(`${nomeCampo}: Base64 não corresponde ao conteúdo decodificado.`);
  }
  return { mimeType, buffer };
}

// Monta o payloadBruto esperado por EvidenceIngestionOrchestrator.ingerir() a
// partir dos campos brutos recebidos em POST /api/autorizacoes/assinar. Único
// lugar do servidor que conhece o formato de payload do frontend E o contrato
// interno da camada de evidências — a própria camada nunca vê req/res.
function montarPayloadEvidencias({ codigo, imobiliariaIdCandidato, assinatura, selfie, documentos, assinantes }) {
  const itens = [];

  const { mimeType: mimeAssinatura, buffer: bufferAssinatura } = decodificarDataUrl(assinatura, 'assinatura');
  itens.push({ campo: 'assinatura', indice: null, mimeType: mimeAssinatura, buffer: bufferAssinatura });

  if (selfie) {
    const { mimeType, buffer } = decodificarDataUrl(selfie, 'selfie');
    itens.push({ campo: 'selfie', indice: null, mimeType, buffer });
  }

  (documentos || []).forEach((doc) => {
    const { mimeType, buffer } = decodificarDataUrl(doc.b64, `documento ${doc.campo}`);
    itens.push({ campo: doc.campo, indice: null, mimeType, buffer });
  });

  (assinantes || []).forEach((assinante) => {
    const { mimeType, buffer } = decodificarDataUrl(assinante.b64, `assinante ${assinante.campo}[${assinante.indice}]`);
    itens.push({ campo: assinante.campo, indice: assinante.indice, mimeType, buffer });
  });

  return { codigo, tenantIdCandidato: imobiliariaIdCandidato, itens };
}

// Salvar autorização assinada (chamado pelo proprietário — sem auth)
app.post('/api/autorizacoes/assinar', async (req, res) => {
  try {
    const { codigo, proprietario, imovel, tipo, hash, evidencias, otp, facial, liveness, uploads, assinatura, selfie, documentos, assinantes } = req.body;
    // codigo vai direto para a consulta do NeDB: só string, nunca objeto de operador ($gt, $ne…).
    if (typeof codigo !== 'string' || !codigo || !proprietario?.nome) return res.status(422).json({ erro: 'Dados incompletos.' });
    const venc = new Date(); venc.setDate(venc.getDate() + 365);
    // Busca rascunho existente para preservar imobiliariaId
    const rascunho = await db.autorizacoes.findOne({ codigo });
    // Só conclui autorização com rascunho legítimo criado pelo AGEMOB
    // (POST /api/autorizacoes ou /rascunho, sempre com imobiliariaId) —
    // nunca cria registro a partir de código escolhido pelo cliente.
    if (!rascunho || !rascunho.imobiliariaId) {
      return res.status(404).json({ erro: 'Autorização não encontrada.' });
    }
    // Idempotência: se esta autorização já foi assinada, não reprocessa
    // (evita duplicar PDF, Dossiê, log e notificação em caso de reenvio)
    // Fluxo com Dossiê só é idempotente com dossiePath persistido; sem ele,
    // a conclusão nunca é confirmada (sem reprocessar o Dossiê).
    if (rascunho && rascunho.status === 'assinado') {
      if (rascunho.dossiePath || !pertenceAoFluxoComDossie(rascunho)) {
        return res.json({ ok: true });
      }
      return res.status(409).json({ erro: 'Autorização assinada com Dossiê Digital pendente.' });
    }
    // Cancelada, inserida manualmente ou em qualquer outro estado: não assina.
    if (rascunho.status !== 'rascunho') {
      return res.status(409).json({ erro: 'Autorização indisponível para assinatura.' });
    }

    // Relógio oficial da requisição: cada requisição possui apenas um
    // único instante oficial do servidor. Capturado uma única vez, no
    // início desta integração — nenhum outro `new Date()` deve nascer
    // neste bloco. Futuramente Timeline, Custódia, Manifesto, Hashes e
    // demais artefatos do Dossiê também deverão reaproveitar exatamente
    // este mesmo instante, nunca recalcular o seu próprio — evita
    // pequenas diferenças de milissegundos entre artefatos jurídicos da
    // mesma submissão.
    const dataHoraServidorOficial = new Date().toISOString();

    // Eventos jurídicos declarados pelo cliente (Microetapa 5.5.2 —
    // integra src/services/events/). Roda antes de qualquer I/O da rota:
    // um `eventos` malformado nunca aciona a ingestão de evidências nem
    // toca o NeDB — 422 imediato. `eventos` ausente equivale a [].
    const eventosBrutos = req.body.eventos || [];
    let eventosProcessados;
    try {
      validarEstruturaEventos(eventosBrutos);
      eventosProcessados = normalizarEventos(eventosBrutos);
    } catch (erroEventos) {
      if (erroEventos instanceof EventValidationError) {
        return res.status(422).json({ erro: 'Falha na validação dos eventos.', violacoes: erroEventos.violacoes });
      }
      throw erroEventos;
    }

    // contextoEvento representa o contexto oficial e imutável desta
    // requisição — IP, dataHoraServidor, ator, tenantId e código nunca
    // sofrem alteração depois de criados (Object.freeze). tenantId segue
    // exatamente a mesma resolução já usada por `aut` (mais abaixo, na
    // montagem do objeto principal), incluindo a mesma tolerância a
    // tenant ausente — a Microetapa 5.5.2 só integra a pipeline de
    // eventos, não introduz regra de negócio nova sobre a autorização.
    // contextoEvento é também um contexto evolutivo: campos futuros
    // (requestId, traceId, ambiente, versaoBackend, hashManifesto,
    // certificado, carimboDoTempo, chainId etc.) poderão ser incorporados
    // aqui sem alterar a assinatura de enriquecerEventosComServidor.
    const contextoEvento = Object.freeze({
      codigo,
      tenantId: rascunho?.imobiliariaId || null,
      ip: req.ip,
      dataHoraServidor: dataHoraServidorOficial,
      ator: ATORES_EVENTO.PROPRIETARIO
    });
    const eventosNormalizados = enriquecerEventosComServidor(eventosProcessados.normalizados, contextoEvento);
    const eventosIgnorados = eventosProcessados.ignorados;
    // eventosNormalizados/eventosIgnorados existem só em memória nesta
    // microetapa — nenhuma gravação em NeDB, Timeline, Custódia ou
    // Manifesto ainda (integração com o Dossiê é a Microetapa 5.5.4).

    // Contexto para eventos gerados pelo próprio backend (ator: sistema,
    // não proprietário) — mesma dataHoraServidorOficial/ip/tenantId/codigo
    // já resolvidos acima para os eventos declarados pelo cliente.
    const contextoEventoBackend = Object.freeze({
      codigo,
      tenantId: rascunho?.imobiliariaId || null,
      ip: req.ip,
      dataHoraServidor: dataHoraServidorOficial,
      ator: ATORES_EVENTO.SISTEMA
    });

    // Ingestão das evidências binárias (assinatura, selfie, documentos,
    // assinantes adicionais) — precisa terminar com sucesso antes de qualquer
    // gravação em db.autorizacoes. Erro de validação/decodificação vira 422
    // estruturado; erro de gravação (EvidenceStorage) propaga para o catch
    // geral da rota (padrão já existente do arquivo).
    let resultadoIngestao;
    try {
      const payloadEvidencias = montarPayloadEvidencias({
        codigo,
        imobiliariaIdCandidato: rascunho?.imobiliariaId,
        assinatura, selfie, documentos, assinantes
      });
      resultadoIngestao = await evidenceOrchestrator.ingerir(payloadEvidencias);
      eventosNormalizados.push(construirEventoBackend(
        'evidencia_ingerida',
        { referencia: resultadoIngestao.caminhoIncoming },
        contextoEventoBackend
      ));
    } catch (erroIngestao) {
      if (erroIngestao instanceof EvidenceDataUrlError || erroIngestao.name === 'EvidenceValidationError') {
        return res.status(422).json({ erro: 'Falha na validação das evidências.', violacoes: erroIngestao.violacoes || [erroIngestao.message] });
      }
      throw erroIngestao;
    }

    const aut = {
      codigo, proprietario, imovel,
      tipo:          tipo || 'simples',
      status:        'assinado',
      hashCliente:   hash || null,
      evidencias:    evidencias || null,
      evidenciasRecebidas: {
        versaoSchema:    resultadoIngestao.versaoSchema,
        caminhoIncoming: resultadoIngestao.caminhoIncoming,
        manifestoId:     resultadoIngestao.manifesto.manifestId,
        arquivos:        resultadoIngestao.arquivos.map(a => ({
          caminhoRelativo: a.caminhoRelativo,
          sha256:          a.sha256,
          mimeType:        a.mimeType,
          tamanhoBytes:    a.tamanhoBytes,
          criadoEm:        a.criadoEm
        }))
      },
      validacoes:    { otp: otp||[], facial: facial||null, liveness: liveness||null, uploads: uploads||[] },
      imobiliariaId:   rascunho?.imobiliariaId   || null,
      imobiliariaSlug: rascunho?.imobiliariaSlug || null,
      corretorId:      rascunho?.corretorId      || null,
      corretorNome:    rascunho?.corretorNome    || null,
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
    eventosNormalizados.push(construirEventoBackend('assinatura_realizada', {}, contextoEventoBackend));
    await gerarESalvarPDFAssinatura(aut);
    await criarDossieDigital(aut, eventosNormalizados);
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
// Remetente técnico = BREVO_SENDER (configuração da plataforma), nunca um tenant.
async function enviarEmailBrevo(destino, assunto, texto, html, nomeImob) {
  if (!process.env.BREVO_SENDER) throw new Error('BREVO_SENDER ausente');
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { name: nomeImob ? `AGEMOB · ${nomeImob}` : 'AGEMOB', email: process.env.BREVO_SENDER },
      to: [{ email: destino }],
      subject: assunto,
      textContent: texto || undefined,
      htmlContent: html  || undefined
    })
  });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${await r.text()}`);
  return r.json();
}

// OTP de confirmação por e-mail do proprietário. A rota é pública, mas o
// e-mail é montado só aqui: o cliente informa apenas o rascunho, o destino e
// o código OTP — assunto, corpo e remetente nunca vêm do request.
const FORMATO_CODIGO_AUTORIZACAO = /^[A-Z0-9]{4,32}$/;
const FORMATO_EMAIL_DESTINO = /^[^\s@,;<>"'()\[\]\\]+@[^\s@,;<>"'()\[\]\\]+\.[^\s@,;<>"'()\[\]\\]+$/;
const TAMANHO_MAXIMO_EMAIL = 254;

function escaparHtmlEmail(valor) {
  return String(valor).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// assinatura: "Equipe {imobiliária}" ou o nome do corretor autônomo.
function montarEmailOtp(codigoOtp, codigo, assinatura) {
  const aviso = `Ele confirma a sua assinatura eletrônica da autorização de venda (código ${codigo}). Não compartilhe este código com ninguém.`;
  return {
    assunto: 'Seu código de verificação — AGEMOB',
    texto: `Seu código de verificação é: ${codigoOtp}\n\n${aviso}\n\n${assinatura}`,
    html: `<p>Seu código de verificação é: <b style="font-size:22px">${codigoOtp}</b></p>`
      + `<p>${escaparHtmlEmail(aviso)}</p><p>${escaparHtmlEmail(assinatura)}</p>`
  };
}

app.post('/api/enviar-email', emailLimiter, async (req, res) => {
  try {
    const { codigo, destino, codigoOtp } = req.body || {};
    if (typeof codigo !== 'string' || !FORMATO_CODIGO_AUTORIZACAO.test(codigo)
      || typeof codigoOtp !== 'string' || !/^\d{6}$/.test(codigoOtp)
      || typeof destino !== 'string' || destino.length > TAMANHO_MAXIMO_EMAIL || !FORMATO_EMAIL_DESTINO.test(destino)) {
      return res.status(422).json({ erro: 'Dados inválidos.' });
    }
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER) return res.status(503).json({ erro: 'E-mail não configurado.' });

    const aut = await db.autorizacoes.findOne({ codigo });
    const imob = aut?.imobiliariaId ? await db.imobiliarias.findOne({ _id: aut.imobiliariaId }) : null;
    if (!aut || !imob?.nome) return res.status(404).json({ erro: 'Autorização não encontrada.' });
    if (aut.status !== 'rascunho') return res.status(409).json({ erro: 'Autorização não está mais disponível para assinatura.' });

    const assinatura = imob.tipoCliente === 'corretor' ? imob.nome : `Equipe ${imob.nome}`;
    const { assunto, texto, html } = montarEmailOtp(codigoOtp, codigo, assinatura);
    await enviarEmailBrevo(destino, assunto, texto, html, imob.nome);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: 'Falha ao enviar e-mail.' }); }
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
    // Mesmos números que a regra central usa para bloquear (imobiliária, não subscription).
    const { imob, sub, acesso } = await carregarAcessoTenant(req.user.imobiliariaId);
    let usadas, limite, extras;
    if (acesso.trial) {
      ({ usadas, limite } = acesso.trial); extras = 0;
    } else {
      usadas = await contarUsoPlanoMes(req.user.imobiliariaId);
      limite = imob?.limiteAutorizacoes ?? 0;
      extras = imob?.creditosExtras ?? 0;
    }
    const disponiveis = limite === -1 ? -1 : Math.max(0, limite + extras - usadas);
    const pct = limite > 0 ? Math.min(Math.round(usadas / limite * 100), 100) : 0;
    const { podeOperar, statusEfetivo, motivo, trial } = acesso;
    res.json({ sub, usadas, limite, extras, disponiveis, pct,
      alerta: pct >= 100 ? 'critico' : pct >= 90 ? 'urgente' : pct >= 80 ? 'aviso' : null,
      acesso: { statusEfetivo, podeOperar, motivo, trial } });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// Hook: criar subscription quando imobiliária é criada via auto-cadastro
// (já tratado no /api/cadastro, mas garantindo para cadastros do super admin)
app.post('/api/admin/subscriptions/:imobId/iniciar', authMiddleware(['super_admin']), async (req, res) => {
  try {
    const { planoId, status } = req.body;
    // O formulário de novo cliente envia o status administrativo (ativo/suspenso/inativo),
    // já gravado na imobiliária; no eixo financeiro isso equivale a contrato ativo.
    const statusFin = ['ativo', 'suspenso', 'inativo'].includes(status) ? 'active' : (status || 'trial');
    if (!STATUS_FINANCEIROS.includes(statusFin)) return res.status(422).json({ erro: 'Status inválido.' });
    const sub = await SubscriptionService.criar(req.params.imobId, planoId, statusFin);
    res.json({ ok: true, sub });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// VALIDAÇÃO PÚBLICA — QR Code / Link de verificação
// ═══════════════════════════════════════════════════════

// Resolve o caminho físico do PDF oficial de uma autorização a partir do
// código do registro no NeDB — única função que constrói esse caminho;
// nunca aceita pdfPath vindo do banco/cliente.
function caminhoPdfAssinatura(codigo) {
  return path.join(STORAGE_BASE, 'assinados', `${codigo}.pdf`);
}

// Rota pública — qualquer pessoa com o link pode verificar
app.get('/api/validar/:codigo', async (req, res) => {
  try {
    const aut = await db.autorizacoes.findOne({ codigo: req.params.codigo });
    if (!aut) return res.status(404).json({ encontrado: false, valido: false, erro: 'Código não encontrado.' });

    // valido reflete a verificação do Dossiê — não mais a simples existência
    // do registro. Detalhes em verificacao, sem caminhos, chaves ou tokens.
    const verificacao = await verificarIntegridadeDossie(aut);

    // Retorna apenas dados necessários para validação — sem dados sensíveis
    res.json({
      encontrado: true,
      valido:     verificacao.situacao === 'integro_com_carimbo' || verificacao.situacao === 'integro_sem_carimbo',
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
      },
      pdfDisponivel: fs.existsSync(caminhoPdfAssinatura(aut.codigo)),
      verificacao: {
        ...verificacao,
        mensagem:     MENSAGENS_VERIFICACAO_DOSSIE[verificacao.situacao],
        verificadoEm: new Date().toISOString()
      }
    });
  } catch(e) { res.status(500).json({ valido: false, erro: 'Erro interno.' }); }
});

// Serve o PDF oficial da autorização assinada — único ponto de acesso ao
// arquivo em storage/assinados/; nunca expõe o caminho físico ao cliente.
app.get('/api/autorizacoes/:codigo/pdf', async (req, res) => {
  try {
    const codigo = req.params.codigo;
    if (!/^[A-Z0-9]{6,12}$/.test(codigo)) return res.status(404).end();

    const aut = await db.autorizacoes.findOne({ codigo });
    if (!aut) return res.status(404).end();

    const absoluto = caminhoPdfAssinatura(aut.codigo);
    if (!fs.existsSync(absoluto)) return res.status(404).end();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="autorizacao-${codigo}.pdf"`);
    res.sendFile(absoluto);
  } catch (e) {
    res.status(500).json({ erro: 'Erro interno.' });
  }
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
      imobiliaria: { nome: imob.nome, slug: imob.slug, email: imob.email, tipoCliente: imob.tipoCliente || 'imobiliaria',
        razaoSocial: imob.razaoSocial || '', cnpj: imob.cnpj || '', creci: imob.creci || imob.responsavel?.creci || '' }
    });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ═══════════════════════════════════════════════════════
// IDENTIDADE DA CONTA — logo do tenant (M9-04)
// ═══════════════════════════════════════════════════════
const MENSAGENS_LOGO = {
  formato_nao_suportado: 'Envie uma imagem PNG ou JPEG.',
  arquivo_grande:        'A imagem deve ter no máximo 1 MB.',
  arquivo_invalido:      'Arquivo de imagem inválido.',
  conteudo_invalido:     'Arquivo de imagem inválido ou corrompido.'
};

// A logo é configuração da conta: o titular (admin) a edita fora do modo
// suporte enquanto a conta estiver administrativamente ativa — trial
// encerrado, plano vencido ou pagamento pendente não bloqueiam.
function podeEditarLogo(user, acesso) {
  return user.role === 'admin' && !user.modoSuporte
    && !['suspenso', 'desativado', 'inexistente'].includes(acesso.statusEfetivo);
}

async function tenantEditavel(req, res) {
  const { imob, acesso } = await carregarAcessoTenant(req.user.imobiliariaId);
  if (!imob || !podeEditarLogo(req.user, acesso)) {
    res.status(403).json({ erro: 'Sem permissão para alterar a identidade da conta.' });
    return null;
  }
  return imob;
}

app.get('/api/minha-identidade', authMiddleware(['admin','corretor']), async (req, res) => {
  try {
    const { imob, acesso } = await carregarAcessoTenant(req.user.imobiliariaId);
    if (!imob) return res.status(404).json({ erro: 'Conta não encontrada.' });
    res.json({
      nome:           imob.razaoSocial || imob.nomeFantasia || imob.nome || '',
      tipoCliente:    imob.tipoCliente === 'corretor' ? 'corretor' : 'imobiliaria',
      logoUrl:        logoTenant.urlLogo(imob),
      podeEditarLogo: podeEditarLogo(req.user, acesso)
    });
  } catch(e) { res.status(500).json({ erro: 'Erro interno.' }); }
});

// O tenant vem só da sessão; nenhum id é aceito no corpo.
app.put('/api/minha-identidade/logo', authMiddleware(['admin']), async (req, res) => {
  try {
    const imob = await tenantEditavel(req, res);
    if (!imob) return;
    let logo;
    try {
      logo = await logoTenant.validarLogo(req.body?.arquivo);
    } catch (e) {
      if (!(e instanceof logoTenant.ErroLogo)) throw e;
      return res.status(422).json({ erro: MENSAGENS_LOGO[e.codigo] || MENSAGENS_LOGO.arquivo_invalido });
    }
    const arquivo = await logoTenant.salvarLogo(STORAGE_BASE, imob._id, logo);
    const agora = new Date().toISOString();
    await db.imobiliarias.update({ _id: imob._id }, { $set: { logoArquivo: arquivo, logoMime: logo.mime, logoAtualizadoEm: agora, atualizadoEm: agora } });
    if (imob.logoArquivo && imob.logoArquivo !== arquivo) await logoTenant.removerArquivo(STORAGE_BASE, imob._id, imob.logoArquivo).catch(() => {});
    await log('identidade', 'Logo da conta atualizada', null, imob._id);
    res.json({ logoUrl: logoTenant.urlLogo({ _id: imob._id, logoArquivo: arquivo, logoMime: logo.mime, logoAtualizadoEm: agora }) });
  } catch(e) { res.status(500).json({ erro: 'Erro interno.' }); }
});

app.delete('/api/minha-identidade/logo', authMiddleware(['admin']), async (req, res) => {
  try {
    const imob = await tenantEditavel(req, res);
    if (!imob) return;
    if (imob.logoArquivo) {
      await db.imobiliarias.update({ _id: imob._id }, { $unset: { logoArquivo: true, logoMime: true, logoAtualizadoEm: true }, $set: { atualizadoEm: new Date().toISOString() } });
      await logoTenant.removerArquivo(STORAGE_BASE, imob._id, imob.logoArquivo).catch(() => {});
      await log('identidade', 'Logo da conta removida', null, imob._id);
    }
    res.json({ logoUrl: null });
  } catch(e) { res.status(500).json({ erro: 'Erro interno.' }); }
});

// Logo pública do tenant (identidade exibida a proprietários): só a logo
// cadastrada, com o MIME gravado, lida de storage/marcas/<id>/.
app.get('/api/logos/:tenantId', async (req, res) => {
  try {
    const { tenantId } = req.params;
    if (!/^[A-Za-z0-9]{8,32}$/.test(tenantId)) return res.status(404).end();
    const imob = await db.imobiliarias.findOne({ _id: tenantId });
    const buffer = await logoTenant.lerLogo(STORAGE_BASE, imob);
    if (!buffer) return res.status(404).end();
    res.set({ 'Content-Type': imob.logoMime, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', 'Cache-Control': 'public, max-age=300' });
    res.end(buffer);
  } catch(e) { res.status(500).end(); }
});

// ═══════════════════════════════════════════════════════
// RECUPERAÇÃO DE SENHA (M9-04)
// ═══════════════════════════════════════════════════════
// O token só existe no e-mail; o banco guarda o SHA-256. A resposta pública é
// sempre a mesma (sem enumeração) e o envio é assíncrono. Um pedido ativo por
// usuário, intervalo mínimo de 60 s, validade de 30 min.
const RESET_VALIDADE_MS = 30 * 60 * 1000;
const RESET_INTERVALO_MS = 60 * 1000;
const RESPOSTA_ESQUECI_SENHA = 'Se existir uma conta com este e-mail, enviaremos as instruções para redefinir sua senha.';
const ERRO_LINK_RESET = 'Link inválido ou expirado. Solicite uma nova redefinição de senha.';
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { erro: 'Muitas tentativas. Aguarde 15 minutos.' } });
db.resetSenha.ensureIndex({ fieldName: 'tokenHash', unique: true });
const hashTokenReset = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function processarEsqueciSenha(email, baseUrl) {
  const usuario = await db.usuarios.findOne({ email, ativo: true });
  if (!usuario || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario.email)) return;
  const agora = Date.now();
  const recente = await db.resetSenha.findOne({ usuarioId: usuario._id, criadoEm: { $gt: new Date(agora - RESET_INTERVALO_MS).toISOString() } });
  if (recente) return;
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER) {
    await log('aviso', 'Recuperação de senha solicitada sem e-mail configurado');
    return;
  }
  const criadoEm = new Date(agora).toISOString();
  await db.resetSenha.update({ usuarioId: usuario._id, usadoEm: null }, { $set: { usadoEm: criadoEm } }, { multi: true });
  const token = crypto.randomBytes(32).toString('base64url');
  await db.resetSenha.insert({ tokenHash: hashTokenReset(token), usuarioId: usuario._id, criadoEm,
    expiraEm: new Date(agora + RESET_VALIDADE_MS).toISOString(), usadoEm: null });
  const link = `${baseUrl}/redefinir-senha#${token}`;
  const saudacao = usuario.nome ? `Olá, ${usuario.nome}!` : 'Olá!';
  const corpo = 'Recebemos um pedido para redefinir a senha da sua conta no AGEMOB.';
  const aviso = 'Se você não fez este pedido, ignore este e-mail — sua senha atual continua valendo.';
  const texto = `${saudacao}\n\n${corpo}\n\nPara criar uma nova senha, acesse o link abaixo (válido por 30 minutos):\n${link}\n\n${aviso}\n\nEquipe AGEMOB`;
  const html = `<p>${escaparHtmlEmail(saudacao)}</p><p>${escaparHtmlEmail(corpo)}</p>`
    + `<p><a href="${escaparHtmlEmail(link)}">Criar nova senha</a> (válido por 30 minutos)</p><p>${escaparHtmlEmail(aviso)}</p><p>Equipe AGEMOB</p>`;
  await enviarEmailBrevo(usuario.email, 'Redefinição de senha — AGEMOB', texto, html, null);
}

app.post('/api/auth/esqueci-senha', resetLimiter, (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  res.json({ ok: true, mensagem: RESPOSTA_ESQUECI_SENHA });
  if (!email || email.length > 254) return;
  processarEsqueciSenha(email, getBaseUrl(req)).catch(() => log('erro', 'Falha ao processar recuperação de senha'));
});

app.post('/api/auth/redefinir-senha', async (req, res) => {
  try {
    const { token, senha } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return res.status(400).json({ erro: ERRO_LINK_RESET });
    if (typeof senha !== 'string' || senha.length < 6) return res.status(422).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
    const tokenHash = hashTokenReset(token);
    const agora = new Date().toISOString();
    // Consumo atômico: só um uso, só dentro da validade.
    const n = await db.resetSenha.update({ tokenHash, usadoEm: null, expiraEm: { $gt: agora } }, { $set: { usadoEm: agora } });
    if (n !== 1) return res.status(400).json({ erro: ERRO_LINK_RESET });
    const reg = await db.resetSenha.findOne({ tokenHash });
    const usuario = reg ? await db.usuarios.findOne({ _id: reg.usuarioId, ativo: true }) : null;
    if (!usuario) return res.status(400).json({ erro: ERRO_LINK_RESET });
    await db.usuarios.update({ _id: usuario._id }, { $set: { senha: await bcrypt.hash(senha, 10), atualizadoEm: agora } });
    await db.resetSenha.update({ usuarioId: usuario._id, usadoEm: null }, { $set: { usadoEm: agora } }, { multi: true });
    await log('auth', 'Senha redefinida por recuperação', null, usuario.imobiliariaId || null);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: 'Erro interno.' }); }
});

// ═══════════════════════════════════════════════════════
// BOAS-VINDAS (M9-04) — só cadastro pela landing; assíncrono, nunca afeta o cadastro
// ═══════════════════════════════════════════════════════
async function enviarBoasVindas({ email, responsavel, nomeConta, tipo, imobiliariaId, baseUrl }) {
  try {
    if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER) return;
    const saudacao = `Olá, ${responsavel}!`;
    const conta = tipo === 'corretor' ? 'Sua conta no AGEMOB está pronta.' : `A conta da ${nomeConta} no AGEMOB está pronta.`;
    const trial = 'Seu teste grátis começou: 1 autorização grátis ou 7 dias, o que acontecer primeiro.';
    const texto = `${saudacao}\n\n${conta}\n\n${trial}\n\nAcesse: ${baseUrl}/login\n\nEquipe AGEMOB`;
    const html = [saudacao, conta, trial].map(t => `<p>${escaparHtmlEmail(t)}</p>`).join('')
      + `<p>Acesse: <a href="${escaparHtmlEmail(baseUrl + '/login')}">${escaparHtmlEmail(baseUrl + '/login')}</a></p><p>Equipe AGEMOB</p>`;
    await enviarEmailBrevo(email, 'Bem-vindo(a) ao AGEMOB', texto, html, null);
  } catch(e) {
    await log('aviso', 'Falha no envio do e-mail de boas-vindas', null, imobiliariaId);
  }
}

// ═══════════════════════════════════════════════════════
// CONFIGURAÇÃO PÚBLICA (M9-04) — contato Corporate
// ═══════════════════════════════════════════════════════
// Só https:// ou mailto:. Inválido = não configurado (aviso, não fatal).
function lerContatoCorporate(valor) {
  const v = (valor || '').trim();
  if (!v) return null;
  if (/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(v)) return v;
  try {
    const u = new URL(v);
    if (u.protocol === 'https:' && !u.username && !u.password) return u.href;
  } catch {}
  console.warn('Aviso: CORPORATE_CONTACT_URL inválida — contato Corporate desativado.');
  return null;
}
const CONTATO_CORPORATE = lerContatoCorporate(process.env.CORPORATE_CONTACT_URL);
app.get('/api/config-publica', (_req, res) => res.json({ contatoCorporate: CONTATO_CORPORATE }));

// ═══════════════════════════════════════════════════════
// PAGAMENTOS — InfinitePay (M9-02). Antes do catch-all.
// ═══════════════════════════════════════════════════════
const infinitepayRotas = rotasInfinitepay({
  db, authMiddleware, carregarAcessoTenant, log, getBaseUrl, infinitepay,
  ativarPorPagamento: (imobiliariaId, pagamento, agora) => SubscriptionService.ativarPorPagamento(imobiliariaId, pagamento, agora)
});
app.use('/api/pagamentos', infinitepayRotas.pagamentos);
app.use('/api/webhooks', infinitepayRotas.webhooks);

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
}).catch((e) => {
  console.error(`ERRO FATAL: seed falhou (${e instanceof ErroSeed ? e.codigo : 'desconhecido'}).`);
  process.exit(1);
});
