// src/services/evidence/EvidenceStorage.js
// Única camada autorizada a gravar fisicamente evidências em
// storage/tenants/{tenantId}/incoming/{codigo}/ (Micro-Sprint 2.3.5.0/2.3.5.2).
// Não integra ainda com a rota, o banco, nem com o Dossiê definitivo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MIME_WHITELIST, ALGORITMO_HASH } = require('./constants');
const { validarFormatoCodigo, validarFormatoTenantId } = require('./validators');

// Nome-base de arquivo (ex.: "documentos/up_rg") — restrito a categoria/nome já
// definidos pelo catálogo interno (EvidenceIngestionService), nunca aceitando
// ".." nem caminho absoluto.
const CAMINHO_BASE_VALIDO = /^[a-z0-9_]+\/[a-z0-9_]+$/;

const SHA256_HEX = /^[0-9a-f]{64}$/i;

function caminhoDentroDaBase(baseAbsoluta, alvoAbsoluto) {
  const base = path.resolve(baseAbsoluta);
  const alvo = path.resolve(alvoAbsoluto);
  return alvo === base || alvo.startsWith(base + path.sep);
}

// Escreve de forma atômica e write-once: tmp (criação exclusiva) -> fsync -> link
// exclusivo -> remove o tmp -> relê o definitivo -> confirma hash.
// fs.linkSync exige origem e destino no mesmo filesystem — condição garantida aqui
// porque o temporário e o definitivo ficam sempre sob o mesmo storageBase.
// fs.linkSync falha com EEXIST se o caminho final já existir — é isso que garante
// write-once sem depender de uma checagem isolada sujeita a corrida (TOCTOU).
function escreverArquivoAtomico(caminhoFinalAbsoluto, buffer) {
  fs.mkdirSync(path.dirname(caminhoFinalAbsoluto), { recursive: true });

  const hashPre = crypto.createHash('sha256').update(buffer).digest('hex');
  const caminhoTmp = `${caminhoFinalAbsoluto}.${crypto.randomBytes(8).toString('hex')}.tmp`;

  // 'wx': criação exclusiva do temporário — falha se já existir, nunca sobrescreve.
  // writeFileSync garante gravação integral do buffer (diferente de writeSync, que
  // pode retornar com escrita parcial em uma única chamada).
  // No Windows, remover um arquivo com descritor ainda aberto pode falhar — por
  // isso o fechamento acontece sempre primeiro (no finally), e só depois disso a
  // exclusão do .tmp é tentada, preservando o erro original de abertura/escrita/
  // fsync mesmo que o fechamento também falhe.
  let fd;
  let erroEscrita = null;
  try {
    fd = fs.openSync(caminhoTmp, 'wx');
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } catch (erro) {
    erroEscrita = erro;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (erroFechamento) {
        if (!erroEscrita) erroEscrita = erroFechamento;
      }
    }
  }

  if (erroEscrita) {
    try { fs.unlinkSync(caminhoTmp); } catch (_) { /* melhor esforço; erro original prevalece */ }
    throw erroEscrita;
  }

  try {
    fs.linkSync(caminhoTmp, caminhoFinalAbsoluto);
  } catch (e) {
    try { fs.unlinkSync(caminhoTmp); } catch (_) { /* melhor esforço; erro original prevalece */ }
    if (e.code === 'EEXIST') {
      throw new Error(`EvidenceStorage: destino já existe (write-once) — ${caminhoFinalAbsoluto}`);
    }
    throw e;
  }
  try { fs.unlinkSync(caminhoTmp); } catch (_) { /* nome temporário; falha aqui não compromete o definitivo */ }

  const releitura = fs.readFileSync(caminhoFinalAbsoluto);
  const hashPos = crypto.createHash('sha256').update(releitura).digest('hex');

  if (hashPre !== hashPos) {
    // O arquivo definitivo só existe porque esta própria chamada acabou de criá-lo —
    // mantê-lo corrompido seria pior que removê-lo. Isto não é "apagar um arquivo já
    // existente de outra gravação" (write-once já impede isso); é desfazer esta
    // escrita comprovadamente falha antes de propagar o erro.
    try { fs.unlinkSync(caminhoFinalAbsoluto); } catch (_) { /* melhor esforço */ }
    throw new Error(`EvidenceStorage: falha de integridade — hash divergente após releitura (${caminhoFinalAbsoluto}).`);
  }

  return { sha256: hashPos, tamanhoBytes: releitura.length };
}

// Assinatura estável e independente de ordem de um conjunto de arquivos — só
// para comparar "é o mesmo conjunto", nunca persistida em disco.
function assinaturaArquivos(lista) {
  return lista.map((a) => `${a.caminhoRelativo}:${a.sha256}`).sort().join('|');
}

// Valida o schema mínimo de um manifest.json já existente em disco antes de
// considerá-lo reaproveitável — nunca trata JSON corrompido, schema divergente
// ou código/tenant diferentes como um retry válido.
function manifestoExistenteValido(manifestoExistente, { codigo, tenantId }) {
  if (!manifestoExistente || typeof manifestoExistente !== 'object') return false;
  if (manifestoExistente.versao !== 1) return false;
  if (manifestoExistente.codigo !== codigo) return false;
  if (manifestoExistente.tenantId !== tenantId) return false;
  if (manifestoExistente.algoritmoHash !== ALGORITMO_HASH) return false;
  if (!Array.isArray(manifestoExistente.arquivos)) return false;

  const caminhosVistos = new Set();
  for (const arq of manifestoExistente.arquivos) {
    if (!arq || typeof arq.caminhoRelativo !== 'string' || arq.caminhoRelativo.length === 0) return false;
    if (typeof arq.sha256 !== 'string' || !SHA256_HEX.test(arq.sha256)) return false;
    if (caminhosVistos.has(arq.caminhoRelativo)) return false;
    caminhosVistos.add(arq.caminhoRelativo);
  }
  return true;
}

function createEvidenceStorage({ storageBase }) {
  if (typeof storageBase !== 'string' || !storageBase) {
    throw new Error('EvidenceStorage: storageBase é obrigatório.');
  }
  const storageBaseAbsoluta = path.resolve(storageBase);

  function resolverCaminhoIncoming(tenantId, codigo) {
    if (!validarFormatoTenantId(tenantId)) throw new Error(`EvidenceStorage: tenantId inválido: ${String(tenantId)}`);
    if (!validarFormatoCodigo(codigo)) throw new Error(`EvidenceStorage: codigo inválido: ${String(codigo)}`);

    const relativo = path.join('tenants', tenantId, 'incoming', codigo);
    const absoluto = path.join(storageBaseAbsoluta, relativo);

    if (!caminhoDentroDaBase(storageBaseAbsoluta, absoluto)) {
      throw new Error('EvidenceStorage: caminho resolvido fora da base de armazenamento.');
    }
    return { relativo: relativo.replace(/\\/g, '/'), absoluto };
  }

  function save({ tenantId, codigo, caminhoBase, buffer, mimeType }) {
    if (!Buffer.isBuffer(buffer)) throw new Error('EvidenceStorage.save: buffer inválido — esperado um Buffer.');
    if (!MIME_WHITELIST[mimeType]) throw new Error(`EvidenceStorage.save: MIME não permitido: ${mimeType}`);
    if (typeof caminhoBase !== 'string' || !CAMINHO_BASE_VALIDO.test(caminhoBase)) {
      throw new Error(`EvidenceStorage.save: caminhoBase inválido: ${String(caminhoBase)}`);
    }

    const { absoluto: raizIncoming } = resolverCaminhoIncoming(tenantId, codigo);
    const extensao = MIME_WHITELIST[mimeType].extensao;
    const caminhoRelativo = `${caminhoBase}.${extensao}`;
    const caminhoFinalAbsoluto = path.join(raizIncoming, caminhoRelativo);

    if (!caminhoDentroDaBase(raizIncoming, caminhoFinalAbsoluto)) {
      throw new Error('EvidenceStorage.save: caminho final fora da pasta de incoming da autorização.');
    }

    // Idempotência de conteúdo: uma nova tentativa (ex.: retry após falha de
    // persistência no NeDB) com o MESMO conteúdo não é conflito — só gravar
    // CONTEÚDO DIFERENTE no mesmo caminho continua bloqueado. criadoEm nesse
    // ramo é o mtime real do arquivo já em disco (write-once nunca o modifica
    // depois de criado) — nunca o horário desta chamada, que não seria quando
    // o arquivo foi de fato criado.
    if (fs.existsSync(caminhoFinalAbsoluto)) {
      const existente = fs.readFileSync(caminhoFinalAbsoluto);
      const hashExistente = crypto.createHash('sha256').update(existente).digest('hex');
      const hashNovo = crypto.createHash('sha256').update(buffer).digest('hex');
      if (hashExistente === hashNovo) {
        const stat = fs.statSync(caminhoFinalAbsoluto);
        return {
          caminhoRelativo,
          sha256: hashExistente,
          algoritmoHash: ALGORITMO_HASH,
          mimeType,
          tamanhoBytes: existente.length,
          criadoEm: stat.mtime.toISOString()
        };
      }
      throw new Error(`EvidenceStorage.save: destino já existe com conteúdo diferente (write-once) — ${caminhoRelativo}`);
    }

    const { sha256, tamanhoBytes } = escreverArquivoAtomico(caminhoFinalAbsoluto, buffer);

    return {
      caminhoRelativo,
      sha256,
      algoritmoHash: ALGORITMO_HASH,
      mimeType,
      tamanhoBytes,
      criadoEm: new Date().toISOString()
    };
  }

  function registrarManifestoIncoming({ tenantId, codigo, arquivos }) {
    const { absoluto: raizIncoming } = resolverCaminhoIncoming(tenantId, codigo);
    const caminhoManifesto = path.join(raizIncoming, 'manifest.json');
    const arquivosNormalizados = Array.isArray(arquivos) ? arquivos : [];

    if (fs.existsSync(caminhoManifesto)) {
      let manifestoExistente;
      try {
        manifestoExistente = JSON.parse(fs.readFileSync(caminhoManifesto, 'utf8'));
      } catch (e) {
        throw new Error(`EvidenceStorage.registrarManifestoIncoming: manifesto existente corrompido (JSON inválido) — ${codigo}`);
      }
      if (!manifestoExistenteValido(manifestoExistente, { codigo, tenantId })) {
        throw new Error(`EvidenceStorage.registrarManifestoIncoming: manifesto existente com schema inválido ou código/tenant divergente — ${codigo}`);
      }
      const mesmosArquivos = assinaturaArquivos(manifestoExistente.arquivos) === assinaturaArquivos(arquivosNormalizados);
      if (mesmosArquivos) {
        return manifestoExistente;
      }
      throw new Error(`EvidenceStorage.registrarManifestoIncoming: manifesto já existe com conjunto de arquivos diferente (write-once) — ${codigo}`);
    }

    const manifesto = {
      manifestId: crypto.randomUUID(),
      versao: 1,
      codigo,
      tenantId,
      criadoEm: new Date().toISOString(),
      algoritmoHash: ALGORITMO_HASH,
      arquivos: arquivosNormalizados
    };

    escreverArquivoAtomico(caminhoManifesto, Buffer.from(JSON.stringify(manifesto, null, 2)));
    return manifesto;
  }

  return { resolverCaminhoIncoming, save, registrarManifestoIncoming };
}

module.exports = { createEvidenceStorage };
