const express = require('express');
const createClientesController = require('./clientes.controller');

module.exports = function clientesRouter({ db, authMiddleware, log, limiteService }) {
  const router = express.Router();
  const controller = createClientesController({ db, log, limiteService });

  router.get('/admin/imobiliarias', authMiddleware(['super_admin']), controller.listarImobiliarias);
  router.post('/admin/imobiliarias', authMiddleware(['super_admin']), controller.criarImobiliaria);
  router.put('/admin/imobiliarias/:id', authMiddleware(['super_admin']), controller.editarImobiliaria);
  router.patch('/admin/imobiliarias/:id', authMiddleware(['super_admin']), controller.editarImobiliariaCompleto);
  router.patch('/admin/imobiliarias/:id/status', authMiddleware(['super_admin']), controller.alterarStatusImobiliaria);

  // Primeira definição vence — Express não repassa para a segunda (ver clientes.controller.js)
  router.get('/admin/metricas', authMiddleware(['super_admin']), controller.metricas);

  router.get('/admin/imobiliarias/:id/usuarios', authMiddleware(['super_admin']), controller.listarUsuariosDaImobiliaria);
  router.patch('/admin/imobiliarias/:id/plano', authMiddleware(['super_admin']), controller.alterarPlanoImobiliaria);

  // Duplicata — nunca executa (path já respondido acima); mantida por fidelidade ao original
  router.get('/admin/metricas', authMiddleware(['super_admin']), controller.metricasAmpliadas);

  router.get('/admin/ranking', authMiddleware(['super_admin']), controller.ranking);
  router.get('/imobiliaria/:slug', controller.buscarPorSlug);
  router.post('/admin/suporte/:imobId', authMiddleware(['super_admin']), controller.entrarModoSuporte);

  return router;
};
