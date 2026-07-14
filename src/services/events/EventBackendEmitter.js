// src/services/events/EventBackendEmitter.js
// Constrói um evento oficial "gerado_pelo_backend" já classificado pelo
// Catálogo Oficial (EventCatalog.js) e enriquecido com o contexto do
// servidor (EventServerEnrichment.js) — reaproveita as duas peças já
// existentes da Microetapa 5.5.2, sem duplicar classificação em server.js.
// Só constrói o objeto em memória; quem chama decide se e quando dar push
// na lista única de eventos (Microetapa 5.5.3, regra 8).
//
// Este módulo é a fronteira oficial para construção de eventos cuja origem
// no Catálogo Oficial seja `gerado_pelo_backend`.

const { classificarTipoEvento } = require('./EventCatalog');
const { enriquecerEventosComServidor } = require('./EventServerEnrichment');

function construirEventoBackend(tipoOficial, { detalhe = '', referencia = null } = {}, contextoEventoBackend) {
  const classificacao = classificarTipoEvento(tipoOficial);
  if (!classificacao) {
    throw new Error(`EventBackendEmitter: tipo "${tipoOficial}" ausente do Catálogo Oficial.`);
  }
  if (classificacao.origem !== 'gerado_pelo_backend') {
    throw new Error(`EventBackendEmitter: tipo "${tipoOficial}" tem origem "${classificacao.origem}" — apenas tipos "gerado_pelo_backend" podem ser emitidos aqui.`);
  }
  const [eventoBase] = enriquecerEventosComServidor([{
    tipo: classificacao.tipo,
    categoria: classificacao.categoria,
    origem: classificacao.origem,
    valor: classificacao.valor,
    detalhe,
    dataHoraCliente: null,
    sessao: null
  }], contextoEventoBackend);
  // referencia não passa por enriquecerEventosComServidor (função certificada
  // na Microetapa 5.5.2, cujo contrato de campos não é alterado aqui) — é
  // acrescentada depois, só como ponteiro (caminhoRelativo) ao artefato
  // relacionado, nunca o próprio hash/conteúdo binário da evidência.
  return { ...eventoBase, referencia };
}

module.exports = { construirEventoBackend };
