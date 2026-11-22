'use strict';
// Login com Google (M11 Fase B) — rotas /api/oauth/google/*.
//
// Fluxo (Authorization Code + PKCE + state + nonce, tudo validado no servidor):
//   1. GET  /iniciar   → grava estado (uso único, 10 min) e um cookie HttpOnly de
//                        vínculo com o navegador; redireciona ao Google.
//   2. GET  /callback  → consome o estado, confere o cookie, troca o code (PKCE),
//                        valida o id_token e decide a situação: login | vincular |
//                        cadastro | bloqueado. Volta à landing com um código de uso
//                        único no fragmento (#google=…) — nunca token na URL.
//   3. POST /resultado → troca o código (com o mesmo cookie) pela sessão (login) ou
//                        pelos dados da etapa seguinte (vincular / cadastro).
//   4. POST /vincular  → conta AGEMOB existente: exige a senha dela (titularidade).
//   5. POST /cadastro  → conta nova em trial (mesma rotina do cadastro por e-mail).
//
// Regras: nunca vincula só por e-mail igual; uma conta Google por usuário; Super
// Admin não usa login social; tenant sem acesso não entra; tokens do Google
// não são gravados. Nada aqui altera senhas, planos, assinaturas ou documentos.

const express = require('express');
const crypto = require('crypto');
const { gerarSegredo, hash, ErroGoogle } = require('../services/googleOidc');

const ESTADO_TTL_MS = 10 * 60 * 1000;
const RESULTADO_LOGIN_TTL_MS = 2 * 60 * 1000;
const RESULTADO_PENDENTE_TTL_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 5;
// Destinos de retorno permitidos (nunca URL livre). Durante a homologação só a landing V2.
const RETORNOS = { 'landing-v2': '/landing-v2.html' };
const RETORNO_PADRAO = 'landing-v2';
const RE_SEGREDO = /^[A-Za-z0-9_-]{32,128}$/;
const ERRO_EXPIRADO = { erro: 'O acesso com o Google expirou. Tente novamente.', codigo: 'expirado' };

function iguais(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8'), y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function lerCookie(req, nome) {
  const cab = req.headers.cookie || '';
  for (const parte of cab.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nome) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}

module.exports = function rotasAuthGoogle(deps) {
  const { db, log, getBaseUrl, carregarAcessoTenant, criarContaTrial, desfazerContaCriada, emitirSessaoUsuario,
    enviarBoasVindas, bcrypt, google, producao, ttlTesteMs, comTravaEmail } = deps;
  // Hash fictício: comparação de senha com custo constante quando a conta não existe
  // (o tempo de resposta não revela se há conta para o e-mail informado).
  const HASH_FICTICIO = bcrypt.hashSync(gerarSegredo(), 10);
  // Só nos testes automatizados (provedor falso, proibido em produção): validades curtas.
  const TTL_ESTADO = ttlTesteMs || ESTADO_TTL_MS;
  const TTL_PENDENTE = ttlTesteMs || RESULTADO_PENDENTE_TTL_MS;
  const router = express.Router();
  const COOKIE = producao ? '__Host-agemob_oauth' : 'agemob_oauth';
  const agoraIso = () => new Date().toISOString();

  function opcoesCookie(req, maxAgeMs) {
    return { httpOnly: true, sameSite: 'lax', secure: producao || req.secure, path: '/', maxAge: maxAgeMs };
  }
  function limparCookie(req, res) { res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: producao || req.secure, path: '/' }); }
  function vinculoDoNavegador(req) {
    const v = lerCookie(req, COOKIE);
    return RE_SEGREDO.test(v) ? hash(v) : '';
  }
  function voltar(res, retorno, fragmento) {
    res.redirect(302, (RETORNOS[retorno] || RETORNOS[RETORNO_PADRAO]) + '#' + fragmento);
  }
  async function planoValido(slug) {
    if (typeof slug !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(slug) || slug === 'trial') return null;
    const p = await db.planos.findOne({ slug, ativo: true });
    return p ? p.slug : null;
  }
  // Acesso de tenant (mesma regra do login por senha).
  async function motivoBloqueio(usuario) {
    if (!usuario || usuario.ativo !== true) return 'Conta inativa. Fale com o administrador da sua conta.';
    if (usuario.role === 'super_admin') return 'Esta conta não pode usar o acesso com Google.';
    if (usuario.role === 'admin' || usuario.role === 'corretor') {
      const { acesso } = await carregarAcessoTenant(usuario.imobiliariaId);
      if (!acesso.podeLogin) return acesso.motivo || 'Acesso indisponível para esta conta.';
    }
    return null;
  }
  // Resultado pendente válido para este navegador (sem consumir).
  async function resultadoDoNavegador(req, codigo, situacoes) {
    if (typeof codigo !== 'string' || !RE_SEGREDO.test(codigo)) return null;
    const vinc = vinculoDoNavegador(req);
    if (!vinc) return null;
    const r = await db.oauth.findOne({ tipo: 'resultado', provedor: 'google', codigoHash: hash(codigo), usadoEm: null, expiraEm: { $gt: agoraIso() } });
    if (!r || !iguais(r.vinculoHash, vinc) || (situacoes && !situacoes.includes(r.situacao))) return null;
    return r;
  }
  async function consumir(r) {
    const ok = (await db.oauth.update({ _id: r._id, usadoEm: null }, { $set: { usadoEm: agoraIso() } })) === 1;
    if (ok) { try { await db.oauth.remove({ _id: r._id }); } catch {} }
    return ok;
  }
  async function contarTentativa(r) {
    return (await db.oauth.update({ _id: r._id, usadoEm: null, tentativas: { $lt: MAX_TENTATIVAS } }, { $inc: { tentativas: 1 } })) === 1;
  }
  const redirectUri = (req) => getBaseUrl(req) + '/api/oauth/google/callback';

  // 1. Início
  router.get('/iniciar', async (req, res) => {
    const retorno = RETORNOS[req.query.retorno] ? req.query.retorno : RETORNO_PADRAO;
    if (!google) return voltar(res, retorno, 'google_erro=indisponivel');
    try {
      const state = gerarSegredo(), nonce = gerarSegredo(), codeVerifier = gerarSegredo(48), vinculo = gerarSegredo();
      await db.oauth.insert({
        tipo: 'estado', provedor: 'google', stateHash: hash(state), vinculoHash: hash(vinculo), nonce, codeVerifier,
        plano: await planoValido(req.query.plano), retorno,
        criadoEm: agoraIso(), expiraEm: new Date(Date.now() + TTL_ESTADO).toISOString(), usadoEm: null
      });
      res.cookie(COOKIE, vinculo, opcoesCookie(req, RESULTADO_PENDENTE_TTL_MS + ESTADO_TTL_MS));
      res.redirect(302, google.urlAutorizacao({ state, nonce, codeVerifier, redirectUri: redirectUri(req) }));
    } catch (e) {
      voltar(res, retorno, 'google_erro=falha');
    }
  });

  // 2. Retorno do Google
  router.get('/callback', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    let estado = null;
    if (RE_SEGREDO.test(state)) {
      // Consumo atômico: um estado vale uma única vez e só dentro da validade.
      const n = await db.oauth.update({ tipo: 'estado', provedor: 'google', stateHash: hash(state), usadoEm: null, expiraEm: { $gt: agoraIso() } }, { $set: { usadoEm: agoraIso() } });
      if (n === 1) estado = await db.oauth.findOne({ tipo: 'estado', stateHash: hash(state) });
    }
    const retorno = estado && RETORNOS[estado.retorno] ? estado.retorno : RETORNO_PADRAO;
    if (!google) return voltar(res, retorno, 'google_erro=indisponivel');
    if (typeof req.query.error === 'string') return voltar(res, retorno, 'google_erro=' + (req.query.error === 'access_denied' ? 'cancelado' : 'falha'));
    if (!estado) return voltar(res, retorno, 'google_erro=expirado');
    const vinc = vinculoDoNavegador(req);
    if (!vinc || !iguais(estado.vinculoHash, vinc)) return voltar(res, retorno, 'google_erro=sessao');
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!code || code.length > 2048) return voltar(res, retorno, 'google_erro=falha');

    let identidade;
    try {
      const idToken = await google.trocarCodigo({ code, codeVerifier: estado.codeVerifier, redirectUri: redirectUri(req) });
      identidade = await google.verificarIdToken(idToken, { nonce: estado.nonce });
    } catch (e) {
      await log('aviso', `Login Google recusado: ${e instanceof ErroGoogle ? e.codigo : 'erro_interno'}`);
      return voltar(res, retorno, 'google_erro=' + (e && e.codigo === 'email_nao_verificado' ? 'email' : 'falha'));
    } finally {
      try { await db.oauth.remove({ _id: estado._id }); } catch {}
    }

    try {
      let situacao, usuarioId = null, emailConta = null, mensagem = null;
      const vinculada = await db.identidades.findOne({ chave: 'google:' + identidade.sub });
      if (vinculada) {
        const usuario = await db.usuarios.findOne({ _id: vinculada.usuarioId });
        mensagem = await motivoBloqueio(usuario);
        situacao = mensagem ? 'bloqueado' : 'login';
        usuarioId = usuario ? usuario._id : null;
      } else {
        const existente = await db.usuarios.findOne({ email: identidade.email });
        if (existente && existente.role === 'super_admin') { situacao = 'bloqueado'; mensagem = 'Esta conta não pode usar o acesso com Google.'; }
        else if (existente) { situacao = 'vincular'; emailConta = existente.email; }
        else situacao = 'cadastro';
      }
      const codigo = gerarSegredo();
      const ttl = situacao === 'login' || situacao === 'bloqueado' ? RESULTADO_LOGIN_TTL_MS : TTL_PENDENTE;
      await db.oauth.insert({
        tipo: 'resultado', provedor: 'google', codigoHash: hash(codigo), vinculoHash: estado.vinculoHash,
        situacao, identidade, usuarioId, emailConta, mensagem, plano: estado.plano, tentativas: 0,
        criadoEm: agoraIso(), expiraEm: new Date(Date.now() + ttl).toISOString(), usadoEm: null
      });
      voltar(res, retorno, 'google=' + codigo);
    } catch (e) {
      voltar(res, retorno, 'google_erro=falha');
    }
  });

  // 3. Resultado
  router.post('/resultado', async (req, res) => {
    try {
      const r = await resultadoDoNavegador(req, req.body && req.body.codigo);
      if (!r) return res.status(400).json(ERRO_EXPIRADO);
      if (r.situacao === 'login') {
        if (!(await consumir(r))) return res.status(400).json(ERRO_EXPIRADO);
        const usuario = await db.usuarios.findOne({ _id: r.usuarioId });
        const motivo = await motivoBloqueio(usuario);
        if (motivo) { limparCookie(req, res); return res.status(403).json({ erro: motivo }); }
        await db.identidades.update({ chave: 'google:' + r.identidade.sub }, { $set: { ultimoUsoEm: agoraIso() } });
        await log('auth', `Login com Google (${usuario.role})`, null, usuario.imobiliariaId || null);
        limparCookie(req, res);
        return res.json({ situacao: 'login', plano: r.plano, ...(await emitirSessaoUsuario(usuario)) });
      }
      if (r.situacao === 'bloqueado') {
        await consumir(r); limparCookie(req, res);
        return res.status(403).json({ erro: r.mensagem || 'Acesso indisponível.' });
      }
      return res.json({ situacao: r.situacao, plano: r.plano, emailGoogle: r.identidade.email, nome: r.identidade.nome,
        email: r.situacao === 'vincular' ? r.emailConta : r.identidade.email });
    } catch (e) { res.status(500).json({ erro: 'Erro interno.' }); }
  });

  // 4. Vincular a uma conta AGEMOB existente (comprovação: senha da conta).
  router.post('/vincular', async (req, res) => {
    try {
      const corpo = req.body || {};
      const r = await resultadoDoNavegador(req, corpo.codigo, ['vincular', 'cadastro']);
      if (!r) return res.status(400).json(ERRO_EXPIRADO);
      if (!(await contarTentativa(r))) return res.status(429).json({ erro: 'Muitas tentativas. Comece novamente pelo botão do Google.', codigo: 'tentativas' });
      const informado = typeof corpo.email === 'string' ? corpo.email.toLowerCase().trim() : '';
      const alvo = informado || (r.situacao === 'vincular' ? r.emailConta : '');
      if (!alvo || typeof corpo.senha !== 'string' || !corpo.senha) return res.status(422).json({ erro: 'Informe o e-mail e a senha da sua conta AGEMOB.' });
      const usuario = await db.usuarios.findOne({ email: alvo, ativo: true });
      // Super Admin nunca usa login social: mesma resposta de credencial inválida
      // (não revela se a senha estava certa). Sem conta/senha: compara com hash
      // fictício para manter o tempo de resposta.
      const elegivel = !!(usuario && usuario.role !== 'super_admin' && typeof usuario.senha === 'string' && usuario.senha);
      const senhaOk = await bcrypt.compare(corpo.senha, elegivel ? usuario.senha : HASH_FICTICIO);
      if (!elegivel || !senhaOk) return res.status(401).json({ erro: 'E-mail ou senha incorretos.' });
      const motivo = await motivoBloqueio(usuario);
      if (motivo) return res.status(403).json({ erro: motivo });
      if (await db.identidades.findOne({ provedor: 'google', usuarioId: usuario._id })) {
        return res.status(409).json({ erro: 'Esta conta AGEMOB já está conectada a outra conta Google.' });
      }
      try {
        await db.identidades.insert({ chave: 'google:' + r.identidade.sub, usuarioProvedor: 'google:' + usuario._id, provedor: 'google', sub: r.identidade.sub, usuarioId: usuario._id,
          imobiliariaId: usuario.imobiliariaId || null, emailNoVinculo: r.identidade.email, criadoEm: agoraIso(), ultimoUsoEm: agoraIso() });
      } catch (e) {
        return res.status(409).json({ erro: 'Esta conta Google já está conectada a uma conta AGEMOB.' });
      }
      await consumir(r);
      await log('auth', 'Conta Google vinculada após confirmação de senha', null, usuario.imobiliariaId || null);
      limparCookie(req, res);
      res.json({ ok: true, situacao: 'login', plano: r.plano, ...(await emitirSessaoUsuario(usuario)) });
    } catch (e) { res.status(500).json({ erro: 'Erro interno.' }); }
  });

  // 5. Conta nova (trial) com a identidade Google — mesmas regras do /api/cadastro, sem e-mail e senha.
  router.post('/cadastro', async (req, res) => {
    try {
      const corpo = req.body || {};
      const r = await resultadoDoNavegador(req, corpo.codigo, ['cadastro']);
      if (!r) return res.status(400).json(ERRO_EXPIRADO);
      if (!(await contarTentativa(r))) return res.status(429).json({ erro: 'Muitas tentativas. Comece novamente pelo botão do Google.', codigo: 'tentativas' });
      const tipo = corpo.tipoCliente === 'corretor' ? 'corretor' : 'imobiliaria';
      const txt = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';
      const nome = txt(corpo.nome, 120), cpf = txt(corpo.cpf, 20), cnpj = txt(corpo.cnpj, 20), creci = txt(corpo.creci, 20), telefone = txt(corpo.telefone, 20);
      const responsavel = tipo === 'corretor' ? nome : txt(corpo.responsavel, 120);
      if (!nome || !responsavel) return res.status(422).json({ erro: 'Preencha todos os campos obrigatorios.' });
      if (tipo === 'imobiliaria' && !cnpj) return res.status(422).json({ erro: 'CNPJ obrigatório para imobiliárias.' });
      if (tipo === 'corretor' && !cpf) return res.status(422).json({ erro: 'CPF obrigatório para corretores autônomos.' });
      const email = r.identidade.email; // verificado pelo Google
      const saida = await comTravaEmail(email, async () => {
      if (await db.usuarios.findOne({ email })) return { status: 409, corpo: { erro: 'Este e-mail já tem uma conta no AGEMOB. Entre com a senha para conectar o Google.', codigo: 'email_existente' } };
      if (await db.identidades.findOne({ chave: 'google:' + r.identidade.sub })) return { status: 409, corpo: { erro: 'Esta conta Google já está conectada a uma conta AGEMOB.' } };
      if (!(await consumir(r))) return { status: 400, corpo: ERRO_EXPIRADO };

      const criada = await criarContaTrial({ tipo, nome, cnpj: tipo === 'imobiliaria' ? cnpj : '', cpf: tipo === 'corretor' ? cpf : '',
        creci: tipo === 'imobiliaria' ? creci : '', responsavel, email, telefone, whatsapp: telefone, senhaHash: null, origem: 'landing_google' });
      if (!criada) return { status: 503, corpo: { erro: 'Cadastro temporariamente indisponível. Tente novamente mais tarde.' } };
      try {
        await db.identidades.insert({ chave: 'google:' + r.identidade.sub, usuarioProvedor: 'google:' + criada.usuario._id, provedor: 'google', sub: r.identidade.sub, usuarioId: criada.usuario._id,
          imobiliariaId: criada.imobId, emailNoVinculo: email, criadoEm: agoraIso(), ultimoUsoEm: agoraIso() });
      } catch (e) {
        await desfazerContaCriada(criada.imobId);
        return { status: 409, corpo: { erro: 'Esta conta Google já está conectada a uma conta AGEMOB.' } };
      }
      return { criada };
      });
      if (!saida.criada) return res.status(saida.status).json(saida.corpo);
      const criada = saida.criada;
      await log('cadastro', `Novo cliente via landing com Google (${tipo}): ${nome} — trial`);
      limparCookie(req, res);
      const sessao = await emitirSessaoUsuario(criada.usuario);
      res.json({ ok: true, situacao: 'cadastro', plano: r.plano, ...sessao,
        imobiliaria: { nome, slug: criada.slug, plano: criada.planoTrial.nome, limite: criada.acesso.trial.limite, trialExpiracao: criada.acesso.trial.expiraEm } });
      enviarBoasVindas({ email, responsavel, nomeConta: nome, tipo, imobiliariaId: criada.imobId, baseUrl: getBaseUrl(req) });
    } catch (e) { res.status(500).json({ erro: 'Falha ao criar conta. Tente novamente.' }); }
  });

  // Limpeza periódica de estados e resultados expirados.
  async function limparExpirados() {
    try { await db.oauth.remove({ expiraEm: { $lt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } }, { multi: true }); } catch {}
  }
  return { router, limparExpirados };
};
