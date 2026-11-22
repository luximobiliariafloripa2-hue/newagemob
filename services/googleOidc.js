'use strict';
// Login com Google (M11 Fase B) — OpenID Connect, Authorization Code Flow com
// PKCE (S256), state e nonce. Sem dependências: JWKS e RS256 verificados com o
// crypto nativo do Node (createPublicKey em formato JWK + verify RSA-SHA256).
//
// Do Google só sai daqui a identidade verificada { sub, email, nome }. O
// access_token e o refresh_token da resposta são descartados e nunca gravados.

const crypto = require('crypto');

const OFICIAL = {
  authUrl:  'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl:  'https://www.googleapis.com/oauth2/v3/certs',
  issuers:  ['https://accounts.google.com', 'accounts.google.com']
};
const ESCOPO = 'openid email profile';
const TOLERANCIA_RELOGIO_S = 60;
const TIMEOUT_MS = 10000;
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_INTERVALO_MIN_MS = 30 * 1000; // recarga por "kid" desconhecido, no máximo 1x a cada 30s

class ErroGoogle extends Error {
  constructor(codigo) { super(codigo); this.codigo = codigo; }
}

// AUTH_GOOGLE_ATIVO: só "true" ativa; vazio/ausente/"false" desativa; outro valor é erro.
// Ativo exige GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET; sem eles o recurso fica
// desativado (aviso), nunca simulado. GOOGLE_OIDC_TEST_URL existe só para o
// provedor falso dos testes automatizados e impede o startup em produção.
function carregarConfiguracao(env = process.env) {
  const flag = (env.AUTH_GOOGLE_ATIVO || '').trim();
  if (flag !== '' && flag !== 'true' && flag !== 'false') throw new ErroGoogle('AUTH_GOOGLE_ATIVO_invalido');
  const producao = env.NODE_ENV === 'production';
  const urlTeste = (env.GOOGLE_OIDC_TEST_URL || '').trim();
  if (producao && urlTeste) throw new ErroGoogle('GOOGLE_OIDC_TEST_URL_proibida_em_producao');
  const clientId = (env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET || '').trim();
  if (flag !== 'true') return { ativo: false, motivo: 'desativado' };
  if (!clientId || !clientSecret) return { ativo: false, motivo: 'credenciais_ausentes' };
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(clientId)) throw new ErroGoogle('GOOGLE_CLIENT_ID_invalido');
  let endpoints = OFICIAL;
  if (urlTeste) {
    let u;
    try { u = new URL(urlTeste); } catch { throw new ErroGoogle('GOOGLE_OIDC_TEST_URL_invalida'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ErroGoogle('GOOGLE_OIDC_TEST_URL_invalida');
    const base = urlTeste.replace(/\/+$/, '');
    endpoints = { authUrl: base + '/auth', tokenUrl: base + '/token', jwksUrl: base + '/certs', issuers: [base] };
  }
  return { ativo: true, clientId, clientSecret, ...endpoints, teste: !!urlTeste };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
function gerarSegredo(bytes = 32) { return b64url(crypto.randomBytes(bytes)); }
function hash(valor) { return crypto.createHash('sha256').update(String(valor)).digest('hex'); }
function desafioPkce(verifier) { return b64url(crypto.createHash('sha256').update(verifier).digest()); }

function criarGoogleOidc(config, opcoes = {}) {
  const buscar = opcoes.fetch || fetch;
  const agora = opcoes.agora || (() => Date.now());
  let jwks = { chaves: new Map(), carregadoEm: 0 };
  let ultimaRecarga = 0;

  function urlAutorizacao({ state, nonce, codeVerifier, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', scope: ESCOPO,
      state, nonce, code_challenge: desafioPkce(codeVerifier), code_challenge_method: 'S256', prompt: 'select_account'
    });
    return config.authUrl + '?' + p.toString();
  }

  async function trocarCodigo({ code, codeVerifier, redirectUri }) {
    let r;
    try {
      r = await buscar(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri, client_id: config.clientId, client_secret: config.clientSecret }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch { throw new ErroGoogle('token_indisponivel'); }
    let corpo = null;
    try { corpo = await r.json(); } catch {}
    if (!r.ok || !corpo || typeof corpo.id_token !== 'string') throw new ErroGoogle('token_recusado');
    return corpo.id_token; // access_token/refresh_token descartados
  }

  async function carregarJwks(forcar) {
    const t = agora();
    if (!forcar && jwks.chaves.size && t - jwks.carregadoEm < JWKS_TTL_MS) return;
    if (forcar && t - ultimaRecarga < JWKS_INTERVALO_MIN_MS) return;
    ultimaRecarga = t;
    let corpo;
    try {
      const r = await buscar(config.jwksUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!r.ok) throw new Error();
      corpo = await r.json();
    } catch { if (!jwks.chaves.size) throw new ErroGoogle('jwks_indisponivel'); return; }
    const chaves = new Map();
    for (const k of Array.isArray(corpo && corpo.keys) ? corpo.keys : []) {
      if (!k || k.kty !== 'RSA' || typeof k.kid !== 'string' || (k.use && k.use !== 'sig') || (k.alg && k.alg !== 'RS256')) continue;
      try { chaves.set(k.kid, crypto.createPublicKey({ key: { kty: 'RSA', n: k.n, e: k.e }, format: 'jwk' })); } catch {}
    }
    if (chaves.size) jwks = { chaves, carregadoEm: t };
    else if (!jwks.chaves.size) throw new ErroGoogle('jwks_vazio');
  }

  // Valida assinatura (RS256 via JWKS), emissor, público (aud/azp), validade
  // (exp/iat), nonce e e-mail verificado. Qualquer falha → ErroGoogle.
  async function verificarIdToken(idToken, { nonce }) {
    const partes = typeof idToken === 'string' ? idToken.split('.') : [];
    if (partes.length !== 3) throw new ErroGoogle('id_token_malformado');
    let cab, dados;
    try {
      cab = JSON.parse(Buffer.from(partes[0], 'base64url').toString('utf8'));
      dados = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    } catch { throw new ErroGoogle('id_token_malformado'); }
    if (!cab || cab.alg !== 'RS256' || typeof cab.kid !== 'string') throw new ErroGoogle('id_token_algoritmo');
    await carregarJwks(false);
    if (!jwks.chaves.has(cab.kid)) await carregarJwks(true);
    const chave = jwks.chaves.get(cab.kid);
    if (!chave) throw new ErroGoogle('id_token_chave_desconhecida');
    const ok = crypto.verify('RSA-SHA256', Buffer.from(partes[0] + '.' + partes[1]), chave, Buffer.from(partes[2], 'base64url'));
    if (!ok) throw new ErroGoogle('id_token_assinatura');
    if (!dados || typeof dados !== 'object') throw new ErroGoogle('id_token_malformado');
    if (!config.issuers.includes(dados.iss)) throw new ErroGoogle('id_token_emissor');
    const aud = Array.isArray(dados.aud) ? dados.aud : [dados.aud];
    if (!aud.includes(config.clientId)) throw new ErroGoogle('id_token_publico');
    if ((aud.length > 1 || dados.azp !== undefined) && dados.azp !== config.clientId) throw new ErroGoogle('id_token_publico');
    const s = Math.floor(agora() / 1000);
    if (typeof dados.exp !== 'number' || dados.exp + TOLERANCIA_RELOGIO_S < s) throw new ErroGoogle('id_token_expirado');
    if (typeof dados.iat !== 'number' || dados.iat - TOLERANCIA_RELOGIO_S > s) throw new ErroGoogle('id_token_iat');
    if (typeof nonce !== 'string' || !nonce || dados.nonce !== nonce) throw new ErroGoogle('id_token_nonce');
    if (typeof dados.sub !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(dados.sub)) throw new ErroGoogle('id_token_sub');
    if (dados.email_verified !== true && dados.email_verified !== 'true') throw new ErroGoogle('email_nao_verificado');
    const email = typeof dados.email === 'string' ? dados.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ErroGoogle('email_invalido');
    const nome = typeof dados.name === 'string' ? dados.name.trim().slice(0, 120) : '';
    return { sub: dados.sub, email, nome };
  }

  return { urlAutorizacao, trocarCodigo, verificarIdToken };
}

module.exports = { carregarConfiguracao, criarGoogleOidc, gerarSegredo, hash, desafioPkce, ErroGoogle, ESCOPO };
