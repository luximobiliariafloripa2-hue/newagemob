'use strict';
// M11 Fase A — CRECI do corretor autônomo: opcional no cadastro, obrigatório
// antes da primeira autorização. server.js real com DATA_DIR/STORAGE_DIR
// temporários; dados 100% fictícios; e-mail e pagamento desligados.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const SENHA = 'senha123';

async function subir(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agemob-creci-test-'));
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(DATA, { recursive: true });
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const filho = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PORT: String(porta),
    DATA_DIR: DATA, STORAGE_DIR: path.join(tmp, 'storage'), BASE_URL: `http://127.0.0.1:${porta}`,
    JWT_SECRET: 'jwt-teste-' + crypto.randomBytes(8).toString('hex'), SUPER_ADMIN_PASS: 'Sup3r-teste-123',
    BREVO_API_KEY: '', BREVO_SENDER: '', INFINITEPAY_DESATIVADO: 'true',
    DOSSIE_SIGNING_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) } });
  let saida = '';
  t.after(() => { filho.kill(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  await new Promise((ok, falha) => {
    const tempo = setTimeout(() => falha(new Error('servidor não subiu: ' + saida)), 60000);
    filho.stdout.on('data', d => { saida += d; if (saida.includes('rodando')) { clearTimeout(tempo); ok(); } });
    filho.stderr.on('data', d => { saida += d; });
    filho.on('exit', () => falha(new Error('servidor encerrou: ' + saida)));
  });
  let ip = 1;
  const api = async (metodo, url, corpo, token) => {
    const headers = { 'x-forwarded-for': `10.60.${Math.floor(ip / 250) % 250}.${ip++ % 250 + 1}` };
    if (corpo !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(`http://127.0.0.1:${porta}${url}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };
  const ler = (nome) => { const u = {}; try { for (const l of fs.readFileSync(path.join(DATA, nome + '.db'), 'utf8').split('\n').filter(Boolean)) { const d = JSON.parse(l); if (d.$$indexCreated) continue; if (d.$$deleted) delete u[d._id]; else u[d._id] = d; } } catch {} return Object.values(u); };
  return { api, ler };
}

const PROPRIETARIO = { nome: 'Proprietário Fictício', cpf: '000.000.000-00' };
const IMOVEL = { end: 'Rua Fictícia', num: '1', cidade: 'Cidade Teste' };

test('CRECI do corretor autônomo: cadastro sem CRECI, bloqueio, regularização e liberação', { timeout: 120000 }, async (t) => {
  const { api, ler } = await subir(t);
  const autorizacoesDe = (id) => ler('autorizacoes').filter(a => a.imobiliariaId === id);
  let token, imobId;

  await t.test('cadastro de corretor autônomo sem CRECI é aceito', async () => {
    const r = await api('POST', '/api/cadastro', { tipoCliente: 'corretor', nome: 'Corretor Fictício', cpf: '111.111.111-11', responsavel: 'Corretor Fictício', email: 'corretor@creci.test', senha: SENHA, telefone: '48999999999' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    token = r.j.token; imobId = r.j.user.imobiliariaId;
    const imob = ler('imobiliarias').find(i => i._id === imobId);
    assert.equal(imob.tipoCliente, 'corretor');
    assert.equal(imob.creci, '');
  });

  await t.test('painel acessível sem CRECI e perfil indica CRECI pendente', async () => {
    assert.equal((await api('GET', '/api/auth/me', undefined, token)).status, 200);
    assert.equal((await api('GET', '/api/dashboard', undefined, token)).status, 200);
    assert.equal((await api('GET', '/api/autorizacoes', undefined, token)).status, 200);
    const id = await api('GET', '/api/minha-identidade', undefined, token);
    assert.equal(id.status, 200);
    assert.equal(id.j.creciPendente, true);
    assert.equal(id.j.creci, null);
  });

  await t.test('primeira autorização bloqueada nas três rotas enquanto o CRECI está pendente', async () => {
    const vazio = await api('POST', '/api/autorizacoes', {}, token);
    const rascunho = await api('POST', '/api/autorizacoes/rascunho', { proprietario: PROPRIETARIO, imovel: IMOVEL }, token);
    const manual = await api('POST', '/api/autorizacoes/manual', { proprietario: PROPRIETARIO, imovel: IMOVEL, tipo: 'sem_exclusividade' }, token);
    for (const r of [vazio, rascunho, manual]) {
      assert.equal(r.status, 422, JSON.stringify(r.j));
      assert.equal(r.j.codigo, 'CRECI_OBRIGATORIO');
    }
    // Nada gravado e a autorização gratuita do trial não foi consumida.
    assert.equal(autorizacoesDe(imobId).length, 0);
  });

  await t.test('inclusão posterior do CRECI: inválido recusado, válido gravado, sem nova alteração pelo perfil', async () => {
    const invalido = await api('PUT', '/api/minha-identidade/creci', { creci: 'abc' }, token);
    assert.equal(invalido.status, 422);
    const ok = await api('PUT', '/api/minha-identidade/creci', { creci: '12345-f' }, token);
    assert.equal(ok.status, 200, JSON.stringify(ok.j));
    assert.equal(ok.j.creci, '12345-F');
    assert.equal(ler('imobiliarias').find(i => i._id === imobId).creci, '12345-F');
    const id = await api('GET', '/api/minha-identidade', undefined, token);
    assert.equal(id.j.creciPendente, false);
    assert.equal(id.j.creci, '12345-F');
    const denovo = await api('PUT', '/api/minha-identidade/creci', { creci: '99999-F' }, token);
    assert.equal(denovo.status, 409);
    assert.equal(ler('imobiliarias').find(i => i._id === imobId).creci, '12345-F');
  });

  await t.test('após a regularização a autorização é criada (consome o trial)', async () => {
    const r = await api('POST', '/api/autorizacoes', {}, token);
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.ok(r.j.codigo);
    const auts = autorizacoesDe(imobId);
    assert.equal(auts.length, 1);
    assert.equal(auts[0].consumo, 'trial');
  });

  await t.test('CRECI já usado por outra conta é recusado', async () => {
    const r = await api('POST', '/api/cadastro', { tipoCliente: 'corretor', nome: 'Outro Corretor', cpf: '222.222.222-22', responsavel: 'Outro Corretor', email: 'outro@creci.test', senha: SENHA, telefone: '48988888888' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const dup = await api('PUT', '/api/minha-identidade/creci', { creci: '12345-F' }, r.j.token);
    assert.equal(dup.status, 422);
  });

  await t.test('imobiliária não passa pela regra do CRECI do autônomo', async () => {
    const r = await api('POST', '/api/cadastro', { tipoCliente: 'imobiliaria', nome: 'Imobiliária Fictícia', cnpj: '00.000.000/0001-00', responsavel: 'Resp Fictício', email: 'imob@creci.test', senha: SENHA, telefone: '48977777777' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const aut = await api('POST', '/api/autorizacoes', {}, r.j.token);
    assert.equal(aut.status, 200, JSON.stringify(aut.j));
    const perfil = await api('PUT', '/api/minha-identidade/creci', { creci: '55555-J' }, r.j.token);
    assert.equal(perfil.status, 403);
  });
});
