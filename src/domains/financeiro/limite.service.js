// ═══════════════════════════════════════════════════════
// HELPERS SAAS — Controle de limite e créditos
// ═══════════════════════════════════════════════════════
function createLimiteService(db) {

  async function verificarLimite(imobiliariaId) {
    const imob = await db.imobiliarias.findOne({ _id: imobiliariaId });
    if (!imob) return { ok: false, erro: 'Imobiliária não encontrada.' };
    if (imob.status === 'suspenso') return { ok: false, erro: 'Conta suspensa. Entre em contato com o suporte.' };
    if (imob.status === 'inativo') return { ok: false, erro: 'Conta inativa.' };

    // Unlimited — sem limite
    if (imob.limiteAutorizacoes === -1) return { ok: true };

    // Conta autorizações do mês atual
    const now = new Date();
    const inicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const usadas = await db.autorizacoes.count({
      imobiliariaId,
      criadoEm: { $gte: inicio }
    });

    const limite = imob.limiteAutorizacoes || 0;
    const extras = imob.creditosExtras || 0;

    if (usadas < limite) return { ok: true, usadas, limite, extras, tipo: 'plano' };
    if (usadas < limite + extras) return { ok: true, usadas, limite, extras, tipo: 'credito_extra' };

    return {
      ok: false,
      erro: 'Você atingiu o limite de autorizações do seu plano. Adquira créditos adicionais ou faça upgrade.',
      usadas, limite, extras
    };
  }

  async function consumirCredito(imobiliariaId, tipo) {
    if (tipo === 'credito_extra') {
      await db.imobiliarias.update({ _id: imobiliariaId }, { $inc: { creditosExtras: -1 } });
    }
  }

  function calcularPorcentagem(usadas, limite) {
    if (limite === -1) return 0;
    return Math.round((usadas / Math.max(limite, 1)) * 100);
  }

  return { verificarLimite, consumirCredito, calcularPorcentagem };
}

module.exports = createLimiteService;
