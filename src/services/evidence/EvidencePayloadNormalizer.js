// src/services/evidence/EvidencePayloadNormalizer.js
// Transforma o payload JÁ VALIDADO em formato canônico: resolve tenantId final
// (via resolverTenantId) e categoria/caminhoBase por item (via
// EvidenceCatalogResolver). Não valida regra de negócio — assume payload
// validado. Não muta o payload original. Não grava nada. Não toca
// disco/banco/rota/Dossiê (Micro-Sprint 2.3.5.3 — Marco 4).

const { resolverTenantId } = require('./validators');
const { resolverCaminhoBase } = require('./EvidenceCatalogResolver');

function normalizarPayload(payload) {
  const tenantId = resolverTenantId({ imobiliariaId: payload.tenantIdCandidato });

  const itens = payload.itens.map((item) => {
    const { categoria, caminhoBase } = resolverCaminhoBase(item.campo, item.indice);
    return {
      campo: item.campo,
      indice: item.indice,
      categoria,
      mimeType: item.mimeType,
      buffer: item.buffer,
      caminhoBase
    };
  });

  return { tenantId, codigo: payload.codigo, itens };
}

module.exports = { normalizarPayload };
