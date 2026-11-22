'use strict';
// M11 — Assinatura vigente única, operações simultâneas, pagamento simulado,
// limites, créditos, status, Super Admin e multitenancy.
// server.js real com dados temporários + InfinitePay FALSA local
// (INFINITEPAY_API_URL, permitida só fora de produção). Dados fictícios.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const bcrypt = require('bcryptjs');

const RAIZ = path.join(__dirname, '..');
const SENHA_SA = 'Sup3r-teste-123';
const SENHA = 'senha123';

// InfinitePay falsa: /links devolve URL de checkout; /payment_check confirma
// o valor do pedido (ou o cenário configurado).
function infinitepayFalsa() {
  const pedidos = new Map();
  const f = { pedidos, cenario: {} };
  f.servidor = http.createServer((req, res) => {
    let c = '';
    req.on('data', d => { c += d; });
    req.on('end', () => {
      const corpo = c ? JSON.parse(c) : {};
      res.setHeader('content-type', 'application/json');
      if (req.url === '/links') {
        const valor = corpo.items && corpo.items[0] && corpo.items[0].price;
        pedidos.set(corpo.order_nsu, valor);
        return res.end(JSON.stringify({ url: 'https://checkout.infinitepay.io/teste/' + corpo.order_nsu }));
      }
      if (req.url === '/payment_check') {
        const valor = pedidos.get(corpo.order_nsu);
        if (f.cenario.naoPago) return res.end(JSON.stringify({ success: true, paid: false }));
        return res.end(JSON.stringify({ success: true, paid: valor !== undefined, amount: valor, paid_amount: valor, capture_method: 'pix' }));
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  return f;
}

async function subir(t, { preparar, env } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agemob-assinaturas-test-'));
  const DATA = path.join(tmp, 'data');
  fs.mkdirSync(DATA, { recursive: true });
  if (preparar) preparar(DATA);
  const porta = 20000 + Math.floor(Math.random() * 20000);
  const filho = spawn(process.execPath, ['server.js'], { cwd: RAIZ, env: {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', PORT: String(porta),
    DATA_DIR: DATA, STORAGE_DIR: path.join(tmp, 'storage'), BASE_URL: `http://127.0.0.1:${porta}`,
    JWT_SECRET: 'jwt-teste-' + crypto.randomBytes(8).toString('hex'), SUPER_ADMIN_PASS: SENHA_SA,
    BREVO_API_KEY: '', BREVO_SENDER: '', INFINITEPAY_DESATIVADO: 'true',
    DOSSIE_SIGNING_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), ...env } });
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
    const headers = { 'x-forwarded-for': `10.50.${Math.floor(ip / 250) % 250}.${ip++ % 250 + 1}` };
    if (corpo !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = 'Bearer ' + token;
    const r = await fetch(`http://127.0.0.1:${porta}${url}`, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };
  const ler = (nome) => { const u = {}; try { for (const l of fs.readFileSync(path.join(DATA, nome + '.db'), 'utf8').split('\n').filter(Boolean)) { const d = JSON.parse(l); if (d.$$indexCreated) continue; if (d.$$deleted) delete u[d._id]; else u[d._id] = d; } } catch {} return Object.values(u); };
  const sa = (await api('POST', '/api/auth/login', { email: 'admin@agemob.com.br', senha: SENHA_SA })).j.token;
  const planos = (await api('GET', '/api/admin/planos', undefined, sa)).j;
  const plano = (slug) => planos.find(p => p.slug === slug);
  return { api, ler, sa, plano, DATA };
}
const subsDe = (ler, imobId) => ler('subscriptions').filter(s => s.imobiliariaId === imobId);
const vigentesDe = (ler, imobId) => subsDe(ler, imobId).filter(s => !s.substituidaEm);

test('assinatura vigente única: cadastro, iniciar, concorrência, Super Admin, créditos, limites, status', { timeout: 180000 }, async (t) => {
  const { api, ler, sa, plano } = await subir(t);
  const conta = async (sufixo) => {
    const c = await api('POST', '/api/cadastro', { tipoCliente: 'imobiliaria', nome: 'Imob ' + sufixo, cnpj: '1' + sufixo, creci: 'J-' + sufixo, responsavel: 'R ' + sufixo, email: `${sufixo}@assin.test`, senha: SENHA, telefone: '48999999999' });
    assert.equal(c.status, 200, JSON.stringify(c.j));
    return { id: c.j.user.imobiliariaId, token: c.j.token };
  };

  await t.test('cadastro cria exatamente uma assinatura (trial) e o ponteiro aponta para ela', async () => {
    const a = await conta('cad1');
    const subs = subsDe(ler, a.id);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].status, 'trial');
    assert.equal(ler('imobiliarias').find(i => i._id === a.id).subscriptionId, subs[0]._id);
  });

  let A;
  await t.test('iniciar com trial existente: a anterior vira histórico (não apagada) e a nova é a única vigente', async () => {
    A = await conta('ini1');
    const trial = subsDe(ler, A.id)[0];
    const r = await api('POST', `/api/admin/subscriptions/${A.id}/iniciar`, { planoId: plano('pro')._id, status: 'ativo' }, sa);
    assert.equal(r.status, 200);
    const subs = subsDe(ler, A.id);
    assert.equal(subs.length, 2, 'histórico preservado');
    const vig = vigentesDe(ler, A.id);
    assert.equal(vig.length, 1);
    assert.equal(vig[0].planoSlug, 'pro'); assert.equal(vig[0].status, 'active');
    const antiga = subs.find(s => s._id === trial._id);
    assert.ok(antiga.substituidaEm); assert.equal(antiga.substituidaPor, vig[0]._id); assert.equal(antiga.status, 'trial', 'dados da anterior intactos');
    assert.equal(ler('imobiliarias').find(i => i._id === A.id).subscriptionId, vig[0]._id);
    const hist = ler('subscription_history').filter(h => h.imobiliariaId === A.id && h.tipo === 'substituicao');
    assert.equal(hist.length, 1); assert.equal(hist[0].previousSubscriptionId, trial._id);
    // Leitura determinística: o painel vê sempre a vigente (antes podia ver a trial)
    for (let i = 0; i < 8; i++) {
      const m = await api('GET', '/api/minha-assinatura', undefined, A.token);
      assert.equal(m.status, 200); assert.equal(m.j.sub._id, vig[0]._id); assert.equal(m.j.acesso.statusEfetivo, 'ativo');
    }
  });

  await t.test('5 "iniciar" simultâneos com planos diferentes → uma única vigente, coerente com o ponteiro', async () => {
    const B = await conta('par1');
    const slugs = ['start', 'pro', 'prime', 'pro', 'start'];
    const rs = await Promise.all(slugs.map(s => api('POST', `/api/admin/subscriptions/${B.id}/iniciar`, { planoId: plano(s)._id, status: 'ativo' }, sa)));
    assert.ok(rs.every(r => r.status === 200));
    assert.equal(subsDe(ler, B.id).length, 6);
    const vig = vigentesDe(ler, B.id);
    assert.equal(vig.length, 1);
    assert.equal(ler('imobiliarias').find(i => i._id === B.id).subscriptionId, vig[0]._id);
    assert.equal(ler('imobiliarias').find(i => i._id === B.id).planoSlug, vig[0].planoSlug, 'imobiliária sincronizada com a vigente');
  });

  await t.test('créditos, limite, plano e status do Super Admin atingem só a vigente', async () => {
    const antiga = subsDe(ler, A.id).find(s => s.substituidaEm);
    const antes = JSON.stringify(antiga);
    assert.equal((await api('POST', `/api/admin/subscriptions/${A.id}/creditos`, { quantidade: 3, motivo: 'teste' }, sa)).status, 200);
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${A.id}/limite`, { limite: 40 }, sa)).status, 200);
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${A.id}/plano`, { planoId: plano('prime')._id, motivo: 'upgrade' }, sa)).status, 200);
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${A.id}/status`, { status: 'delinquent' }, sa)).status, 200);
    assert.equal((await api('PATCH', `/api/admin/imobiliarias/${A.id}`, { nome: 'Imob ini1', planoId: plano('pro')._id }, sa)).status, 200);
    const vig = vigentesDe(ler, A.id)[0];
    assert.equal(vig.extraAutorizacoes, 3);
    assert.equal(vig.planoSlug, 'pro');
    assert.equal(vig.status, 'pending');
    assert.equal(JSON.stringify(subsDe(ler, A.id).find(s => s._id === antiga._id)), antes, 'histórico intocado');
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${A.id}/status`, { status: 'active' }, sa)).status, 200);
    assert.equal(vigentesDe(ler, A.id)[0].status, 'active');
  });

  await t.test('suspensão e reativação: suspenso entra mas não emite; reativado volta a emitir', async () => {
    const C = await conta('sus1');
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${C.id}/status`, { status: 'suspended' }, sa)).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { email: 'sus1@assin.test', senha: SENHA })).status, 200);
    assert.equal((await api('POST', '/api/autorizacoes', {}, C.token)).status, 402);
    assert.equal((await api('PATCH', `/api/admin/subscriptions/${C.id}/status`, { status: 'active' }, sa)).status, 200);
    assert.equal((await api('POST', '/api/autorizacoes', {}, C.token)).status, 200);
  });

  await t.test('trial: 6 autorizações simultâneas → só 1 criada (a gratuita); as demais 402', async () => {
    const D = await conta('tri1');
    const rs = await Promise.all(Array.from({ length: 6 }, () => api('POST', '/api/autorizacoes', {}, D.token)));
    assert.equal(rs.filter(r => r.status === 200).length, 1, JSON.stringify(rs.map(r => r.status)));
    assert.ok(rs.filter(r => r.status !== 200).every(r => r.status === 402));
    assert.equal(ler('autorizacoes').filter(a => a.imobiliariaId === D.id).length, 1);
  });

  await t.test('plano com limite 2: 8 simultâneas (3 rotas) → exatamente 2; créditos extras consumidos um a um', async () => {
    const E = await conta('lim1');
    await api('POST', `/api/admin/subscriptions/${E.id}/iniciar`, { planoId: plano('start')._id, status: 'ativo' }, sa);
    await api('PATCH', `/api/admin/subscriptions/${E.id}/limite`, { limite: 2 }, sa);
    const corpoR = { proprietario: { nome: 'P' }, imovel: { end: 'Rua' } };
    const reqs = Array.from({ length: 8 }, (_, i) => i % 3 === 0 ? api('POST', '/api/autorizacoes', {}, E.token) : i % 3 === 1 ? api('POST', '/api/autorizacoes/rascunho', corpoR, E.token) : api('POST', '/api/autorizacoes/manual', corpoR, E.token));
    const rs = await Promise.all(reqs);
    assert.equal(rs.filter(r => r.status === 200).length, 2, JSON.stringify(rs.map(r => r.status)));
    assert.equal(ler('autorizacoes').filter(a => a.imobiliariaId === E.id).length, 2);
    await api('POST', `/api/admin/imobiliarias/${E.id}/creditos`, { quantidade: 2, motivo: 'teste' }, sa);
    const rs2 = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/api/autorizacoes', {}, E.token)));
    assert.equal(rs2.filter(r => r.status === 200).length, 2, JSON.stringify(rs2.map(r => r.status)));
    assert.equal(ler('imobiliarias').find(i => i._id === E.id).creditosExtras, 0);
    assert.equal(ler('autorizacoes').filter(a => a.imobiliariaId === E.id && a.consumo === 'credito_extra').length, 2);
  });

  await t.test('multitenancy: operações de um tenant não alcançam outro', async () => {
    const X = await conta('mtx'), Y = await conta('mty');
    const subY = JSON.stringify(subsDe(ler, Y.id));
    await api('POST', `/api/admin/subscriptions/${X.id}/iniciar`, { planoId: plano('prime')._id, status: 'ativo' }, sa);
    await api('POST', `/api/admin/subscriptions/${X.id}/creditos`, { quantidade: 5 }, sa);
    await api('POST', '/api/autorizacoes', {}, X.token);
    assert.equal(JSON.stringify(subsDe(ler, Y.id)), subY);
    const listaY = await api('GET', '/api/autorizacoes', undefined, Y.token);
    assert.equal(listaY.status, 200);
    assert.ok(listaY.j.every(a => a.imobiliariaId === Y.id));
    assert.equal(ler('autorizacoes').filter(a => a.imobiliariaId === Y.id).length, 0);
  });
});

test('pagamento simulado (InfinitePay falsa): aplica na vigente, renova, idempotente e concorrente', { timeout: 180000 }, async (t) => {
  const ip = infinitepayFalsa();
  await new Promise(ok => ip.servidor.listen(0, '127.0.0.1', ok));
  t.after(() => ip.servidor.close());
  const { api, ler, sa, plano } = await subir(t, { env: { INFINITEPAY_DESATIVADO: '', INFINITEPAY_API_KEY: 'inchk_teste', INFINITEPAY_HANDLE: 'agemob-teste', INFINITEPAY_API_URL: `http://127.0.0.1:${ip.servidor.address().port}` } });
  const c = await api('POST', '/api/cadastro', { tipoCliente: 'imobiliaria', nome: 'Pagante', cnpj: '9', creci: 'J-9', responsavel: 'Paula', email: 'pagante@assin.test', senha: SENHA, telefone: '48999999999' });
  const id = c.j.user.imobiliariaId, tok = c.j.token;
  // Cenário do problema: trial + "iniciar" deixou histórico; o pagamento deve ir para a vigente.
  await api('POST', `/api/admin/subscriptions/${id}/iniciar`, { planoId: plano('start')._id, status: 'ativo' }, sa);
  const historicaAntes = JSON.stringify(subsDe(ler, id).find(s => s.substituidaEm));
  const pagar = async () => {
    const p = await api('POST', '/api/pagamentos/criar', { planoId: plano('pro')._id }, tok);
    assert.equal(p.status, 200, JSON.stringify(p.j));
    return p.j.orderNsu;
  };
  const webhook = (orderNsu, tx) => api('POST', '/api/webhooks/infinitepay', { order_nsu: orderNsu, transaction_nsu: tx, invoice_slug: 'slug-' + tx });

  await t.test('pagamento confirmado aplica o Pro por 30 dias na assinatura vigente (sem criar outra)', async () => {
    const o1 = await pagar();
    assert.equal((await webhook(o1, 'tx1')).status, 200);
    const vig = vigentesDe(ler, id);
    assert.equal(vig.length, 1);
    assert.equal(vig[0].planoSlug, 'pro'); assert.equal(vig[0].status, 'active');
    const dias = (new Date(vig[0].planoVencimento) - Date.now()) / 86400000;
    assert.ok(dias > 29.9 && dias <= 30.01, String(dias));
    assert.equal(subsDe(ler, id).length, 2);
    assert.equal(JSON.stringify(subsDe(ler, id).find(s => s.substituidaEm)), historicaAntes, 'histórico intocado');
  });
  await t.test('renovação soma 30 dias ao vencimento vigente; reenvio do webhook não aplica de novo', async () => {
    const venc1 = new Date(vigentesDe(ler, id)[0].planoVencimento);
    const o2 = await pagar();
    assert.equal((await webhook(o2, 'tx2')).status, 200);
    const venc2 = new Date(vigentesDe(ler, id)[0].planoVencimento);
    assert.equal(Math.round((venc2 - venc1) / 86400000), 30);
    assert.equal((await webhook(o2, 'tx2')).status, 200);
    assert.equal(new Date(vigentesDe(ler, id)[0].planoVencimento).getTime(), venc2.getTime(), 'reenvio idempotente');
  });
  await t.test('webhooks simultâneos do mesmo pedido aplicam uma única vez', async () => {
    const venc = new Date(vigentesDe(ler, id)[0].planoVencimento);
    const o3 = await pagar();
    const rs = await Promise.all(Array.from({ length: 5 }, () => webhook(o3, 'tx3')));
    assert.ok(rs.every(r => r.status === 200));
    const novo = new Date(vigentesDe(ler, id)[0].planoVencimento);
    assert.equal(Math.round((novo - venc) / 86400000), 30);
    assert.equal(ler('pagamentos').filter(p => p.orderNsu === o3 && p.aplicacaoStatus === 'applied').length, 1);
  });
  await t.test('pagamento não confirmado não ativa nada', async () => {
    ip.cenario.naoPago = true;
    const antes = JSON.stringify(vigentesDe(ler, id));
    const o4 = await pagar();
    assert.equal((await webhook(o4, 'tx4')).status, 200);
    assert.equal(JSON.stringify(vigentesDe(ler, id)), antes);
    assert.equal(ler('pagamentos').find(p => p.orderNsu === o4).status, 'pending');
    ip.cenario.naoPago = false;
  });
});

test('dados legados: sem ponteiro ou com ponteiro inválido, a vigente é a mais recente; nada é gravado na leitura', { timeout: 120000 }, async (t) => {
  const hash = bcrypt.hashSync(SENHA, 4);
  const agora = Date.now();
  const iso = (ms) => new Date(agora - ms).toISOString();
  const { api, DATA } = await subir(t, { preparar: (data) => {
    const imobs = [
      { _id: 'legA', tipoCliente: 'imobiliaria', nome: 'Legado A', status: 'ativo', ativo: true, planoId: 'x', limiteAutorizacoes: 10, creditosExtras: 0, criadoEm: iso(9e8) },
      { _id: 'legB', tipoCliente: 'imobiliaria', nome: 'Legado B', status: 'ativo', ativo: true, subscriptionId: 'naoexiste', limiteAutorizacoes: 10, creditosExtras: 0, criadoEm: iso(9e8) }
    ];
    const subs = [
      { _id: 'subA1', imobiliariaId: 'legA', planoSlug: 'trial', planoNome: 'Trial', status: 'trial', trialExpiration: iso(5e8), criadoEm: iso(8e8) },
      { _id: 'subA2', imobiliariaId: 'legA', planoSlug: 'pro', planoNome: 'Pro', status: 'active', planoVencimento: new Date(agora + 9e8).toISOString(), criadoEm: iso(1e8) },
      { _id: 'subB1', imobiliariaId: 'legB', planoSlug: 'trial', planoNome: 'Trial', status: 'trial', trialExpiration: iso(5e8), criadoEm: iso(8e8) },
      { _id: 'subB2', imobiliariaId: 'legB', planoSlug: 'start', planoNome: 'Start', status: 'active', planoVencimento: new Date(agora + 9e8).toISOString(), criadoEm: iso(2e8) }
    ];
    const usuarios = [
      { _id: 'uA', nome: 'A', email: 'a@legado.test', senha: hash, role: 'admin', imobiliariaId: 'legA', ativo: true },
      { _id: 'uB', nome: 'B', email: 'b@legado.test', senha: hash, role: 'admin', imobiliariaId: 'legB', ativo: true }
    ];
    for (const [n, l] of [['imobiliarias', imobs], ['subscriptions', subs], ['usuarios', usuarios]]) fs.writeFileSync(path.join(data, n + '.db'), l.map(x => JSON.stringify(x)).join('\n') + '\n');
  } });
  const subsAntes = fs.readFileSync(path.join(DATA, 'subscriptions.db'), 'utf8');
  for (const [email, esperado] of [['a@legado.test', 'subA2'], ['b@legado.test', 'subB2']]) {
    const tok = (await api('POST', '/api/auth/login', { email, senha: SENHA })).j.token;
    for (let i = 0; i < 5; i++) {
      const m = await api('GET', '/api/minha-assinatura', undefined, tok);
      assert.equal(m.status, 200, email);
      assert.equal(m.j.sub._id, esperado, email + ': mais recente não substituída');
      assert.equal(m.j.acesso.statusEfetivo, 'ativo', email + ': não cai na trial antiga');
    }
  }
  assert.equal(fs.readFileSync(path.join(DATA, 'subscriptions.db'), 'utf8'), subsAntes, 'leitura não altera dados legados');
});
