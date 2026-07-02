const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/env');

function createClientesController({ db, log, limiteService }) {

  // Listar todas as imobiliárias
  async function listarImobiliarias(_req, res) {
    const lista = await db.imobiliarias.find({}).sort({ criadoEm: -1 });
    // Adiciona contagem de autorizações para cada imobiliária
    const result = await Promise.all(lista.map(async imob => {
      const total = await db.autorizacoes.count({ imobiliariaId: imob._id });
      const assinadas = await db.autorizacoes.count({ imobiliariaId: imob._id, status: 'assinado' });
      return { ...imob, _stats: { total, assinadas } };
    }));
    res.json(result);
  }

  // Criar novo cliente (Imobiliária PJ ou Corretor Autônomo)
  async function criarImobiliaria(req, res) {
    try {
      const {
        tipoCliente, nome, razaoSocial, nomeFantasia, cnpj, cpf, creci,
        telefone, whatsapp, email, site, endereco, responsavel,
        corPrimaria, planoId, adminEmail, adminSenha, adminNome, status
      } = req.body;

      // Validações básicas
      if (!nome || !email || !adminEmail || !adminSenha) {
        return res.status(422).json({ erro: 'Nome, e-mail, e-mail de admin e senha são obrigatórios.' });
      }
      if (tipoCliente === 'imobiliaria' && !cnpj) {
        return res.status(422).json({ erro: 'CNPJ obrigatório para imobiliárias.' });
      }
      if (tipoCliente === 'corretor' && !cpf) {
        return res.status(422).json({ erro: 'CPF obrigatório para corretores autônomos.' });
      }

      // Duplicidade
      if (cnpj) { const ex = await db.imobiliarias.findOne({ cnpj }); if(ex) return res.status(422).json({ erro: 'CNPJ já cadastrado.' }); }
      if (cpf)  { const ex = await db.imobiliarias.findOne({ cpf });  if(ex) return res.status(422).json({ erro: 'CPF já cadastrado.' }); }
      if (creci){ const ex = await db.imobiliarias.findOne({ creci }); if(ex) return res.status(422).json({ erro: 'CRECI já cadastrado.' }); }

      // Busca plano
      let plano = null;
      if (planoId) plano = await db.planos.findOne({ _id: planoId });
      if (!plano) plano = await db.planos.findOne({ slug: 'pro' });

      const slug = nome.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')
                 + '-' + Date.now().toString(36);

      const imob = await db.imobiliarias.insert({
        tipoCliente:    tipoCliente || 'imobiliaria',
        nome, razaoSocial: razaoSocial || nome, nomeFantasia: nomeFantasia || nome,
        slug, cnpj: cnpj||'', cpf: cpf||'', creci: creci||'',
        telefone: telefone||'', whatsapp: whatsapp||'', email, site: site||'',
        endereco:   endereco   || {},
        responsavel: responsavel || {},
        corPrimaria: corPrimaria || '#04273B', corSecundaria: '#C9A227',
        planoId: plano?._id||null, planoSlug: plano?.slug||'pro', planoNome: plano?.nome||'Pro',
        limiteAutorizacoes: plano?.limite ?? 30,
        creditosExtras: 0,
        status: status || 'ativo',
        ativo: true,
        criadoEm:     new Date().toISOString(),
        atualizadoEm: new Date().toISOString()
      });

      const hash = await bcrypt.hash(adminSenha, 10);
      await db.usuarios.insert({
        nome: adminNome || nome, email: adminEmail.toLowerCase().trim(),
        senha: hash, role: 'admin',
        imobiliariaId: imob._id, imobiliariaSlug: slug,
        ativo: true, criadoEm: new Date().toISOString()
      });

      await log('admin', `Cliente criado: ${nome} (${tipoCliente||'imobiliaria'})`);
      res.json({ ok: true, imobiliaria: imob });
    } catch(e) {
      res.status(500).json({ erro: 'Falha ao criar cliente: ' + e.message });
    }
  }

  // Editar imobiliária
  async function editarImobiliaria(req, res) {
    try {
      const { nome, cnpj, email, endereco, corPrimaria, plano, ativo } = req.body;
      await db.imobiliarias.update({ _id: req.params.id }, {
        $set: { nome, cnpj, email, endereco, corPrimaria, plano, ativo, atualizadoEm: new Date().toISOString() }
      });
      res.json({ ok: true });
    } catch(e) {
      res.status(500).json({ erro: 'Falha ao atualizar.' });
    }
  }

  // PATCH completo para edição pelo Super Admin (todos os campos)
  async function editarImobiliariaCompleto(req, res) {
    try {
      const { nome, nomeFantasia, cnpj, creci, cpf, telefone, whatsapp, email,
              responsavel, endereco, status, planoId, limiteAutorizacoes, novaSenha } = req.body;
      if (!nome) return res.status(422).json({ erro: 'Nome é obrigatório.' });

      const upd = {
        nome, nomeFantasia, cnpj, creci, cpf, telefone, whatsapp, email,
        responsavel, endereco, status, atualizadoEm: new Date().toISOString()
      };
      if (limiteAutorizacoes !== undefined) upd.limiteAutorizacoes = limiteAutorizacoes;

      await db.imobiliarias.update({ _id: req.params.id }, { $set: upd });

      // Atualizar plano se fornecido
      if (planoId) {
        const plano = await db.planos.findOne({ _id: planoId });
        if (plano) {
          await db.imobiliarias.update({ _id: req.params.id }, { $set: {
            planoId: plano._id, planoSlug: plano.slug, planoNome: plano.nome,
            limiteAutorizacoes: limiteAutorizacoes !== undefined ? limiteAutorizacoes : plano.limite
          }});
          await db.subscriptions.update({ imobiliariaId: req.params.id }, { $set: {
            planoId: plano._id, planoSlug: plano.slug, planoNome: plano.nome,
            limiteAutorizacoes: plano.limite, atualizadoEm: new Date().toISOString()
          }});
        }
      }

      // Atualizar senha se fornecida
      if (novaSenha && novaSenha.length >= 6) {
        const hash = await bcrypt.hash(novaSenha, 10);
        await db.usuarios.update({ imobiliariaId: req.params.id, role: 'admin' }, { $set: { senha: hash } });
      }

      await log('admin', 'Imobiliária editada pelo Super Admin: ' + req.params.id);
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
  }

  // Desativar/ativar imobiliária
  async function alterarStatusImobiliaria(req, res) {
    const { ativo } = req.body;
    await db.imobiliarias.update({ _id: req.params.id }, { $set: { ativo: !!ativo, atualizadoEm: new Date().toISOString() } });
    res.json({ ok: true });
  }

  // Métricas globais para o super admin
  async function metricas(_req, res) {
    const imobs   = await db.imobiliarias.count({ ativo: true });
    const total   = await db.autorizacoes.count({});
    const assinadas = await db.autorizacoes.count({ status: 'assinado' });
    const hoje    = new Date(); hoje.setHours(0,0,0,0);
    const hoje30  = new Date(hoje); hoje30.setDate(hoje30.getDate()-30);
    const recentes = await db.autorizacoes.count({ criadoEm: { $gte: hoje30.toISOString() } });
    res.json({ imobiliarias: imobs, autorizacoesTotal: total, autorizacoesAssinadas: assinadas, autorizacoesUltimos30Dias: recentes });
  }

  // Listar usuários de uma imobiliária
  async function listarUsuariosDaImobiliaria(req, res) {
    const lista = await db.usuarios.find({ imobiliariaId: req.params.id });
    res.json(lista.map(({ senha, ...u }) => u));
  }

  // Alterar plano de uma imobiliária
  async function alterarPlanoImobiliaria(req, res) {
    try {
      const { planoId } = req.body;
      const plano = await db.planos.findOne({ _id: planoId });
      if (!plano) return res.status(404).json({ erro: 'Plano não encontrado.' });
      await db.imobiliarias.update({ _id: req.params.id }, {
        $set: { planoId, planoSlug: plano.slug, planoNome: plano.nome, limiteAutorizacoes: plano.limite, atualizadoEm: new Date().toISOString() }
      });
      res.json({ ok: true });
    } catch(e) { res.status(500).json({ erro: e.message }); }
  }

  // Métricas globais ampliadas
  // NOTA: hoje esta rota nunca é executada — GET /api/admin/metricas já é
  // respondida pelo handler `metricas()` acima, registrado primeiro. Mantido
  // como está (não reordenado nem removido) para preservar o comportamento atual.
  async function metricasAmpliadas(_req, res) {
    const imobs   = await db.imobiliarias.find({});
    const total   = await db.autorizacoes.count({});
    const assinadas = await db.autorizacoes.count({ status: 'assinado' });
    const now = new Date();
    const inicio30 = new Date(now.getFullYear(), now.getMonth(), 1);
    inicio30.setDate(inicio30.getDate() - 30);
    const recentes = await db.autorizacoes.count({ criadoEm: { $gte: inicio30.toISOString() } });

    // Por plano
    const porPlano = {};
    for (const imob of imobs) {
      const slug = imob.planoSlug || 'pro';
      porPlano[slug] = (porPlano[slug] || 0) + 1;
    }

    // Imobiliárias próximas do limite
    const alertas = [];
    for (const imob of imobs.filter(i => i.ativo && i.status === 'ativo')) {
      const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const usadas = await db.autorizacoes.count({ imobiliariaId: imob._id, criadoEm: { $gte: mesInicio } });
      const pct = limiteService.calcularPorcentagem(usadas, imob.limiteAutorizacoes || 0);
      if (pct >= 80) alertas.push({ nome: imob.nome, pct, usadas, limite: imob.limiteAutorizacoes });
    }

    res.json({
      imobiliariasAtivas: imobs.filter(i => i.ativo && i.tipoCliente==='imobiliaria').length,
      corretoresAtivos:   imobs.filter(i => i.ativo && i.tipoCliente==='corretor').length,
      clientesAtivos:     imobs.filter(i => i.ativo).length,
      clientesSuspensos:  imobs.filter(i => i.status==='suspenso').length,
      autorizacoesTotal:  total,
      autorizacoesAssinadas: assinadas,
      autorizacoesUltimos30Dias: recentes,
      porPlano,
      alertasLimite: alertas.sort((a,b) => b.pct - a.pct)
    });
  }

  // Ranking de utilização
  async function ranking(_req, res) {
    const imobs = await db.imobiliarias.find({ ativo: true });
    const now = new Date();
    const mesInicio = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const rankingLista = [];
    for (const imob of imobs) {
      const usadas = await db.autorizacoes.count({ imobiliariaId: imob._id, criadoEm: { $gte: mesInicio } });
      const pct = limiteService.calcularPorcentagem(usadas, imob.limiteAutorizacoes || 0);
      rankingLista.push({ nome: imob.nome, plano: imob.planoNome||'Pro', usadas, limite: imob.limiteAutorizacoes, pct });
    }
    res.json(rankingLista.sort((a,b) => b.usadas - a.usadas).slice(0, 10));
  }

  // Buscar dados da imobiliária pelo slug (para branding no link do proprietário)
  async function buscarPorSlug(req, res) {
    const imob = await db.imobiliarias.findOne({ slug: req.params.slug, ativo: true });
    if (!imob) return res.status(404).json({ erro: 'Imobiliária não encontrada.' });
    // Retorna apenas dados públicos (sem dados sensíveis)
    const { _id, nome, slug, corPrimaria, corSecundaria, endereco } = imob;
    res.json({ _id, nome, slug, corPrimaria, corSecundaria, endereco });
  }

  // Gera token temporário de suporte para uma imobiliária
  async function entrarModoSuporte(req, res) {
    try {
      const imob = await db.imobiliarias.findOne({ _id: req.params.imobId });
      if (!imob) return res.status(404).json({ erro: 'Imobiliária não encontrada.' });

      // Busca o admin principal da imobiliária
      const adminUser = await db.usuarios.findOne({ imobiliariaId: req.params.imobId, role: 'admin', ativo: true });
      if (!adminUser) return res.status(404).json({ erro: 'Admin da imobiliária não encontrado.' });

      // Token de suporte — válido 2h, carrega flag modoSuporte
      const tokenSuporte = jwt.sign({
        userId:            adminUser._id,
        nome:              adminUser.nome,
        email:             adminUser.email,
        role:              'admin',
        imobiliariaId:     imob._id,
        imobiliariaSlug:   imob.slug,
        imobiliariaNome:   imob.nome,
        modoSuporte:       true,
        superAdminId:      req.user.userId,
        superAdminEmail:   req.user.email
      }, JWT_SECRET, { expiresIn: '2h' });

      await log('suporte', `Super admin ${req.user.email} entrou em modo suporte: ${imob.nome}`, null, imob._id);

      res.json({
        ok: true,
        token: tokenSuporte,
        imobiliaria: { nome: imob.nome, slug: imob.slug, email: imob.email }
      });
    } catch(e) { res.status(500).json({ erro: e.message }); }
  }

  return {
    listarImobiliarias, criarImobiliaria, editarImobiliaria, editarImobiliariaCompleto,
    alterarStatusImobiliaria, metricas, listarUsuariosDaImobiliaria, alterarPlanoImobiliaria,
    metricasAmpliadas, ranking, buscarPorSlug, entrarModoSuporte
  };
}

module.exports = createClientesController;
