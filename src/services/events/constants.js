// src/services/events/constants.js
// Constantes do catálogo oficial de eventos jurídicos (Constituição dos
// Eventos Jurídicos, Marco 5 — Microetapa 5.4). Isolado do Dossiê e da rota
// de assinatura até a integração ser aprovada (Microetapa 5.5.2+).

const VERSAO_SCHEMA_EVENTOS = 1;

const CATEGORIAS_EVENTO_VALIDAS = new Set(['timeline', 'custodia', 'ambas']);

const ORIGENS_EVENTO_VALIDAS = new Set(['declarado', 'confirmado', 'gerado_pelo_backend']);

// Mesmo espírito de LIMITES_EVIDENCIA (src/services/evidence/constants.js):
// limite defensivo contra payload desproporcional, não regra de negócio.
const LIMITES_EVENTO = {
  maxEventosPorSubmissao: 500,
  maxTamanhoDetalhe: 500,
  maxTamanhoCampoTexto: 200
};

module.exports = {
  VERSAO_SCHEMA_EVENTOS,
  CATEGORIAS_EVENTO_VALIDAS,
  ORIGENS_EVENTO_VALIDAS,
  LIMITES_EVENTO
};
