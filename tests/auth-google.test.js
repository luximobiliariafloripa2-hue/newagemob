'use strict';
// Login com Google (M11 Fase B) — testes automatizados.
//
// 1. Unidade: validação do id_token (assinatura RS256/JWKS, emissor, público,
//    validade, nonce, e-mail verificado) e configuração (falha fechada).
// 2. Ponta a ponta: server.js real com DATA_DIR/STORAGE_DIR temporários e um
//    provedor OIDC FALSO local (GOOGLE_OIDC_TEST_URL, proibido em produção), que
//    também confere PKCE, uso único do code e redirect_uri. Nunca toca data/,
//    storage/ nem o Google real. Dados 100% fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { carregarConfiguracao, criarGoogleOidc, desafioPkce } = require('../services/googleOidc');

const RAIZ = path.join(__dirname, '..');
const CLIENT_ID = 'cliente-teste-agemob.apps.googleusercontent.com';
const CLIENT_SECRET = 'segredo-de-teste-' + crypto.randomBytes(8).toString('hex');
const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

function chaves() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, kid: 'kid-' + crypto.randomBytes(4).toString('hex'), jwk };
}
function assinar(chave, cab, dados) {
  const corpo = b64u({ alg: 'RS256', typ: 'JWT', kid: chave.kid, ...cab }) + '.' + b64u(dados);
  return corpo + '.' + crypto.sign('RSA-SHA256', Buffer.from(corpo), chave.privateKey).toString('base64url');
}

// ───────────────────────── 1. Unidade ─────────────────────────
test('config: desativado por padrão, sem credenciais, flag inválida e URL de teste em produção', () => {
  assert.deepEqual(carregarConfiguracao({}), { ativo: false, motivo: 'desativado' });
  assert.deepEqual(carregarConfiguracao({ AUTH_GOOGLE_ATIVO: 'true' }), { ativo: false, motivo: 'credenciais_ausentes' });
  assert.deepEqual(carregarConfiguracao({ AUTH_GOOGLE_ATIVO: 'false', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'x' }), { ativo: false, motivo: 'desativado' });
  assert.throws(() => carregarConfiguracao({ AUTH_GOOGLE_ATIVO: 'sim' }), /AUTH_GOOGLE_ATIVO_invalido/);
  assert.throws(() => carregarConfiguracao({ NODE_ENV: 'production', GOOGLE_OIDC_TEST_URL: 'http://127.0.0.1:1' }), /proibida_em_producao/);
  const c = carregarConfiguracao({ AUTH_GOOGLE_ATIVO: 'true', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: 'x' });
  assert.equal(c.ativo, true);
  assert.equal(c.tokenUrl, 'https://oauth2.googleapis.com/token');
  assert.deepEqual(c.issuers, ['https://accounts.google.com', 'accounts.google.com']);
});

test('id_token: aceita só token íntegro, do emissor e público certos, válido, com nonce e e-mail verificado', async () => {
  const k = chaves(), outra = chaves();
  const cfg = { clientId: CLIENT_ID, issuers: ['https://accounts.google.com'], jwksUrl: 'https://jwks.invalid/certs' };
  const fetchFalso = async () => ({ ok: true, json: async () => ({ keys: [{ ...k.jwk, kid: k.kid, alg: 'RS256', use: 'sig' }] }) });
  const oidc = criarGoogleOidc(cfg, { fetch: fetchFalso });
  const agora = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: '1234567890', email: 'Pessoa@Exemplo.test', email_verified: true, name: 'Pessoa Teste', iat: agora, exp: agora + 3600, nonce: 'n-1' };
  const ok = await oidc.verificarIdToken(assinar(k, {}, base), { nonce: 'n-1' });
  assert.deepEqual(ok, { sub: '1234567890', email: 'pessoa@exemplo.test', nome: 'Pessoa Teste' });
  const recusa = async (token, codigo, nonce = 'n-1') => assert.rejects(oidc.verificarIdToken(token, { nonce }), (e) => e.codigo === codigo);
  await recusa(assinar(outra, { kid: k.kid }, base), 'id_token_assinatura');
  await recusa(assinar(k, {}, { ...base, iss: 'https://evil.example' }), 'id_token_emissor');
  await recusa(assinar(k, {}, { ...base, aud: 'outro-cliente' }), 'id_token_publico');
  await recusa(assinar(k, {}, { ...base, azp: 'outro-cliente' }), 'id_token_publico');
  await recusa(assinar(k, {}, { ...base, exp: agora - 3600 }), 'id_token_expirado');
  await recusa(assinar(k, {}, { ...base, iat: agora + 3600 }), 'id_token_iat');
  await recusa(assinar(k, {}, base), 'id_token_nonce', 'outro-nonce');
  await recusa(assinar(k, {}, { ...base, email_verified: false }), 'email_nao_verificado');
  await recusa(assinar(k, {}, { ...base, sub: '' }), 'id_token_sub');
  await recusa(assinar(k, { kid: 'desconhecido' }, base), 'id_token_chave_desconhecida');
  await recusa(b64u({ alg: 'none', typ: 'JWT', kid: k.kid }) + '.' + b64u(base) + '.', 'id_token_algoritmo');
  await recusa(b64u({ alg: 'HS256', typ: 'JWT', kid: k.kid }) + '.' + b64u(base) + '.' + b64u('x'), 'id_token_algoritmo');
  await recusa('nao.e.jwt.valido', 'id_token_malformado');
});

test('PKCE: desafio S256 = BASE64URL(SHA-256(verifier)), sem padding, 43 caracteres', () => {
  const v = 'verificador-de-teste-' + 'x'.repeat(40);
  const esperado = crypto.createHash('sha256').update(v, 'ascii').digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(desafioPkce(v), esperado);
  assert.match(desafioPkce(v), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(desafioPkce(v), desafioPkce(v + 'y'));
  // Interoperabilidade real: o provedor falso do teste ponta a ponta recusa o code se o code_verifier não bater.
});

// ───────────────────────── 2. Ponta a ponta ─────────────────────────
function provedorFalso() {
  const chave = chaves();
  const codigos = new Map();
  const p = { chave, cenario: {}, porta: 0, requisicoesToken: 0 };
  p.servidor = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/certs') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ keys: [{ ...chave.jwk, kid: chave.kid, alg: 'RS256', use: 'sig' }] })); }
    if (u.pathname === '/auth') {
      const q = Object.fromEntries(u.searchParams);
      const c = p.cenario;
      if (q.client_id !== CLIENT_ID || q.response_type !== 'code' || q.scope !== 'openid email profile' || q.code_challenge_method !== 'S256' || !q.code_challenge || !q.nonce || !q.state) { res.statusCode = 400; return res.end('parametros'); }
      const destino = new URL(q.redirect_uri);
      if (c.cancelar) { destino.searchParams.set('error', 'access_denied'); destino.searchParams.set('state', q.state); }
      else {
        const code = crypto.randomBytes(16).toString('hex');
        codigos.set(code, { challenge: q.code_challenge, redirect: q.redirect_uri, nonce: q.nonce, cenario: { ...c } });
        destino.searchParams.set('code', code); destino.searchParams.set('state', q.state);
      }
      res.statusCode = 302; res.setHeader('location', destino.toString()); return res.end();
    }
    if (u.pathname === '/token' && req.method === 'POST') {
      let corpo = '';
      req.on('data', d => { corpo += d; });
      req.on('end', () => {
        p.requisicoesToken++;
        const f = Object.fromEntries(new URLSearchParams(corpo));
        const reg = codigos.get(f.code);
        codigos.delete(f.code); // uso único
        const falha = (m) => { res.statusCode = 400; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: m })); };
        if (!reg) return falha('invalid_grant');
        if (f.client_id !== CLIENT_ID || f.client_secret !== CLIENT_SECRET) return falha('invalid_client');
        if (f.grant_type !== 'authorization_code' || f.redirect_uri !== reg.redirect) return falha('invalid_request');
        if (desafioPkce(f.code_verifier || '') !== reg.challenge) return falha('invalid_grant_pkce');
        const c = reg.cenario, agora = Math.floor(Date.now() / 1000);
        const dados = { iss: c.iss || `http://127.0.0.1:${p.porta}`, aud: c.aud || CLIENT_ID, azp: c.aud || CLIENT_ID, sub: c.sub, email: c.email,
          email_verified: c.emailVerificado === undefined ? true : c.emailVerificado, name: c.nome || 'Pessoa Google', iat: agora, exp: c.expirado ? agora - 3600 : agora + 3600,
          nonce: c.nonceErrado ? 'nonce-forjado' : reg.nonce };
        const id = c.assinaturaInvalida ? assinar(chaves(), { kid: chave.kid }, dados) : assinar(chave, {}, dados);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ access_token: 'at-descartavel', refresh_token: 'rt-descartavel', id_token: id, token_type: 'Bearer', expires_in: 3600 }));
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  return p;
}

async function subirServidor(t, envExtra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agemob-google-test-'));
  const DATA = path.join(tmp, 'data'), STORAGE = path.join(tmp, 'storage');
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const filho = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PORT: String(porta),
    DATA_DIR: DATA, STORAGE_DIR: STORAGE, BASE_URL: `http://127.0.0.1:${porta}`, JWT_SECRET: 'jwt-teste-' + crypto.randomBytes(8).toString('hex'),
    SUPER_ADMIN_PASS: 'Sup3r-teste-123', BREVO_API_KEY: '', BREVO_SENDER: '',
    DOSSIE_SIGNING_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }),
    INFINITEPAY_DESATIVADO: 'true', ...envExtra } });
  t.after(() => { filho.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await new Promise((ok, falha) => {
    let saida = '';
    const tempo = setTimeout(() => falha(new Error('servidor não subiu: ' + saida)), 60000);
    filho.stdout.on('data', d => { saida += d; if (saida.includes('rodando')) { clearTimeout(tempo); ok(); } });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('exit', () => falha(new Error('servidor encerrou: ' + saida)));
  });
  return { porta, DATA };
}

test('login com Google desativado: botão oculto (config-publica) e /iniciar não sai do AGEMOB', { timeout: 90000 }, async (t) => {
  const { porta } = await subirServidor(t, {});
  const cfg = await (await fetch(`http://127.0.0.1:${porta}/api/config-publica`)).json();
  assert.equal(cfg.authGoogle, false);
  const r = await fetch(`http://127.0.0.1:${porta}/api/oauth/google/iniciar`, { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/landing-v2.html#google_erro=indisponivel');
});

test('ponta a ponta: cadastro, login, vínculo seguro, tenant, estado, reutilização, token inválido, plano e trial', { timeout: 180000 }, async (t) => {
  const prov = provedorFalso();
  await new Promise(ok => prov.servidor.listen(0, '127.0.0.1', ok));
  prov.porta = prov.servidor.address().port;
  t.after(() => prov.servidor.close());
  const TTL = 4000;
  const { porta, DATA } = await subirServidor(t, {
    AUTH_GOOGLE_ATIVO: 'true', GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_OIDC_TEST_URL: `http://127.0.0.1:${prov.porta}`, OAUTH_TTL_TESTE_MS: String(TTL)
  });
  const BASE = `http://127.0.0.1:${porta}`;
  let ip = 1;
  const ipNovo = () => `10.30.${Math.floor(ip / 250)}.${ip++ % 250 + 1}`;
  const api = async (metodo, url, corpo, { token, cookie } = {}) => {
    const headers = { 'x-forwarded-for': ipNovo() };
    if (corpo !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    if (cookie) headers.cookie = cookie;
    const r = await fetch(BASE + url, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo), redirect: 'manual' });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j, headers: r.headers };
  };
  const lerColecao = (nome) => { const u = {}; try { for (const l of fs.readFileSync(path.join(DATA, nome + '.db'), 'utf8').split('\n').filter(Boolean)) { const d = JSON.parse(l); if (d.$$indexCreated) continue; if (d.$$deleted) delete u[d._id]; else u[d._id] = d; } } catch {} return Object.values(u); };
  const espera = (ms) => new Promise(r => setTimeout(r, ms));

  // Navegador simulado: segue iniciar → provedor → callback e devolve o fragmento final.
  async function acessarComGoogle(cenario, { plano, semCookie, cookieOutro, esperarMs, repetirCallback } = {}) {
    prov.cenario = cenario;
    const r1 = await fetch(`${BASE}/api/oauth/google/iniciar${plano ? '?plano=' + plano : ''}`, { redirect: 'manual', headers: { 'x-forwarded-for': ipNovo() } });
    assert.equal(r1.status, 302);
    const setCookie = r1.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';')[0];
    assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=Lax/i);
    const urlProv = new URL(r1.headers.get('location'));
    assert.equal(urlProv.origin, `http://127.0.0.1:${prov.porta}`);
    if (esperarMs) await espera(esperarMs);
    const r2 = await fetch(urlProv, { redirect: 'manual' });
    const cb = new URL(r2.headers.get('location'));
    assert.equal(cb.pathname, '/api/oauth/google/callback');
    const hdr = { 'x-forwarded-for': ipNovo() };
    const ck = semCookie ? null : (cookieOutro || cookie);
    if (ck) hdr.cookie = ck;
    const r3 = await fetch(BASE + cb.pathname + cb.search, { redirect: 'manual', headers: hdr });
    const destino = r3.headers.get('location') || '';
    let replay = null;
    if (repetirCallback) {
      const r4 = await fetch(BASE + cb.pathname + cb.search, { redirect: 'manual', headers: hdr });
      replay = r4.headers.get('location');
    }
    const m = /#google=([A-Za-z0-9_-]+)$/.exec(destino), e = /#google_erro=([a-z_]+)$/.exec(destino);
    return { cookie, codigo: m && m[1], erro: e && e[1], destino, replay };
  }

  // Contas de apoio (cadastro e login tradicionais).
  const senha = 'senha123';
  const cadastro = (corpo) => api('POST', '/api/cadastro', { senha, telefone: '48999999999', ...corpo });
  const existente = await cadastro({ tipoCliente: 'imobiliaria', nome: 'Imobiliária Existente', cnpj: '11.111.111/0001-11', creci: 'J-1', responsavel: 'Rita Existente', email: 'rita@exemplo.test' });
  assert.equal(existente.status, 200);
  const outraConta = await cadastro({ tipoCliente: 'corretor', nome: 'Otávio Outra Conta', cpf: '529.982.247-25', responsavel: 'Otávio Outra Conta', email: 'otavio@exemplo.test' });
  assert.equal(outraConta.status, 200);
  const sa = await api('POST', '/api/auth/login', { email: 'admin@agemob.com.br', senha: 'Sup3r-teste-123' });
  assert.equal(sa.status, 200);

  await t.test('config pública anuncia o Google ativo', async () => {
    assert.equal((await api('GET', '/api/config-publica')).j.authGoogle, true);
  });

  let tokNovo;
  await t.test('novo usuário Google: cadastro completo em trial, plano preservado, conta sem senha', async () => {
    const a = await acessarComGoogle({ sub: 'g-novo-1', email: 'Nova.Pessoa@Exemplo.test', nome: 'Nova Pessoa' }, { plano: 'pro' });
    assert.ok(a.codigo, a.destino);
    const r = await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie });
    assert.equal(r.status, 200);
    assert.deepEqual({ s: r.j.situacao, e: r.j.email, n: r.j.nome, p: r.j.plano }, { s: 'cadastro', e: 'nova.pessoa@exemplo.test', n: 'Nova Pessoa', p: 'pro' });
    assert.equal(r.j.token, undefined, 'cadastro pendente não entrega sessão');
    assert.equal((await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Nova Pessoa' }, { cookie: a.cookie })).status, 422, 'CPF obrigatório');
    assert.equal((await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Nova Pessoa', cpf: '390.533.447-05' })).status, 400, 'sem o cookie do navegador');
    const c = await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Nova Pessoa', cpf: '390.533.447-05', telefone: '(48) 98888-0000' }, { cookie: a.cookie });
    assert.equal(c.status, 200, JSON.stringify(c.j));
    assert.equal(c.j.plano, 'pro');
    assert.equal(c.j.user.email, 'nova.pessoa@exemplo.test');
    assert.equal(c.j.user.role, 'admin');
    tokNovo = c.j.token;
    const me = await api('GET', '/api/auth/me', undefined, { token: tokNovo });
    assert.equal(me.status, 200);
    const sub = await api('GET', '/api/minha-assinatura', undefined, { token: tokNovo });
    assert.match(JSON.stringify(sub.j), /trial/, 'nasce em trial; plano pago não é ativado');
    const u = lerColecao('usuarios').find(x => x.email === 'nova.pessoa@exemplo.test');
    assert.equal(u.senha, null, 'conta Google sem senha');
    const ids = lerColecao('identidades').filter(x => x.usuarioId === u._id);
    assert.deepEqual(ids.map(x => x.chave), ['google:g-novo-1']);
    assert.ok(!JSON.stringify(lerColecao('oauth')).includes('at-descartavel') && !JSON.stringify(lerColecao('identidades')).includes('rt-descartavel'), 'tokens do Google não são gravados');
    assert.equal((await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'X', cpf: '1' }, { cookie: a.cookie })).status, 400, 'código consumido');
    // Regra da Fase A continua: corretor sem CRECI não emite autorização
    const aut = await api('POST', '/api/autorizacoes', {}, { token: tokNovo });
    assert.equal(aut.j && aut.j.codigo, 'CRECI_OBRIGATORIO');
  });

  await t.test('conta social sem senha: login por senha recusa (401, não 500) e recuperação aceita o pedido', async () => {
    assert.equal((await api('POST', '/api/auth/login', { email: 'nova.pessoa@exemplo.test', senha: 'qualquer' })).status, 401);
    const r = await api('POST', '/api/auth/esqueci-senha', { email: 'nova.pessoa@exemplo.test' });
    assert.equal(r.status, 200);
  });

  await t.test('conta já vinculada: entra direto, mesmo usuário e tenant, código de uso único', async () => {
    const a = await acessarComGoogle({ sub: 'g-novo-1', email: 'nova.pessoa@exemplo.test' }, { plano: 'prime' });
    const r = await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.j.situacao, 'login');
    assert.equal(r.j.plano, 'prime');
    assert.equal(r.j.user.email, 'nova.pessoa@exemplo.test');
    const me = await api('GET', '/api/auth/me', undefined, { token: r.j.token });
    assert.equal(me.status, 200);
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie })).status, 400, 'reutilização do código');
  });

  await t.test('mesmo e-mail de conta existente: nunca vincula sozinho; exige a senha da conta', async () => {
    const antes = lerColecao('identidades').length;
    const a = await acessarComGoogle({ sub: 'g-rita', email: 'rita@exemplo.test', nome: 'Rita Google' });
    const r = await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie });
    assert.equal(r.j.situacao, 'vincular');
    assert.equal(r.j.token, undefined, 'sem sessão antes da senha');
    assert.equal(lerColecao('identidades').length, antes, 'nada vinculado ainda');
    assert.equal((await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'X', cpf: '111.444.777-35' }, { cookie: a.cookie })).status, 400, 'não cria conta duplicada para o e-mail');
    const errada = await api('POST', '/api/oauth/google/vincular', { codigo: a.codigo, senha: 'errada' }, { cookie: a.cookie });
    assert.equal(errada.status, 401);
    assert.equal(lerColecao('identidades').length, antes);
    const outroNav = await api('POST', '/api/oauth/google/vincular', { codigo: a.codigo, senha }, { cookie: 'agemob_oauth=' + 'x'.repeat(43) });
    assert.equal(outroNav.status, 400, 'outro navegador não usa o código');
    const ok = await api('POST', '/api/oauth/google/vincular', { codigo: a.codigo, senha }, { cookie: a.cookie });
    assert.equal(ok.status, 200);
    assert.equal(ok.j.user.email, 'rita@exemplo.test');
    assert.equal(ok.j.user.imobiliariaId, existente.j.user.imobiliariaId, 'mesmo tenant da conta existente');
    const b = await acessarComGoogle({ sub: 'g-rita', email: 'rita@exemplo.test' });
    const r2 = await api('POST', '/api/oauth/google/resultado', { codigo: b.codigo }, { cookie: b.cookie });
    assert.equal(r2.j.situacao, 'login');
    assert.equal(r2.j.user.imobiliariaId, existente.j.user.imobiliariaId);
    assert.equal((await api('POST', '/api/auth/login', { email: 'rita@exemplo.test', senha })).status, 200, 'login por senha continua');
  });

  await t.test('vínculo: limite de tentativas, uma conta Google por usuário e vínculo a outra conta com e-mail diferente', async () => {
    const a = await acessarComGoogle({ sub: 'g-tentativas', email: 'otavio@exemplo.test' });
    for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/api/oauth/google/vincular', { codigo: a.codigo, senha: 'errada' + i }, { cookie: a.cookie })).status, 401);
    assert.equal((await api('POST', '/api/oauth/google/vincular', { codigo: a.codigo, senha }, { cookie: a.cookie })).status, 429, 'bloqueia após 5 tentativas');
    // Google novo (e-mail sem conta) vinculado a conta existente de outro e-mail, com a senha dela
    const b = await acessarComGoogle({ sub: 'g-otavio-pessoal', email: 'otavio.pessoal@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: b.codigo }, { cookie: b.cookie })).j.situacao, 'cadastro');
    const v = await api('POST', '/api/oauth/google/vincular', { codigo: b.codigo, email: 'otavio@exemplo.test', senha }, { cookie: b.cookie });
    assert.equal(v.status, 200);
    assert.equal(v.j.user.email, 'otavio@exemplo.test');
    // Segunda conta Google para o mesmo usuário → recusada
    const c = await acessarComGoogle({ sub: 'g-otavio-3', email: 'otavio3@exemplo.test' });
    const v2 = await api('POST', '/api/oauth/google/vincular', { codigo: c.codigo, email: 'otavio@exemplo.test', senha }, { cookie: c.cookie });
    assert.equal(v2.status, 409);
  });

  await t.test('e-mail duplicado durante o cadastro Google: não duplica, oferece vínculo', async () => {
    const a = await acessarComGoogle({ sub: 'g-corrida', email: 'corrida@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie })).j.situacao, 'cadastro');
    assert.equal((await cadastro({ tipoCliente: 'corretor', nome: 'Corrida', cpf: '153.509.460-56', responsavel: 'Corrida', email: 'corrida@exemplo.test' })).status, 200);
    const c = await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Corrida 2', cpf: '111.444.777-35' }, { cookie: a.cookie });
    assert.equal(c.status, 409);
    assert.equal(c.j.codigo, 'email_existente');
    assert.equal(lerColecao('usuarios').filter(u => u.email === 'corrida@exemplo.test').length, 1);
  });

  await t.test('tenant desativado: Google não entra (nem por vínculo) e o motivo é informado', async () => {
    const imobId = existente.j.user.imobiliariaId;
    assert.equal((await api('PATCH', `/api/admin/imobiliarias/${imobId}/status`, { ativo: false }, { token: sa.j.token })).status, 200);
    const a = await acessarComGoogle({ sub: 'g-rita', email: 'rita@exemplo.test' });
    const r = await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie });
    assert.equal(r.status, 403);
    assert.match(r.j.erro, /desativada/i);
    assert.equal(r.j.token, undefined);
    assert.equal((await api('POST', '/api/auth/login', { email: 'rita@exemplo.test', senha })).status, 403, 'mesma regra do login por senha');
    // Vínculo com a senha correta também é barrado enquanto o tenant estiver desativado
    const v = await acessarComGoogle({ sub: 'g-rita-2', email: 'rita.outra@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: v.codigo }, { cookie: v.cookie })).j.situacao, 'cadastro');
    const vinc = await api('POST', '/api/oauth/google/vincular', { codigo: v.codigo, email: 'rita@exemplo.test', senha }, { cookie: v.cookie });
    assert.equal(vinc.status, 403);
    assert.equal(lerColecao('identidades').filter(i => i.chave === 'google:g-rita-2').length, 0);
    assert.equal((await api('PATCH', `/api/admin/imobiliarias/${imobId}/status`, { ativo: true }, { token: sa.j.token })).status, 200);
    const volta = await acessarComGoogle({ sub: 'g-rita', email: 'rita@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: volta.codigo }, { cookie: volta.cookie })).j.situacao, 'login', 'reativado: volta a entrar');
  });

  await t.test('Super Admin não usa login com Google', async () => {
    const a = await acessarComGoogle({ sub: 'g-sa', email: 'admin@agemob.com.br' });
    const r = await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie });
    assert.equal(r.status, 403);
    assert.equal(lerColecao('identidades').filter(i => i.chave === 'google:g-sa').length, 0);
    // Vínculo a Super Admin com a senha CERTA: mesma resposta de credencial inválida (sem oráculo de senha)
    const b = await acessarComGoogle({ sub: 'g-sa-2', email: 'outro.sa@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: b.codigo }, { cookie: b.cookie })).j.situacao, 'cadastro');
    const v = await api('POST', '/api/oauth/google/vincular', { codigo: b.codigo, email: 'admin@agemob.com.br', senha: 'Sup3r-teste-123' }, { cookie: b.cookie });
    assert.equal(v.status, 401);
    assert.equal(v.j.erro, 'E-mail ou senha incorretos.');
  });

  await t.test('resultados consumidos são apagados (não guardam e-mail/nome além do uso)', async () => {
    const consumidos = lerColecao('oauth').filter(r => r.tipo === 'resultado' && r.usadoEm);
    assert.equal(consumidos.length, 0, JSON.stringify(consumidos.map(r => r.situacao)));
    assert.ok(lerColecao('identidades').every(i => i.usuarioProvedor === 'google:' + i.usuarioId), 'índice de uma identidade por usuário');
  });

  await t.test('cadastro Google e cadastro tradicional simultâneos com o mesmo e-mail → uma única conta', async () => {
    const a = await acessarComGoogle({ sub: 'g-simultaneo', email: 'simultaneo@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie })).j.situacao, 'cadastro');
    const reqs = [api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Sim G', cpf: '390.533.447-05' }, { cookie: a.cookie })];
    for (let i = 0; i < 4; i++) reqs.push(cadastro({ tipoCliente: 'corretor', nome: 'Sim T' + i, cpf: '153.509.460-56', responsavel: 'Sim T' + i, email: 'simultaneo@exemplo.test' }));
    const rs = await Promise.all(reqs);
    assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.status)));
    assert.equal(lerColecao('usuarios').filter(u => u.email === 'simultaneo@exemplo.test').length, 1);
  });

  await t.test('estado: expirado, reutilizado (replay do callback) e sem o cookie do navegador', async () => {
    const exp = await acessarComGoogle({ sub: 'g-exp', email: 'exp@exemplo.test' }, { esperarMs: TTL + 800 });
    assert.equal(exp.erro, 'expirado');
    const rep = await acessarComGoogle({ sub: 'g-rep', email: 'rep@exemplo.test' }, { repetirCallback: true });
    assert.ok(rep.codigo);
    assert.match(rep.replay, /#google_erro=expirado$/, 'state é de uso único');
    const sem = await acessarComGoogle({ sub: 'g-sem', email: 'sem@exemplo.test' }, { semCookie: true });
    assert.equal(sem.erro, 'sessao');
    const outro = await acessarComGoogle({ sub: 'g-outro', email: 'outro@exemplo.test' }, { cookieOutro: 'agemob_oauth=' + crypto.randomBytes(32).toString('base64url') });
    assert.equal(outro.erro, 'sessao', 'login CSRF: callback em outro navegador');
    const forjado = await fetch(`${BASE}/api/oauth/google/callback?state=${'a'.repeat(43)}&code=abc`, { redirect: 'manual', headers: { 'x-forwarded-for': ipNovo() } });
    assert.match(forjado.headers.get('location'), /#google_erro=expirado$/);
  });

  await t.test('resultado pendente expira', async () => {
    const a = await acessarComGoogle({ sub: 'g-pend', email: 'pend@exemplo.test' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie })).j.situacao, 'cadastro');
    await espera(TTL + 800);
    assert.equal((await api('POST', '/api/oauth/google/cadastro', { codigo: a.codigo, tipoCliente: 'corretor', nome: 'Pend', cpf: '390.533.447-05' }, { cookie: a.cookie })).status, 400);
  });

  await t.test('token inválido: assinatura, nonce, emissor, público, expirado e e-mail não verificado', async () => {
    const casos = [['assinaturaInvalida', { assinaturaInvalida: true }, 'falha'], ['nonce', { nonceErrado: true }, 'falha'],
      ['emissor', { iss: 'https://accounts.google.com' }, 'falha'], ['publico', { aud: 'outro-cliente.apps.googleusercontent.com' }, 'falha'],
      ['expirado', { expirado: true }, 'falha'], ['email', { emailVerificado: false }, 'email']];
    for (const [nome, extra, esperado] of casos) {
      const a = await acessarComGoogle({ sub: 'g-inv-' + nome, email: `inv-${nome}@exemplo.test`, ...extra });
      assert.equal(a.erro, esperado, nome);
    }
    assert.equal(lerColecao('usuarios').filter(u => /^inv-/.test(u.email)).length, 0, 'nenhuma conta criada');
    const logs = lerColecao('logs').map(l => JSON.stringify(l)).join('\n');
    assert.match(logs, /Login Google recusado: id_token_assinatura/);
    assert.match(logs, /Login Google recusado: id_token_nonce/);
    assert.ok(!/inv-assinaturaInvalida@/.test(logs), 'logs de recusa sem e-mail');
  });

  await t.test('cancelamento no Google volta com aviso, sem criar nada', async () => {
    const a = await acessarComGoogle({ cancelar: true, sub: 'g-cancel', email: 'cancel@exemplo.test' });
    assert.equal(a.erro, 'cancelado');
  });

  await t.test('plano inválido é ignorado; plano real é preservado', async () => {
    const a = await acessarComGoogle({ sub: 'g-plano', email: 'plano@exemplo.test' }, { plano: 'plano-inexistente' });
    assert.equal((await api('POST', '/api/oauth/google/resultado', { codigo: a.codigo }, { cookie: a.cookie })).j.plano, null);
  });

  await t.test('regressão: cadastro e login tradicionais inalterados', async () => {
    const c = await cadastro({ tipoCliente: 'corretor', nome: 'Tradicional', cpf: '111.444.777-35', responsavel: 'Tradicional', email: 'tradicional@exemplo.test' });
    assert.equal(c.status, 200);
    assert.equal((await cadastro({ tipoCliente: 'corretor', nome: 'Dup', cpf: '1', responsavel: 'Dup', email: 'tradicional@exemplo.test' })).j.erro, 'E-mail ja cadastrado.');
    const l = await api('POST', '/api/auth/login', { email: 'tradicional@exemplo.test', senha });
    assert.equal(l.status, 200);
    assert.deepEqual(Object.keys(l.j.user).sort(), ['_id', 'email', 'imobiliaria', 'imobiliariaId', 'imobiliariaSlug', 'nome', 'role']);
    assert.equal((await api('POST', '/api/auth/login', { email: 'tradicional@exemplo.test', senha: 'errada' })).status, 401);
    const u = lerColecao('usuarios').find(x => x.email === 'tradicional@exemplo.test');
    assert.match(u.senha, /^\$2[aby]\$10\$/, 'senha continua com bcrypt');
  });
});
