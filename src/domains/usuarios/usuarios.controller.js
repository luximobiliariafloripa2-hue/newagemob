const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../../config/env');

function createUsuariosController({ db, log, subscriptionService }) {

  async function login(req, res) {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(422).json({ erro: 'E-mail e senha são obrigatórios.' });
    const user = await db.usuarios.findOne({ email: email.toLowerCase().trim(), ativo: true });
    if (!user) return res.status(401).json({ erro: 'Credenciais inválidas.' });
    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).json({ erro: 'Credenciais inválidas.' });

    let imobiliaria = null;
    if (user.imobiliariaId) {
      imobiliaria = await db.imobiliarias.findOne({ _id: user.imobiliariaId });
    }

    const token = jwt.sign({
      userId:          user._id,
      nome:            user.nome,
      email:           user.email,
      role:            user.role,
      imobiliariaId:   user.imobiliariaId   || null,
      imobiliariaSlug: user.imobiliariaSlug || null,
      imobiliariaNome: imobiliaria?.nome    || null
    }, JWT_SECRET, { expiresIn: '8h' });

    await log('auth', `Login: ${user.email} (${user.role})`, null, user.imobiliariaId);
    res.json({ token, user: { nome: user.nome, email: user.email, role: user.role, imobiliaria } });
  }

  async function me(req, res) {
    const user = await db.usuarios.findOne({ _id: req.user.userId });
    if (!user) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    const { senha, ...safe } = user;
    res.json(safe);
  }

  async function cadastro(req, res) {
    try {
      const { nome, cnpj, responsavel, email, telefone, whatsapp, senha } = req.body;
      if (!nome || !cnpj || !email || !senha || !responsavel)
        return res.status(422).json({ erro: 'Preencha todos os campos obrigatorios.' });
      if (senha.length < 6)
        return res.status(422).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });

      const cnpjLimpo = cnpj.replace(/\D/g, '');
      const exEmail = await db.usuarios.findOne({ email: email.toLowerCase().trim() });
      if (exEmail) return res.status(422).json({ erro: 'E-mail ja cadastrado.' });

      const plano = await db.planos.findOne({ slug: 'basic' });
      const slugBase = nome.toLowerCase().normalize('NFD')
        .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const slug = slugBase + '-' + Date.now().toString(36);

      const imob = await db.imobiliarias.insert({
        tipoCliente:'imobiliaria', nome, razaoSocial:nome, nomeFantasia:nome,
        slug, cnpj, email, telefone:telefone||'', whatsapp:whatsapp||'',
        responsavel:{ nome:responsavel, email },
        corPrimaria:'#04273B', corSecundaria:'#C9A227',
        planoId:plano?._id||null, planoSlug:'basic', planoNome:'Basic',
        limiteAutorizacoes:1, creditosExtras:0,
        status:'ativo', ativo:true, origem:'landing',
        criadoEm:new Date().toISOString(), atualizadoEm:new Date().toISOString()
      });

      const hash = await bcrypt.hash(senha, 10);
      await db.usuarios.insert({
        nome:responsavel, email:email.toLowerCase().trim(), senha:hash,
        role:'admin', imobiliariaId:imob._id, imobiliariaSlug:slug,
        ativo:true, criadoEm:new Date().toISOString()
      });

      await log('cadastro', `Nova imobiliaria via landing: ${nome} (${email})`);
      // Cria subscription trial
      try { await subscriptionService.criar(imob._id, plano?._id, 'trial'); } catch(e) { /* non-fatal */ }

      const token = jwt.sign({
        userId:imob._id, nome:responsavel, email:email.toLowerCase().trim(),
        role:'admin', imobiliariaId:imob._id, imobiliariaSlug:slug, imobiliariaNome:nome
      }, JWT_SECRET, { expiresIn:'8h' });

      res.json({ ok:true, token, imobiliaria:{ nome, slug, plano:'Basic', limite:1 } });
    } catch(e) {
      res.status(500).json({ erro: 'Falha ao criar conta. Tente novamente.' });
    }
  }

  return { login, me, cadastro };
}

module.exports = createUsuariosController;
