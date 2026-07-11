// src/services/evidence/EvidenceBinaryValidator.js
// Valida o CONTEÚDO BINÁRIO de cada item: buffer é Buffer, MIME na whitelist,
// MIME permitido para a categoria, magic number, tamanho dentro do limite,
// buffer não vazio, soma total dos buffers dentro do limite global. Não
// valida estrutura do payload — isso é EvidenceShapeValidator.js. Não toca
// disco, banco, rota ou Dossiê (Micro-Sprint 2.3.5.3 — Marco 4).

const { MIME_WHITELIST, LIMITES_EVIDENCIA } = require('./constants');
const { resolverCaminhoBase } = require('./EvidenceCatalogResolver');

// MIME permitido por categoria — assinatura/biometria/assinantes_adicionais são
// sempre imagem; documentos aceitam também PDF.
const MIME_PERMITIDO_POR_CATEGORIA = {
  assinatura: ['image/png', 'image/jpeg'],
  biometria: ['image/png', 'image/jpeg'],
  documentos: ['image/png', 'image/jpeg', 'application/pdf'],
  assinantes_adicionais: ['image/png', 'image/jpeg']
};

// Limite de tamanho por categoria — reaproveita as chaves já declaradas em
// LIMITES_EVIDENCIA (constants.js), nunca um número novo.
const LIMITE_BYTES_POR_CATEGORIA = {
  assinatura: LIMITES_EVIDENCIA.assinaturaPrincipalBytes,
  biometria: LIMITES_EVIDENCIA.selfieBytes,
  documentos: LIMITES_EVIDENCIA.documentoBytes,
  assinantes_adicionais: LIMITES_EVIDENCIA.assinaturaAdicionalBytes
};

class EvidenceValidationError extends Error {
  constructor(violacoes) {
    super(`EvidenceBinaryValidator: payload inválido (${violacoes.length} violação(ões)): ${violacoes.join(' | ')}`);
    this.name = 'EvidenceValidationError';
    this.violacoes = violacoes;
  }
}

function validarBinarios(itens) {
  if (!Array.isArray(itens)) {
    throw new EvidenceValidationError(['itens deve ser um array']);
  }

  const violacoes = [];

  itens.forEach((item, i) => {
    if (item === null || typeof item !== 'object') {
      violacoes.push(`itens[${i}]: deve ser um objeto`);
      return;
    }

    const rotulo = `itens[${i}] (campo "${item.campo}")`;

    if (!Buffer.isBuffer(item.buffer)) {
      violacoes.push(`${rotulo}: buffer deve ser um Buffer`);
      return;
    }
    if (item.buffer.length === 0) {
      violacoes.push(`${rotulo}: buffer está vazio`);
      return;
    }
    if (!MIME_WHITELIST[item.mimeType]) {
      violacoes.push(`${rotulo}: mimeType "${item.mimeType}" não está na whitelist`);
      return;
    }

    let categoria;
    try {
      categoria = resolverCaminhoBase(item.campo, item.indice).categoria;
    } catch (e) {
      violacoes.push(`${rotulo}: ${e.message}`);
      return;
    }

    const mimesPermitidos = MIME_PERMITIDO_POR_CATEGORIA[categoria] || [];
    if (!mimesPermitidos.includes(item.mimeType)) {
      violacoes.push(`${rotulo}: mimeType "${item.mimeType}" não é permitido para a categoria "${categoria}"`);
    }

    const magicNumber = MIME_WHITELIST[item.mimeType].magicNumber;
    const inicioBuffer = item.buffer.subarray(0, magicNumber.length);
    if (!inicioBuffer.equals(magicNumber)) {
      violacoes.push(`${rotulo}: magic number não corresponde ao mimeType declarado (${item.mimeType})`);
    }

    const limiteBytes = LIMITE_BYTES_POR_CATEGORIA[categoria];
    if (typeof limiteBytes === 'number' && item.buffer.length > limiteBytes) {
      violacoes.push(`${rotulo}: tamanho (${item.buffer.length} bytes) excede o limite da categoria "${categoria}" (${limiteBytes} bytes)`);
    }
  });

  const somaTotalBytes = itens.reduce((soma, item) => soma + (item && Buffer.isBuffer(item.buffer) ? item.buffer.length : 0), 0);
  if (somaTotalBytes > LIMITES_EVIDENCIA.bodyGlobalBytes) {
    violacoes.push(`soma total dos arquivos (${somaTotalBytes} bytes) excede o limite global (${LIMITES_EVIDENCIA.bodyGlobalBytes} bytes)`);
  }

  if (violacoes.length > 0) {
    throw new EvidenceValidationError(violacoes);
  }
}

module.exports = { validarBinarios };
