const express = require('express');
const createUsuariosController = require('./usuarios.controller');

module.exports = function usuariosRouter({ db, authMiddleware, log, subscriptionService }) {
  const router = express.Router();
  const controller = createUsuariosController({ db, log, subscriptionService });

  router.post('/auth/login', controller.login);
  router.get('/auth/me', authMiddleware(), controller.me);
  router.post('/cadastro', controller.cadastro);

  return router;
};
