'use strict';

// Regra central de acesso de uma imobiliária (tenant) — M9-01.
//
// Dois eixos independentes, nunca misturados:
//   administrativo (imob.status, decidido só pelo Super Admin): ativo | suspenso | inativo
//   financeiro     (sub.status):                                 trial | active | pending
// O status efetivo é sempre calculado aqui; nada novo é gravado. Valores
// legados são normalizados na leitura (sem migração de banco).
//
// Função pura: recebe os documentos já carregados e a data de referência,
// não acessa banco nem relógio por conta própria.

const DIAS_TRIAL = 7;
const LIMITE_TRIAL_PADRAO = 1;

// imob.ativo é só espelho de imob.status; ativo:false sem status coerente
// (gravado por versões anteriores) é tratado como inativo — leitura mais segura.
// sub.status legado 'suspended'/'canceled' pertence ao eixo administrativo.
function normalizarStatusAdministrativo(imob, sub) {
  const s = imob?.status;
  if (s === 'inativo' || s === 'cancelado' || imob?.ativo === false) return 'inativo';
  if (sub?.status === 'canceled') return 'inativo';
  if (s === 'suspenso' || sub?.status === 'suspended') return 'suspenso';
  return 'ativo';
}

// Desconhecido → pending (não opera): falha fechada.
function normalizarStatusFinanceiro(status) {
  if (status === 'trial') return 'trial';
  if (status === 'active' || status === 'ativo' || status === 'suspended' || status === 'canceled') return 'active';
  return 'pending';
}

function dataValida(valor) {
  if (!valor) return null;
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function limiteTrial(planoTrial) {
  const l = planoTrial?.limite;
  return Number.isInteger(l) && l >= 0 ? l : LIMITE_TRIAL_PADRAO;
}

function resultado(statusEfetivo, podeLogin, podeConsultar, podeOperar, motivo, extra = {}) {
  return { statusEfetivo, podeLogin, podeConsultar, podeOperar, motivo, trial: null, ...extra };
}

/**
 * @param {object}  p
 * @param {object?} p.imob        documento da imobiliária
 * @param {object?} p.sub         documento da subscription (null = conta antiga sem assinatura)
 * @param {object?} p.planoTrial  plano slug 'trial' de db.planos (usado só se sub em trial)
 * @param {number}  p.usoTrial    total de autorizações já criadas pela imobiliária
 * @param {Date}    p.agora
 */
function avaliarAcessoImobiliaria({ imob, sub, planoTrial, usoTrial = 0, agora = new Date() }) {
  if (!imob) return resultado('inexistente', false, false, false, 'Imobiliária não encontrada.');

  const adm = normalizarStatusAdministrativo(imob, sub);
  if (adm === 'inativo') return resultado('desativado', false, false, false, 'Conta desativada. Entre em contato com o suporte.');
  if (adm === 'suspenso') return resultado('suspenso', true, true, false, 'Conta suspensa. Entre em contato com o suporte.');

  // Compatibilidade: contas antigas reais sem subscription seguem operando pelo limite mensal.
  if (!sub) return resultado('ativo', true, true, true, null, { legado: true });

  const fin = normalizarStatusFinanceiro(sub.status);

  if (fin === 'trial') {
    const expiraEm = dataValida(sub.trialExpiration);
    const limite = limiteTrial(planoTrial);
    const usadas = usoTrial;
    const trial = { expiraEm: expiraEm ? expiraEm.toISOString() : null, usadas, limite };
    if (!expiraEm || agora > expiraEm) {
      return resultado('trial_expirado', true, true, false, 'Seu período de teste terminou. Assine um plano para continuar criando autorizações.', { trial });
    }
    if (usadas >= limite) {
      return resultado('trial_expirado', true, true, false, 'Você já utilizou a autorização gratuita do teste. Assine um plano para continuar.', { trial });
    }
    return resultado('trial_ativo', true, true, true, null, { trial });
  }

  if (fin === 'pending') {
    return resultado('aguardando_pagamento', true, true, false, 'Pagamento pendente. Conclua a assinatura do plano para continuar criando autorizações.');
  }

  // planoVencimento só tem autoridade quando escrito pelo pagamento/Super Admin;
  // ausente = sem vencimento. renewalDate nunca é consultado aqui.
  if (sub.planoVencimento !== undefined && sub.planoVencimento !== null) {
    const venc = dataValida(sub.planoVencimento);
    if (!venc || agora > venc) {
      return resultado('vencido', true, true, false, 'Seu plano venceu. Renove a assinatura para continuar criando autorizações.');
    }
  }

  return resultado('ativo', true, true, true, null);
}

module.exports = {
  DIAS_TRIAL,
  avaliarAcessoImobiliaria,
  normalizarStatusFinanceiro
};
