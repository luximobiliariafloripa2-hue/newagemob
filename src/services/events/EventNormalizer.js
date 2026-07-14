// src/services/events/EventNormalizer.js
// Transforma o array bruto do frontend (já validado por
// EventShapeValidator.validarEstrutura) em eventos normalizados: tipo
// oficial + categoria/origem/valor do catálogo.
//
// Eventos fora do escopo do Dossiê ou que só podem nascer do backend não
// são silenciosamente apagados: voltam em `ignorados`, cada um com seu
// `motivo` (fora_do_escopo_dossie | somente_gerado_pelo_backend), para que
// quem chamar preserve transparência de auditoria sobre tudo que chegou no
// payload do cliente, mesmo o que não entra no Dossiê.
//
// Saída ainda não é o evento oficial completo: id, dataHoraServidor, ip
// confirmado, codigo, tenantId, ator e versaoSchema são atribuídos pela
// rota de assinatura na integração (Microetapa 5.5.2+) — fora do escopo
// desta microetapa. ip/dataHoraLocal/usuario do cliente não são propagados
// nesta etapa: nunca são a fonte oficial (Constituição, seção 8).

const { classificarTipoEvento } = require('./EventCatalog');
const { resolverTipoOficial, FORA_DO_ESCOPO_DOSSIE, SOMENTE_GERADO_PELO_BACKEND } = require('./EventTypeNormalizationTable');

function normalizarEventos(eventosBrutos) {
  const normalizados = [];
  const ignorados = [];

  eventosBrutos.forEach((eventoBruto) => {
    const resolvido = resolverTipoOficial(eventoBruto.tipo);

    if (resolvido === FORA_DO_ESCOPO_DOSSIE || resolvido === SOMENTE_GERADO_PELO_BACKEND) {
      ignorados.push({ tipoOriginal: eventoBruto.tipo, motivo: resolvido });
      return;
    }

    const classificacao = classificarTipoEvento(resolvido);
    if (!classificacao) {
      // Só acontece se EventTypeNormalizationTable.js e EventCatalog.js
      // saírem de sincronia — inconsistência interna, não dado ruim do cliente.
      throw new Error(`EventNormalizer: tipo "${resolvido}" normalizado mas ausente do Catálogo Oficial.`);
    }

    normalizados.push({
      tipo:            classificacao.tipo,
      categoria:       classificacao.categoria,
      origem:          classificacao.origem,
      valor:           classificacao.valor,
      detalhe:         eventoBruto.detalhe || '',
      dataHoraCliente: eventoBruto.dataHora,
      sessao:          eventoBruto.sessao
    });
  });

  return { normalizados, ignorados };
}

module.exports = { normalizarEventos };
