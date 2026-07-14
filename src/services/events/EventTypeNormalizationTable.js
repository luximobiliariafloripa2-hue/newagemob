// src/services/events/EventTypeNormalizationTable.js
// Tabela de normalização entre os textos que o frontend já emite hoje
// (v2Evento(tipo, detalhe), public/index.html) e os tipos oficiais do
// Catálogo (EventCatalog.js). O frontend não muda nesta microetapa — a
// padronização de nomenclatura no próprio frontend fica para o Marco 9
// (Polimento Final). Esta tabela é o único lugar do sistema que conhece os
// dois nomes ao mesmo tempo.

const FORA_DO_ESCOPO_DOSSIE = 'fora_do_escopo_dossie';
const SOMENTE_GERADO_PELO_BACKEND = 'somente_gerado_pelo_backend';

const NORMALIZACAO_TIPOS_FRONTEND = new Map([
  ['Sessão iniciada',                    'sessao_iniciada'],
  ['Abertura do link de autorização',    'link_aberto'],

  // 'Avanço de etapa' não distingue início/fim de etapa (index.html:3324).
  // O catálogo prevê os dois eventos separadamente, mas o texto atual só
  // permite uma leitura defensável: avançar = a etapa anterior terminou.
  // etapa_iniciada fica no catálogo, mas não é emitido até o frontend ser
  // padronizado (Marco 9).
  ['Avanço de etapa',                    'etapa_concluida'],

  ['Geolocalização autorizada',          'geo_autorizada'],
  ['Geolocalização recusada',            'geo_recusada'],

  ['OTP enviado (WhatsApp real)',        'otp_enviado'],
  ['OTP enviado (E-mail real)',          'otp_enviado'],
  ['OTP enviado',                        'otp_enviado'],

  ['OTP validado',                       'otp_validado'],
  ['OTP incorreto',                      'otp_invalido'],
  ['Upload de documento',                'documento_enviado'],
  ['Selfie capturada',                   'selfie_capturada'],
  ['Selfie enviada (arquivo)',           'selfie_capturada'],
  ['Reconhecimento facial',              'biometria_executada'],
  ['Prova de vida',                      'liveness_executado'],
  ['Aceite expresso registrado',         'aceite_registrado'],
  ['Aceite expresso desmarcado',         'aceite_desmarcado'],
  ['Download do PDF assinado',           'pdf_baixado'],
  ['PDF reenviado por WhatsApp',         'pdf_reenviado'],
  ['PDF reenviado por WhatsApp (web)',   'pdf_reenviado'],
  ['PDF reenviado por e-mail',           'pdf_reenviado'],
  ['Preenchimento abandonado',           'etapa_abandonada'],

  // Eventos administrativos/de tenant — nunca pertencem ao Dossiê de uma
  // autorização individual (Constituição, Marco 5.4).
  ['Configuração de fluxo alterada',     FORA_DO_ESCOPO_DOSSIE],
  ['Conexão WhatsApp configurada',       FORA_DO_ESCOPO_DOSSIE],

  // O tipo oficial correspondente existe, mas sua origem é
  // gerado_pelo_backend — nunca pode nascer de uma declaração do cliente.
  // O backend recria esses dois eventos em outro ponto do fluxo
  // (Microetapa 5.5.3); a declaração do cliente é descartada aqui.
  ['Assinatura eletrônica concluída',    SOMENTE_GERADO_PELO_BACKEND],
  ['Assinatura adicional registrada',    SOMENTE_GERADO_PELO_BACKEND]
]);

// undefined quando o texto não consta na tabela — quem chama decide se
// isso é violação (EventShapeValidator trata como erro estrutural).
function resolverTipoOficial(tipoFrontend) {
  return NORMALIZACAO_TIPOS_FRONTEND.get(tipoFrontend);
}

module.exports = { NORMALIZACAO_TIPOS_FRONTEND, FORA_DO_ESCOPO_DOSSIE, SOMENTE_GERADO_PELO_BACKEND, resolverTipoOficial };
