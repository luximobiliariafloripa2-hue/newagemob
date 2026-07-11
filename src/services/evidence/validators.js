// Validadores puros da camada de evidências (Micro-Sprint 2.3.5.0/2.3.5.1).
// Nenhuma função aqui toca disco, rede ou banco.

// codigo é sempre gerado por genCode() (server.js), hoje com alfabeto restrito de 9
// caracteres (sem I/O/0/1). A faixa 6-12 aqui é deliberadamente mais permissiva —
// valida "é seguro usar num path", não "foi gerado pelo genCode() atual".
function validarFormatoCodigo(codigo) {
  return typeof codigo === 'string' && /^[A-Z0-9]{6,12}$/.test(codigo);
}

// imobiliariaId é um _id gerado pelo NeDB (16 caracteres alfanuméricos hoje) —
// faixa 8-32 cobre isso com folga.
function validarFormatoTenantId(tenantId) {
  return tenantId === '_sem_tenant' ||
    (typeof tenantId === 'string' && /^[A-Za-z0-9]{8,32}$/.test(tenantId));
}

// Autorizações sem imobiliariaId são um caso já conhecido e logado pelo fluxo de
// assinatura (server.js) — aqui só garantimos que sempre resolve para um tenantId
// válido, nunca null/undefined indo parar dentro de um path.
function resolverTenantId(rascunho) {
  const candidato = rascunho && rascunho.imobiliariaId;
  return validarFormatoTenantId(candidato) ? candidato : '_sem_tenant';
}

module.exports = {
  validarFormatoCodigo,
  validarFormatoTenantId,
  resolverTenantId
};
