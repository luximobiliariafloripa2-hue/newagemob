#!/usr/bin/env node
'use strict';
// Auditoria SOMENTE LEITURA de duplicidades (M11).
//
// Uso:  node scripts/auditar-duplicidades.js [pasta-de-dados]
//       (padrão: DATA_DIR ou ./data)
//
// Lê os arquivos .db linha a linha, sem carregar o NeDB — carregar o NeDB
// reescreve (compacta) os arquivos, e esta ferramenta nunca escreve nada.
// Não altera, mescla nem apaga contas: só relata. E-mails e documentos saem
// mascarados. Código de saída: 0 sem duplicidades; 1 com duplicidades; 2 erro.

const fs = require('fs');
const path = require('path');

function ler(pasta, nome) {
  const arq = path.join(pasta, nome + '.db');
  if (!fs.existsSync(arq)) return [];
  const docs = new Map();
  for (const linha of fs.readFileSync(arq, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    let d;
    try { d = JSON.parse(linha); } catch { continue; }
    if (d.$$indexCreated || d.$$indexRemoved) continue;
    if (d.$$deleted) { docs.delete(d._id); continue; }
    if (d._id) docs.set(d._id, d);
  }
  return [...docs.values()];
}
const mascararEmail = (e) => {
  const [u, d] = String(e).split('@');
  return d ? (u.slice(0, 2) + '***@' + d) : '***';
};
const mascararDoc = (v) => { const s = String(v).replace(/\D/g, ''); return s ? s.slice(0, 3) + '***' + s.slice(-2) : '***'; };
function agrupar(lista, chaveDe) {
  const g = new Map();
  for (const item of lista) {
    const k = chaveDe(item);
    if (!k) continue;
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(item);
  }
  return [...g.entries()].filter(([, v]) => v.length > 1);
}

function auditar(pasta) {
  const usuarios = ler(pasta, 'usuarios');
  const imobs = ler(pasta, 'imobiliarias');
  const identidades = ler(pasta, 'identidades');
  const norm = (e) => (typeof e === 'string' ? e.toLowerCase().trim() : '');
  const rel = {
    pasta, totais: { usuarios: usuarios.length, imobiliarias: imobs.length, identidades: identidades.length },
    // Mesmo e-mail (normalizado) em mais de um usuário: impede o índice único e torna o login ambíguo.
    usuariosEmailDuplicado: agrupar(usuarios, u => norm(u.email)).map(([e, l]) => ({ email: mascararEmail(e), ids: l.map(u => u._id), papeis: l.map(u => u.role), ativos: l.map(u => u.ativo === true) })),
    // E-mail ausente, nulo ou fora do padrão (maiúsculas/espaços).
    usuariosSemEmail: usuarios.filter(u => !norm(u.email)).map(u => u._id),
    usuariosEmailNaoNormalizado: usuarios.filter(u => typeof u.email === 'string' && u.email !== norm(u.email)).map(u => ({ id: u._id, email: mascararEmail(u.email) })),
    // Documentos repetidos entre tenants (podem ser legítimos; revisar manualmente).
    imobiliariasCnpjRepetido: agrupar(imobs, i => String(i.cnpj || '').replace(/\D/g, '')).map(([d, l]) => ({ cnpj: mascararDoc(d), ids: l.map(i => i._id) })),
    imobiliariasCpfRepetido: agrupar(imobs, i => String(i.cpf || '').replace(/\D/g, '')).map(([d, l]) => ({ cpf: mascararDoc(d), ids: l.map(i => i._id) })),
    imobiliariasCreciRepetido: agrupar(imobs, i => String(i.creci || '').trim().toUpperCase()).map(([c, l]) => ({ creci: c, ids: l.map(i => i._id) })),
    // Identidade social apontando para mais de um usuário, ou usuário com mais de uma do mesmo provedor.
    identidadesChaveDuplicada: agrupar(identidades, i => i.chave).map(([c, l]) => ({ chave: c.split(':')[0] + ':***', ids: l.map(i => i._id) })),
    identidadesPorUsuarioDuplicadas: agrupar(identidades, i => i.provedor && i.usuarioId ? i.provedor + ':' + i.usuarioId : '').map(([c, l]) => ({ usuarioProvedor: c, ids: l.map(i => i._id) })),
    identidadesOrfas: identidades.filter(i => !usuarios.some(u => u._id === i.usuarioId)).map(i => i._id)
  };
  rel.bloqueiamIndiceUnicoEmail = rel.usuariosEmailDuplicado.length > 0;
  rel.temDuplicidade = rel.usuariosEmailDuplicado.length + rel.identidadesChaveDuplicada.length + rel.identidadesPorUsuarioDuplicadas.length > 0;
  return rel;
}

if (require.main === module) {
  try {
    const pasta = path.resolve(process.argv[2] || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
    const rel = auditar(pasta);
    console.log(JSON.stringify(rel, null, 2));
    process.exit(rel.temDuplicidade ? 1 : 0);
  } catch (e) {
    console.error('Falha na auditoria:', e.message);
    process.exit(2);
  }
}
module.exports = { auditar };
