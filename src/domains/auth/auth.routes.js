const express = require('express');
const createAuthController = require('./auth.controller');

module.exports = function authRouter({ db, authMiddleware, log, subscriptionService }) {
  const router = express.Router();
  const controller = createAuthController({ db, log, subscriptionService });

  router.post('/auth/login', controller.login);
  router.get('/auth/me', authMiddleware(), controller.me);
  router.post('/cadastro', controller.cadastro);

  return router;
};
