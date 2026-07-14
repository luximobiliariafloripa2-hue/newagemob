// src/services/events/EventShapeValidator.js
// Valida a ESTRUTURA do array de eventos declarados pelo cliente, tal como
// v2Evento() já produz hoje (tipo, detalhe, dataHora, dataHoraLocal, ip,
// sessao, usuario — public/index.html:3142). Não persiste, não classifica
// por categoria/origem (isso é EventNormalizer.js), não toca disco nem
// banco, não é chamado por nenhuma rota ainda (Microetapa 5.5.1).

const { LIMITES_EVENTO } = require('./constants');
const { resolverTipoOficial } = require('./EventTypeNormalizationTable');

class EventValidationError extends Error {
  constructor(violacoes) {
    super(`EventShapeValidator: payload inválido (${violacoes.length} violação(ões)): ${violacoes.join(' | ')}`);
    this.name = 'EventValidationError';
    this.violacoes = violacoes;
  }
}

function validarCampoTexto(valor, nomeCampo, limite, violacoes, indice) {
  if (valor === undefined || valor === null) return;
  if (typeof valor !== 'string') {
    violacoes.push(`eventos[${indice}]: ${nomeCampo} deve ser string, recebido ${typeof valor}`);
    return;
  }
  if (valor.length > limite) {
    violacoes.push(`eventos[${indice}]: ${nomeCampo} excede o limite de ${limite} caracteres`);
  }
}

// Lança EventValidationError se inválido. Não retorna nada — a
// normalização (EventNormalizer.js) roda depois, mesmo padrão em duas
// etapas de EvidenceShapeValidator.js + EvidencePayloadNormalizer.js.
function validarEstrutura(eventosBrutos) {
  if (!Array.isArray(eventosBrutos)) {
    throw new EventValidationError(['eventos deve ser um array']);
  }

  if (eventosBrutos.length > LIMITES_EVENTO.maxEventosPorSubmissao) {
    throw new EventValidationError([`quantidade de eventos (${eventosBrutos.length}) excede o limite (${LIMITES_EVENTO.maxEventosPorSubmissao})`]);
  }

  const violacoes = [];

  eventosBrutos.forEach((evento, i) => {
    if (evento === null || typeof evento !== 'object') {
      violacoes.push(`eventos[${i}]: deve ser um objeto`);
      return;
    }

    if (typeof evento.tipo !== 'string' || evento.tipo.length === 0) {
      violacoes.push(`eventos[${i}]: tipo deve ser string não-vazia`);
    } else if (resolverTipoOficial(evento.tipo) === undefined) {
      violacoes.push(`eventos[${i}]: tipo "${evento.tipo}" não consta na tabela de normalização`);
    }

    if (typeof evento.dataHora !== 'string' || Number.isNaN(new Date(evento.dataHora).getTime())) {
      violacoes.push(`eventos[${i}]: dataHora deve ser uma data ISO válida`);
    }

    if (typeof evento.sessao !== 'string' || evento.sessao.length === 0) {
      violacoes.push(`eventos[${i}]: sessao deve ser string não-vazia`);
    }

    validarCampoTexto(evento.detalhe, 'detalhe', LIMITES_EVENTO.maxTamanhoDetalhe, violacoes, i);
    validarCampoTexto(evento.dataHoraLocal, 'dataHoraLocal', LIMITES_EVENTO.maxTamanhoCampoTexto, violacoes, i);
    validarCampoTexto(evento.ip, 'ip', LIMITES_EVENTO.maxTamanhoCampoTexto, violacoes, i);
    validarCampoTexto(evento.usuario, 'usuario', LIMITES_EVENTO.maxTamanhoCampoTexto, violacoes, i);
  });

  if (violacoes.length > 0) {
    throw new EventValidationError(violacoes);
  }
}

module.exports = { validarEstrutura, EventValidationError };
