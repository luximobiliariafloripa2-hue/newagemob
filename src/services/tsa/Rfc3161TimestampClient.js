// Cliente genérico de carimbo de tempo RFC 3161 (Marco 5 — TSA).
// Independente de fornecedor: URL, cadeia confiável, Basic Auth e política
// vêm só de variáveis de ambiente. Nenhuma função aqui toca o disco do Dossiê
// nem o banco; o único efeito externo é o POST para a TSA configurada.
//
// LIMITAÇÃO CONHECIDA (AGEMOB 1.0): revogação (CRL/OCSP) do certificado da
// TSA e da sua cadeia NÃO é consultada. Só são usadas CRLs/OCSPs que vierem
// embutidas no próprio token; sem elas a cadeia é validada sem revogação.
// carimboTempo.revogacaoVerificada = false registra essa limitação.

const crypto = require('crypto');
const fs = require('fs');
const asn1js = require('asn1js');
const pkijs = require('pkijs');

// Motor criptográfico local (WebCrypto do Node), passado explicitamente às
// verificações para não depender do motor global do pkijs.
const motorCripto = new pkijs.CryptoEngine({ name: 'agemob-tsa', crypto: crypto.webcrypto });

const OID_SHA1 = '1.3.14.3.2.26';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';
const OID_SHA512 = '2.16.840.1.101.3.4.2.3';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_CT_TSTINFO = '1.2.840.113549.1.9.16.1.4';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_KP_TIMESTAMPING = '1.3.6.1.5.5.7.3.8';
const OID_ESS_CERT_ID = '1.2.840.113549.1.9.16.2.12';
const OID_ESS_CERT_ID_V2 = '1.2.840.113549.1.9.16.2.47';

const HASH_NODE_POR_OID = {
  [OID_SHA1]: 'sha1',
  [OID_SHA256]: 'sha256',
  [OID_SHA384]: 'sha384',
  [OID_SHA512]: 'sha512'
};

const NOMES_ATRIBUTO_DN = {
  '2.5.4.3': 'CN',
  '2.5.4.5': 'serialNumber',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU'
};

const PEM_INICIO = '-----BEGIN CERTIFICATE-----';
const PEM_FIM = '-----END CERTIFICATE-----';

const TIMEOUT_PADRAO_MS = 10000;
const TIMEOUT_MAXIMO_MS = 120000;
const TAMANHO_MAXIMO_RESPOSTA = 1024 * 1024;
const PKI_STATUS_GRANTED = 0;
const PKI_STATUS_GRANTED_WITH_MODS = 1;

// Erro de configuração: a mensagem é sempre um código fixo, nunca o valor
// recebido (que pode conter credencial ou caminho sensível).
class ErroConfiguracaoTsa extends Error {
  constructor(codigo) {
    super(codigo);
    this.codigo = codigo;
  }
}

// Falha operacional ou de validação de um carimbo. status e motivo são
// códigos fixos e são os únicos valores persistidos em carimboTempo.
class FalhaTsa extends Error {
  constructor(status, motivo) {
    super(motivo);
    this.status = status;
    this.motivo = motivo;
  }
}

function falhaValidacao(motivo) {
  throw new FalhaTsa('falha_validacao', motivo);
}

function paraArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex');
}

function lerCertificadosPem(conteudo) {
  const certificados = [];
  let posicao = conteudo.indexOf(PEM_INICIO);
  while (posicao !== -1) {
    const fim = conteudo.indexOf(PEM_FIM, posicao);
    if (fim === -1) throw new Error('pem_incompleto');
    const base64 = conteudo.slice(posicao + PEM_INICIO.length, fim).replace(/\s+/g, '');
    const der = Buffer.from(base64, 'base64');
    certificados.push(pkijs.Certificate.fromBER(paraArrayBuffer(der)));
    posicao = conteudo.indexOf(PEM_INICIO, fim + PEM_FIM.length);
  }
  return certificados;
}

// Lê e valida a configuração TSA. Retorna null quando nenhuma variável TSA
// foi definida (TSA não configurado) e lança ErroConfiguracaoTsa quando a
// configuração está incompleta ou inválida. TSA_URL e TSA_TRUSTED_ROOTS são
// obrigatórias juntas; Basic Auth só quando usuário e senha vierem em par.
function carregarConfiguracaoTsa(env) {
  const url = (env.TSA_URL || '').trim();
  const caminhoRaizes = (env.TSA_TRUSTED_ROOTS || '').trim();
  const usuario = env.TSA_USERNAME || '';
  const senha = env.TSA_PASSWORD || '';
  const politicaOid = (env.TSA_POLICY_OID || '').trim();
  const timeoutTexto = (env.TSA_TIMEOUT_MS || '').trim();

  if (!url && !caminhoRaizes && !usuario && !senha && !politicaOid && !timeoutTexto) {
    return null;
  }
  if (!url) throw new ErroConfiguracaoTsa('TSA_URL_ausente');
  if (!caminhoRaizes) throw new ErroConfiguracaoTsa('TSA_TRUSTED_ROOTS_ausente');

  let urlAnalisada;
  try {
    urlAnalisada = new URL(url);
  } catch {
    throw new ErroConfiguracaoTsa('TSA_URL_invalida');
  }
  if (urlAnalisada.protocol !== 'https:' && urlAnalisada.protocol !== 'http:') {
    throw new ErroConfiguracaoTsa('TSA_URL_protocolo_invalido');
  }
  // Credenciais só por TSA_USERNAME/TSA_PASSWORD, nunca embutidas na URL.
  if (urlAnalisada.username || urlAnalisada.password) {
    throw new ErroConfiguracaoTsa('TSA_URL_com_credenciais');
  }

  if (Boolean(usuario) !== Boolean(senha)) {
    throw new ErroConfiguracaoTsa('TSA_USERNAME_PASSWORD_incompletos');
  }
  if (usuario.includes(':')) {
    throw new ErroConfiguracaoTsa('TSA_USERNAME_invalido');
  }

  if (politicaOid && !/^[0-2](\.(0|[1-9]\d*))+$/.test(politicaOid)) {
    throw new ErroConfiguracaoTsa('TSA_POLICY_OID_invalido');
  }

  let timeoutMs = TIMEOUT_PADRAO_MS;
  if (timeoutTexto) {
    if (!/^\d+$/.test(timeoutTexto)) throw new ErroConfiguracaoTsa('TSA_TIMEOUT_MS_invalido');
    timeoutMs = Number(timeoutTexto);
    if (timeoutMs < 1 || timeoutMs > TIMEOUT_MAXIMO_MS) {
      throw new ErroConfiguracaoTsa('TSA_TIMEOUT_MS_invalido');
    }
  }

  let raizes;
  try {
    raizes = lerCertificadosPem(fs.readFileSync(caminhoRaizes, 'utf8'));
  } catch {
    throw new ErroConfiguracaoTsa('TSA_TRUSTED_ROOTS_ilegivel');
  }
  if (raizes.length === 0) throw new ErroConfiguracaoTsa('TSA_TRUSTED_ROOTS_vazio');

  return Object.freeze({
    url: urlAnalisada.href,
    // Identificação persistível da TSA: sem query string (pode carregar token).
    urlPublica: urlAnalisada.origin + urlAnalisada.pathname,
    autorizacao: usuario
      ? 'Basic ' + Buffer.from(usuario + ':' + senha, 'utf8').toString('base64')
      : null,
    politicaOid: politicaOid || null,
    timeoutMs,
    raizes: Object.freeze(raizes)
  });
}

// Nonce de 128 bits via crypto.randomBytes. O primeiro byte fica em
// 0x01..0x7f para o INTEGER DER ser positivo e mínimo, de modo que os bytes
// ecoados pela TSA sejam comparáveis byte a byte.
function gerarNonce() {
  const nonce = crypto.randomBytes(16);
  nonce[0] = (nonce[0] & 0x7f) || 0x01;
  return nonce;
}

// Monta o TimeStampReq (RFC 3161, v1) em DER: SHA-256, nonce, certReq=true
// (certificado da TSA embutido no token) e política opcional.
function montarRequisicaoTsa(digest, nonce, politicaOid) {
  const parametros = {
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null()
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: paraArrayBuffer(digest) })
    }),
    nonce: new asn1js.Integer({ valueHex: paraArrayBuffer(nonce) }),
    certReq: true
  };
  if (politicaOid) parametros.reqPolicy = politicaOid;
  return Buffer.from(new pkijs.TimeStampReq(parametros).toSchema().toBER());
}

async function lerCorpoLimitado(resposta) {
  const declarado = Number(resposta.headers.get('content-length'));
  if (declarado > TAMANHO_MAXIMO_RESPOSTA) {
    throw new FalhaTsa('indisponivel', 'resposta_grande_demais');
  }
  if (!resposta.body) return Buffer.alloc(0);
  const partes = [];
  let total = 0;
  for await (const parte of resposta.body) {
    total += parte.byteLength;
    if (total > TAMANHO_MAXIMO_RESPOSTA) {
      throw new FalhaTsa('indisponivel', 'resposta_grande_demais');
    }
    partes.push(Buffer.from(parte));
  }
  return Buffer.concat(partes);
}

// POST da requisição. O timeout cobre conexão e leitura do corpo; redirect
// é recusado para a credencial nunca seguir para outro host. TLS usa sempre
// a validação padrão do Node.
async function enviarRequisicaoTsa(requisicaoDer, config) {
  const cabecalhos = {
    'Content-Type': 'application/timestamp-query',
    'Accept': 'application/timestamp-reply'
  };
  if (config.autorizacao) cabecalhos.Authorization = config.autorizacao;

  try {
    const resposta = await fetch(config.url, {
      method: 'POST',
      headers: cabecalhos,
      body: requisicaoDer,
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs)
    });
    if (resposta.status !== 200) {
      throw new FalhaTsa('indisponivel', 'http_' + resposta.status);
    }
    const tipo = (resposta.headers.get('content-type') || '').toLowerCase();
    if (!tipo.startsWith('application/timestamp-reply')) {
      throw new FalhaTsa('falha_validacao', 'content_type_invalido');
    }
    return await lerCorpoLimitado(resposta);
  } catch (e) {
    if (e instanceof FalhaTsa) throw e;
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new FalhaTsa('indisponivel', 'timeout');
    }
    throw new FalhaTsa('indisponivel', 'erro_rede');
  }
}

function nomeDistinto(nome) {
  return nome.typesAndValues
    .map((atributo) => {
      const rotulo = NOMES_ATRIBUTO_DN[atributo.type] || atributo.type;
      return rotulo + '=' + atributo.value.valueBlock.value;
    })
    .join(', ');
}

// DER original (não re-codificado) do certificado do signatário, localizado
// no campo certificates [0] do SignedData pelo TBS já decodificado.
function derOriginalDoCertificado(signedDataSchema, certificado) {
  const campoCertificados = signedDataSchema.valueBlock.value.find(
    (bloco) => bloco.idBlock.tagClass === 3 && bloco.idBlock.tagNumber === 0
  );
  const blocos = campoCertificados ? campoCertificados.valueBlock.value : [];
  const tbsSignatario = Buffer.from(certificado.tbsView);
  for (const bloco of blocos) {
    const tbs = Array.isArray(bloco.valueBlock.value) ? bloco.valueBlock.value[0] : null;
    if (tbs && Buffer.from(tbs.valueBeforeDecodeView).equals(tbsSignatario)) {
      return Buffer.from(bloco.valueBeforeDecodeView);
    }
  }
  return null;
}

// RFC 3161 §2.3: o certificado da TSA deve ter uma única extensão
// ExtendedKeyUsage, crítica, contendo somente id-kp-timeStamping.
function validarEkuTimestamping(certificado) {
  const extensoes = (certificado.extensions || []).filter(
    (extensao) => extensao.extnID === OID_EXT_KEY_USAGE
  );
  if (extensoes.length !== 1) falhaValidacao('eku_ausente');
  if (extensoes[0].critical !== true) falhaValidacao('eku_nao_critico');
  const valor = extensoes[0].parsedValue;
  const propositos = valor && Array.isArray(valor.keyPurposes) ? valor.keyPurposes : [];
  if (propositos.length !== 1 || propositos[0] !== OID_KP_TIMESTAMPING) {
    falhaValidacao('eku_invalido');
  }
}

// signingCertificate (ESSCertID, RFC 2634) ou signingCertificateV2
// (ESSCertIDv2, RFC 5035/5816): o primeiro certHash deve ser o hash do DER
// do certificado que de fato assinou o token. V2 tem precedência.
function validarEssCertId(signerInfo, certificadoDer) {
  const atributos = signerInfo.signedAttrs ? signerInfo.signedAttrs.attributes : [];
  const v2 = atributos.find((atributo) => atributo.type === OID_ESS_CERT_ID_V2);
  const v1 = atributos.find((atributo) => atributo.type === OID_ESS_CERT_ID);
  const atributo = v2 || v1;
  if (!atributo) falhaValidacao('ess_cert_id_ausente');

  let algoritmoOid = v2 ? OID_SHA256 : OID_SHA1;
  let hashDeclarado = null;
  try {
    const signingCertificate = atributo.values[0];
    const listaCerts = signingCertificate.valueBlock.value[0];
    const campos = listaCerts.valueBlock.value[0].valueBlock.value;
    let indice = 0;
    if (v2 && campos[0] instanceof asn1js.Sequence) {
      algoritmoOid = new pkijs.AlgorithmIdentifier({ schema: campos[0] }).algorithmId;
      indice = 1;
    }
    if (!(campos[indice] instanceof asn1js.OctetString)) throw new Error('cert_hash');
    hashDeclarado = Buffer.from(campos[indice].valueBlock.valueHexView);
  } catch {
    falhaValidacao('ess_cert_id_malformado');
  }

  const algoritmoNode = HASH_NODE_POR_OID[algoritmoOid];
  if (!algoritmoNode) falhaValidacao('ess_cert_id_algoritmo_nao_suportado');
  const hashReal = crypto.createHash(algoritmoNode).update(certificadoDer).digest();
  if (!hashReal.equals(hashDeclarado)) falhaValidacao('ess_cert_id_divergente');
}

function codigoErroVerificacaoCms(erro) {
  switch (erro && erro.code) {
    case 2: return 'certificados_ausentes';
    case 3: return 'certificado_signatario_ausente';
    case 5: return 'cadeia_invalida';
    case 7: return 'algoritmo_nao_suportado';
    case 9:
    case 10: return 'atributos_assinados_ausentes';
    default: return 'assinatura_cms_invalida';
  }
}

// Validação integral do TimeStampResp. Qualquer divergência lança FalhaTsa
// com status 'falha_validacao'; nunca devolve resultado parcial.
async function validarRespostaTsa(respostaDer, esperado) {
  const asn1 = asn1js.fromBER(paraArrayBuffer(respostaDer));
  if (asn1.offset === -1 || asn1.offset !== respostaDer.byteLength) {
    falhaValidacao('resposta_malformada');
  }

  let resposta = null;
  try {
    resposta = new pkijs.TimeStampResp({ schema: asn1.result });
  } catch {
    falhaValidacao('resposta_malformada');
  }

  // Somente granted (0). grantedWithMods (1) e demais status são recusados.
  if (resposta.status.status !== PKI_STATUS_GRANTED) {
    falhaValidacao(
      resposta.status.status === PKI_STATUS_GRANTED_WITH_MODS
        ? 'status_granted_with_mods'
        : 'status_recusado'
    );
  }

  const resultado = await validarTokenTsa(resposta.timeStampToken, esperado);
  return {
    ...resultado,
    // TimeStampToken (ContentInfo) exatamente como recebido, sem re-codificar.
    token: Buffer.from(asn1.result.valueBlock.value[1].valueBeforeDecodeView)
  };
}

// Validação do TimeStampToken (ContentInfo -> SignedData -> TSTInfo), comum
// à resposta online e ao token já gravado. Qualquer divergência lança
// FalhaTsa com status 'falha_validacao'.
async function validarTokenTsa(contentInfo, esperado) {
  if (!contentInfo || contentInfo.contentType !== OID_SIGNED_DATA) {
    falhaValidacao('token_ausente');
  }

  let signedData = null;
  let tstInfo = null;
  try {
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
    const encap = signedData.encapContentInfo;
    if (encap.eContentType !== OID_CT_TSTINFO || !encap.eContent) throw new Error('econtent');
    tstInfo = pkijs.TSTInfo.fromBER(encap.eContent.valueBlock.valueHexView);
  } catch {
    falhaValidacao('token_malformado');
  }
  if (signedData.signerInfos.length !== 1) falhaValidacao('token_signatarios_invalidos');

  if (tstInfo.version !== 1) falhaValidacao('tstinfo_versao_invalida');
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
    falhaValidacao('algoritmo_hash_divergente');
  }
  const digestRecebido = Buffer.from(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (!digestRecebido.equals(esperado.digest)) falhaValidacao('message_imprint_divergente');

  if (!tstInfo.nonce) falhaValidacao('nonce_ausente');
  const nonceRecebido = Buffer.from(tstInfo.nonce.valueBlock.valueHexView);
  if (!nonceRecebido.equals(esperado.nonce)) falhaValidacao('nonce_divergente');

  if (!(tstInfo.genTime instanceof Date) || Number.isNaN(tstInfo.genTime.getTime())) {
    falhaValidacao('gentime_invalido');
  }
  const serial = Buffer.from(tstInfo.serialNumber.valueBlock.valueHexView);
  if (serial.length === 0) falhaValidacao('serial_ausente');

  if (esperado.politicaOid && tstInfo.policy !== esperado.politicaOid) {
    falhaValidacao('politica_divergente');
  }

  // Assinatura CMS, atributo messageDigest e cadeia do signatário até
  // TSA_TRUSTED_ROOTS na data genTime. As âncoras vêm só da configuração;
  // certificados embutidos no token servem apenas como intermediários.
  let verificacao = null;
  try {
    verificacao = await signedData.verify({
      signer: 0,
      data: paraArrayBuffer(esperado.representacao),
      trustedCerts: [...esperado.raizes],
      checkChain: true,
      extendedMode: true
    }, motorCripto);
  } catch (e) {
    falhaValidacao(codigoErroVerificacaoCms(e));
  }
  if (!verificacao || verificacao.signatureVerified !== true) {
    falhaValidacao('assinatura_cms_invalida');
  }

  const certificado = verificacao.signerCertificate;
  validarEkuTimestamping(certificado);
  const certificadoDer = derOriginalDoCertificado(contentInfo.content, certificado);
  if (!certificadoDer) falhaValidacao('certificado_signatario_ausente');
  validarEssCertId(signedData.signerInfos[0], certificadoDer);

  return {
    genTime: tstInfo.genTime.toISOString(),
    serial: hex(serial),
    politica: tstInfo.policy,
    certificado: {
      subject: nomeDistinto(certificado.subject),
      issuer: nomeDistinto(certificado.issuer),
      serial: hex(certificado.serialNumber.valueBlock.valueHexView),
      sha256: crypto.createHash('sha256').update(certificadoDer).digest('hex')
    }
  };
}

// Verificação offline de um carimbo já gravado em hashes.json: as mesmas
// validações do carimbo online (assinatura CMS, cadeia até as raízes na data
// genTime, EKU, ESSCertID, messageImprint, nonce e política gravados), sem
// rede. Nunca lança; sem raízes configuradas o resultado é 'nao_verificavel'.
async function verificarTokenArmazenado(carimboTempo, { representacao, digest }, raizes) {
  if (!raizes || raizes.length === 0) {
    return { situacao: 'nao_verificavel', motivo: 'tsa_raizes_nao_configuradas' };
  }
  try {
    const { token, nonce, politica, genTime, serial } = carimboTempo;
    if (typeof token !== 'string' || typeof politica !== 'string' ||
        typeof nonce !== 'string' || !/^([0-9a-f]{2})+$/.test(nonce)) {
      falhaValidacao('carimbo_incompleto');
    }
    const tokenDer = Buffer.from(token, 'base64');
    if (tokenDer.toString('base64') !== token) falhaValidacao('token_malformado');
    const asn1Token = asn1js.fromBER(paraArrayBuffer(tokenDer));
    if (asn1Token.offset === -1 || asn1Token.offset !== tokenDer.byteLength) {
      falhaValidacao('token_malformado');
    }
    let contentInfo = null;
    try {
      contentInfo = new pkijs.ContentInfo({ schema: asn1Token.result });
    } catch {
      falhaValidacao('token_malformado');
    }
    const resultado = await validarTokenTsa(contentInfo, {
      representacao,
      digest,
      nonce: Buffer.from(nonce, 'hex'),
      politicaOid: politica,
      raizes
    });
    if (resultado.genTime !== genTime || resultado.serial !== serial) {
      falhaValidacao('metadados_divergentes');
    }
    return { situacao: 'valido', genTime: resultado.genTime };
  } catch (e) {
    return { situacao: 'invalido', motivo: e instanceof FalhaTsa ? e.motivo : 'erro_interno' };
  }
}

// Solicita e valida um carimbo sobre `representacao` (bytes canônicos), cujo
// SHA-256 é `digest`. Nunca lança: devolve sempre o objeto carimboTempo,
// válido ou com status de falha e motivo em código fixo. Uma única
// tentativa, sem retry; latência limitada a config.timeoutMs.
async function solicitarCarimboTempo({ representacao, digest }, config) {
  const base = {
    padrao: 'RFC3161',
    algoritmoHash: 'SHA-256',
    hashCarimbado: digest.toString('hex')
  };

  if (!config) {
    return {
      ...base,
      status: 'nao_configurado',
      motivo: 'tsa_nao_configurado',
      tentadoEm: null,
      token: null
    };
  }

  const tentadoEm = new Date().toISOString();
  try {
    const digestConferido = crypto.createHash('sha256').update(representacao).digest();
    if (!digestConferido.equals(digest)) falhaValidacao('digest_inconsistente');

    const nonce = gerarNonce();
    const requisicao = montarRequisicaoTsa(digest, nonce, config.politicaOid);
    const respostaDer = await enviarRequisicaoTsa(requisicao, config);
    const resultado = await validarRespostaTsa(respostaDer, {
      representacao,
      digest,
      nonce,
      politicaOid: config.politicaOid,
      raizes: config.raizes
    });

    return {
      ...base,
      status: 'valido',
      nonce: nonce.toString('hex'),
      genTime: resultado.genTime,
      serial: resultado.serial,
      politica: resultado.politica,
      tsa: { url: config.urlPublica, certificado: resultado.certificado },
      token: resultado.token.toString('base64'),
      encoding: 'base64',
      validadoEm: new Date().toISOString(),
      revogacaoVerificada: false
    };
  } catch (e) {
    const falha = e instanceof FalhaTsa ? e : new FalhaTsa('falha_validacao', 'erro_interno');
    return {
      ...base,
      status: falha.status,
      motivo: falha.motivo,
      tentadoEm,
      token: null
    };
  }
}

module.exports = {
  carregarConfiguracaoTsa,
  solicitarCarimboTempo,
  verificarTokenArmazenado,
  ErroConfiguracaoTsa
};
