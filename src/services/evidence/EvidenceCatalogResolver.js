// src/services/evidence/EvidenceCatalogResolver.js
// Única porta de acesso a CATALOGO_ARQUIVOS_INCOMING (constants.js) — traduz
// (campo, indice) em { categoria, caminhoBase }. Não toca disco, banco, MIME,
// tamanho, Buffer, tenant ou código (Micro-Sprint 2.3.5.3.1).

const { CATALOGO_ARQUIVOS_INCOMING } = require('./constants');

function campoConhecido(campo) {
  return typeof campo === 'string' &&
    Object.prototype.hasOwnProperty.call(CATALOGO_ARQUIVOS_INCOMING, campo);
}

// categoria e exigeIndice vêm declarados no próprio catálogo — nunca inferidos
// (nem por aridade de função, nem por split() do caminho resolvido).
function resolverCaminhoBase(campo, indice) {
  if (!campoConhecido(campo)) {
    throw new Error(`EvidenceCatalogResolver: campo desconhecido no catálogo: ${String(campo)}`);
  }

  const { categoria, exigeIndice, resolver } = CATALOGO_ARQUIVOS_INCOMING[campo];

  if (exigeIndice && !(Number.isInteger(indice) && indice >= 0)) {
    throw new Error(`EvidenceCatalogResolver: campo "${campo}" exige índice inteiro não-negativo, recebido: ${String(indice)}`);
  }
  if (!exigeIndice && indice !== undefined && indice !== null) {
    throw new Error(`EvidenceCatalogResolver: campo "${campo}" não aceita índice, recebido: ${String(indice)}`);
  }

  const caminhoBase = exigeIndice ? resolver(indice) : resolver();

  return { categoria, caminhoBase };
}

module.exports = { campoConhecido, resolverCaminhoBase };
