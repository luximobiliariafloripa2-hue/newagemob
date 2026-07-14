// src/services/events/EventCatalog.js
// Catálogo Oficial dos Eventos Jurídicos do AGEMOB — Constituição aprovada
// no Marco 5, Microetapa 5.4. Fonte única de classificação (categoria,
// origem de confiança, valor jurídico, visibilidade) de cada tipo de
// evento. Não decide como um evento é gerado — só como deve ser
// classificado quando existir. Inclui tipos ainda não implementados
// (ex.: manifesto_assinado) porque o catálogo é aditivo por princípio
// (Constituição, Princípio 7) — presença aqui não implica emissão hoje.
// Nunca remover uma entrada já publicada, só descontinuar preservando o
// tipo para leitura de eventos antigos.

const { CATEGORIAS_EVENTO_VALIDAS, ORIGENS_EVENTO_VALIDAS } = require('./constants');

const CATALOGO_EVENTOS_OFICIAIS = [
  { tipo: 'link_aberto',                    categoria: 'timeline', origem: 'confirmado',         valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'sessao_iniciada',                categoria: 'timeline', origem: 'declarado',           valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'etapa_iniciada',                 categoria: 'timeline', origem: 'declarado',           valor: 'operacional', visivel: 'interno' },
  { tipo: 'etapa_concluida',                categoria: 'timeline', origem: 'declarado',           valor: 'operacional', visivel: 'interno' },
  { tipo: 'etapa_abandonada',               categoria: 'timeline', origem: 'declarado',           valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'erro_interrupcao',               categoria: 'timeline', origem: 'declarado',           valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'geo_autorizada',                 categoria: 'ambas',    origem: 'declarado',           valor: 'juridico',    visivel: 'interno' },
  { tipo: 'geo_recusada',                   categoria: 'ambas',    origem: 'declarado',           valor: 'juridico',    visivel: 'interno' },
  { tipo: 'aceite_registrado',              categoria: 'ambas',    origem: 'declarado',           valor: 'juridico',    visivel: 'painel' },
  { tipo: 'aceite_desmarcado',              categoria: 'ambas',    origem: 'declarado',           valor: 'juridico',    visivel: 'painel' },
  { tipo: 'otp_enviado',                    categoria: 'timeline', origem: 'declarado',           valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'otp_validado',                   categoria: 'ambas',    origem: 'confirmado',          valor: 'juridico',    visivel: 'painel' },
  { tipo: 'otp_invalido',                   categoria: 'custodia', origem: 'confirmado',          valor: 'auditoria',   visivel: 'interno' },
  { tipo: 'documento_enviado',              categoria: 'ambas',    origem: 'confirmado',          valor: 'juridico',    visivel: 'painel' },
  { tipo: 'selfie_capturada',               categoria: 'ambas',    origem: 'confirmado',          valor: 'juridico',    visivel: 'painel' },
  { tipo: 'biometria_executada',            categoria: 'ambas',    origem: 'confirmado',          valor: 'juridico',    visivel: 'painel' },
  { tipo: 'liveness_executado',             categoria: 'ambas',    origem: 'confirmado',          valor: 'juridico',    visivel: 'painel' },
  { tipo: 'assinatura_realizada',           categoria: 'ambas',    origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'assinatura_adicional_realizada', categoria: 'ambas',    origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'painel' },
  { tipo: 'assinaturas_concluidas',         categoria: 'timeline', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'pdf_gerado',                     categoria: 'ambas',    origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'evidencia_ingerida',             categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'dossie_criado',                  categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'manifesto_criado',               categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'hashes_gerados',                 categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'manifesto_assinado',             categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'carimbo_tempo_aplicado',         categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'merkle_ancorado',                categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'publico' },
  { tipo: 'verificacao_integridade',        categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'acesso_administrativo',          categoria: 'custodia', origem: 'gerado_pelo_backend', valor: 'juridico',    visivel: 'interno' },
  { tipo: 'autorizacao_cancelada',          categoria: 'timeline', origem: 'confirmado',          valor: 'juridico',    visivel: 'publico' },
  { tipo: 'pdf_baixado',                    categoria: 'timeline', origem: 'declarado',           valor: 'operacional', visivel: 'interno' },
  { tipo: 'pdf_reenviado',                  categoria: 'timeline', origem: 'declarado',           valor: 'operacional', visivel: 'interno' },
  { tipo: 'validacao_publica_consultada',   categoria: 'timeline', origem: 'confirmado',          valor: 'auditoria',   visivel: 'interno' }
];
// fluxo_configurado não entra no catálogo — a Constituição já define que
// ele nunca pertence ao Dossiê de uma autorização individual.

// Autoverificação ao carregar o módulo: categoria/origem válidas e nenhum
// tipo repetido. Falha alto e cedo — antes de qualquer coisa depender de um
// catálogo inconsistente — em vez de deixar uma duplicata sobrescrever
// silenciosamente a entrada anterior no Map abaixo.
const tiposVistos = new Set();
CATALOGO_EVENTOS_OFICIAIS.forEach((e) => {
  if (!CATEGORIAS_EVENTO_VALIDAS.has(e.categoria)) {
    throw new Error(`EventCatalog: categoria inválida para "${e.tipo}": ${e.categoria}`);
  }
  if (!ORIGENS_EVENTO_VALIDAS.has(e.origem)) {
    throw new Error(`EventCatalog: origem inválida para "${e.tipo}": ${e.origem}`);
  }
  if (tiposVistos.has(e.tipo)) {
    throw new Error(`EventCatalog: tipo duplicado no catálogo: "${e.tipo}"`);
  }
  tiposVistos.add(e.tipo);
});

const CATALOGO_POR_TIPO = new Map(CATALOGO_EVENTOS_OFICIAIS.map((e) => [e.tipo, e]));

function classificarTipoEvento(tipo) {
  return CATALOGO_POR_TIPO.get(tipo) || null;
}

module.exports = { CATALOGO_EVENTOS_OFICIAIS, classificarTipoEvento };
