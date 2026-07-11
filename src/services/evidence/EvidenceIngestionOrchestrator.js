// src/services/evidence/EvidenceIngestionOrchestrator.js
// Único ponto de entrada externo da camada de ingestão de evidências. Só
// sequencia: ShapeValidator → BinaryValidator → Normalizer → EvidenceStorage
// (save por item + manifesto) → objeto final. Não contém regra de negócio
// própria — qualquer decisão de negócio pertence a um dos módulos chamados
// aqui (Micro-Sprint 2.3.5.3 — Marco 4).

const { VERSAO_SCHEMA_EVIDENCIAS } = require('./constants');
const { validarEstrutura } = require('./EvidenceShapeValidator');
const { validarBinarios } = require('./EvidenceBinaryValidator');
const { normalizarPayload } = require('./EvidencePayloadNormalizer');
const { createEvidenceStorage } = require('./EvidenceStorage');

function montarResultadoFinal({ tenantId, codigo, caminhoIncoming, manifesto, arquivos }) {
  return { versaoSchema: VERSAO_SCHEMA_EVIDENCIAS, tenantId, codigo, caminhoIncoming, manifesto, arquivos };
}

function criarEvidenceIngestionOrchestrator({ storageBase }) {
  const storage = createEvidenceStorage({ storageBase });

  function ingerir(payloadBruto) {
    validarEstrutura(payloadBruto);
    validarBinarios(payloadBruto.itens);

    const normalizado = normalizarPayload(payloadBruto);

    const arquivos = normalizado.itens.map((item) =>
      storage.save({
        tenantId: normalizado.tenantId,
        codigo: normalizado.codigo,
        caminhoBase: item.caminhoBase,
        buffer: item.buffer,
        mimeType: item.mimeType
      })
    );

    const manifesto = storage.registrarManifestoIncoming({
      tenantId: normalizado.tenantId,
      codigo: normalizado.codigo,
      arquivos
    });

    const { relativo: caminhoIncoming } = storage.resolverCaminhoIncoming(normalizado.tenantId, normalizado.codigo);

    return montarResultadoFinal({ tenantId: normalizado.tenantId, codigo: normalizado.codigo, caminhoIncoming, manifesto, arquivos });
  }

  return { ingerir };
}

module.exports = { criarEvidenceIngestionOrchestrator };
