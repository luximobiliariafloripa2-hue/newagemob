const bcrypt = require('bcryptjs');

// ═══════════════════════════════════════════════════════
// SEED — Super Admin + Planos + Pacotes + Lux House
// ═══════════════════════════════════════════════════════
async function seed(db) {
  // Super admin
  const superAdmin = await db.usuarios.findOne({ role: 'super_admin' });
  if (!superAdmin) {
    const hash = await bcrypt.hash(process.env.SUPER_ADMIN_PASS || 'LuxAdmin2026!', 10);
    await db.usuarios.insert({
      nome: 'Super Admin AGEMOB', email: process.env.SUPER_ADMIN_EMAIL || 'admin@agemob.com.br',
      senha: hash, role: 'super_admin', ativo: true, criadoEm: new Date().toISOString()
    });
    console.log('  ✓ Super admin criado');
  }

  // Planos padrão
  const planoCount = await db.planos.count({});
  if (planoCount === 0) {
    for (const p of [
      { slug:'trial',     nome:'Trial',     limite:1,   valorMensal:0,     maxUsuarios:1,  ativo:true },
      { slug:'start',     nome:'Start',     limite:10,  valorMensal:29.90, maxUsuarios:1,  ativo:true },
      { slug:'pro',       nome:'Pro',       limite:25,  valorMensal:49.90, maxUsuarios:2,  ativo:true },
      { slug:'prime',     nome:'Prime',     limite:40,  valorMensal:79.90, maxUsuarios:5,  ativo:true },
      { slug:'corporate', nome:'Corporate', limite:-1,  valorMensal:0,     maxUsuarios:-1, ativo:true },
      { slug:'enterprise',nome:'Enterprise',limite:100, valorMensal:0,     maxUsuarios:-1, ativo:true },
      { slug:'unlimited', nome:'Unlimited', limite:-1,  valorMensal:0,     maxUsuarios:-1, ativo:true }
    ]) await db.planos.insert({ ...p, criadoEm: new Date().toISOString() });
    console.log('  ✓ Planos criados');
  }

  // Pacotes de créditos padrão
  const pacoteCount = await db.pacotes.count({});
  if (pacoteCount === 0) {
    for (const p of [
      { nome:'Starter', quantidade:5, valor:0, ativo:true },
      { nome:'Growth', quantidade:10, valor:0, ativo:true },
      { nome:'Business', quantidade:20, valor:0, ativo:true },
      { nome:'Max', quantidade:50, valor:0, ativo:true }
    ]) await db.pacotes.insert({ ...p, criadoEm: new Date().toISOString() });
    console.log('  ✓ Pacotes criados');
  }

  // Lux House
  const luxHouse = await db.imobiliarias.findOne({ slug: 'lux-house' });
  if (!luxHouse) {
    const plano = await db.planos.findOne({ slug: 'pro' });
    const imob = await db.imobiliarias.insert({
      tipoCliente:'imobiliaria', nome:'Lux House Imóveis',
      razaoSocial:'Lux House Imóveis Ltda.', nomeFantasia:'Lux House Imóveis',
      slug:'lux-house', cnpj:'48.192.939/0001-21', creci:'', telefone:'', whatsapp:'',
      email:'luximobiliariafloripa2@gmail.com', site:'',
      endereco:{ cep:'', logradouro:'Rua das Algas', numero:'733',
        complemento:'Sala 1', bairro:'Jurerê Internacional', cidade:'Florianópolis', estado:'SC' },
      responsavel:{ nome:'Bruno Amorim Costa', cpf:'', creci:'', telefone:'', whatsapp:'', email:'luximobiliariafloripa2@gmail.com' },
      corPrimaria:'#04273B', corSecundaria:'#C9A227',
      planoId: plano?._id||null, planoSlug:'pro', planoNome:'Pro',
      limiteAutorizacoes:30, creditosExtras:0, status:'ativo', ativo:true,
      criadoEm: new Date().toISOString()
    });
    const hash = await bcrypt.hash(process.env.LUX_ADMIN_PASS || 'lux2026', 10);
    await db.usuarios.insert({
      nome:'Admin Lux House', email:'admin', senha:hash, role:'admin',
      imobiliariaId:imob._id, imobiliariaSlug:'lux-house', ativo:true, criadoEm:new Date().toISOString()
    });
    console.log('  ✓ Lux House criada');
  }
}

module.exports = seed;
