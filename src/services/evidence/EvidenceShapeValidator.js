// src/services/evidence/EvidenceShapeValidator.js
// Valida a ESTRUTURA do payload de ingestão de evidências: codigo, tenantIdCandidato,
// itens como array, campos conhecidos, índices obrigatórios/proibidos, duplicidade,
// limites de contagem, presença da assinatura principal. Não valida magic number,
// MIME ou tamanho de buffer — isso é EvidenceBinaryValidator.js. Não toca disco,
// banco, rota ou Dossiê (Micro-Sprint 2.3.5.3 — Marco 4).

const { LIMITES_EVIDENCIA } = require('./constants');
const { validarFormatoCodigo } = require('./validators');
const { resolverCaminhoBase } = require('./EvidenceCatalogResolver');

class EvidenceValidationError extends Error {
  constructor(violacoes) {
    super(`EvidenceShapeValidator: payload inválido (${violacoes.length} violação(ões)): ${violacoes.join(' | ')}`);
    this.name = 'EvidenceValidationError';
    this.violacoes = violacoes;
  }
}

function validarEstrutura(payload) {
  if (payload === null || typeof payload !== 'object') {
    throw new EvidenceValidationError(['payload deve ser um objeto']);
  }

  const violacoes = [];

  if (!validarFormatoCodigo(payload.codigo)) {
    violacoes.push(`codigo em formato inválido: ${String(payload.codigo)}`);
  }

  if (payload.tenantIdCandidato !== undefined && payload.tenantIdCandidato !== null && typeof payload.tenantIdCandidato !== 'string') {
    violacoes.push(`tenantIdCandidato deve ser string, undefined ou null, recebido: ${typeof payload.tenantIdCandidato}`);
  }

  if (!Array.isArray(payload.itens)) {
    violacoes.push('itens deve ser um array');
    throw new EvidenceValidationError(violacoes);
  }

  const categoriasPorItem = [];
  const chavesVistas = new Set();

  payload.itens.forEach((item, i) => {
    if (item === null || typeof item !== 'object') {
      violacoes.push(`itens[${i}]: deve ser um objeto`);
      return;
    }

    if (typeof item.mimeType !== 'string' || item.mimeType.length === 0) {
      violacoes.push(`itens[${i}] (campo "${item.campo}"): mimeType deve ser string não-vazia`);
    }
    if (!Buffer.isBuffer(item.buffer)) {
      violacoes.push(`itens[${i}] (campo "${item.campo}"): buffer deve ser um Buffer`);
    }

    const chave = `${item.campo}:${item.indice}`;
    if (chavesVistas.has(chave)) {
      violacoes.push(`itens[${i}]: campo "${item.campo}" com índice "${item.indice}" duplicado`);
    }
    chavesVistas.add(chave);

    try {
      const { categoria } = resolverCaminhoBase(item.campo, item.indice);
      categoriasPorItem.push(categoria);
    } catch (e) {
      violacoes.push(`itens[${i}]: ${e.message}`);
    }
  });

  const totalDocumentos = categoriasPorItem.filter((c) => c === 'documentos').length;
  if (totalDocumentos > LIMITES_EVIDENCIA.maxDocumentos) {
    violacoes.push(`quantidade de documentos (${totalDocumentos}) excede o limite (${LIMITES_EVIDENCIA.maxDocumentos})`);
  }

  const totalAssinantesAdicionais = categoriasPorItem.filter((c) => c === 'assinantes_adicionais').length;
  if (totalAssinantesAdicionais > LIMITES_EVIDENCIA.maxAssinantesAdicionais) {
    violacoes.push(`quantidade de assinantes adicionais (${totalAssinantesAdicionais}) excede o limite (${LIMITES_EVIDENCIA.maxAssinantesAdicionais})`);
  }

  const temAssinaturaPrincipal = payload.itens.some((item) => item && item.campo === 'assinatura');
  if (!temAssinaturaPrincipal) {
    violacoes.push('assinatura principal (campo "assinatura") é obrigatória e está ausente');
  }

  if (violacoes.length > 0) {
    throw new EvidenceValidationError(violacoes);
  }
}

module.exports = { validarEstrutura };
