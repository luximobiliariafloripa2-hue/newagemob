const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');

/**
 * Recebe DATA_DIR já resolvido pelo server.js (raiz do projeto) — evita
 * recalcular __dirname aqui dentro, o que apontaria para src/config.
 */
function createDatabase(DATA_DIR) {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  return {
    imobiliarias:        Datastore.create({ filename: path.join(DATA_DIR, 'imobiliarias.db'),        autoload: true }),
    usuarios:            Datastore.create({ filename: path.join(DATA_DIR, 'usuarios.db'),            autoload: true }),
    autorizacoes:        Datastore.create({ filename: path.join(DATA_DIR, 'autorizacoes.db'),        autoload: true }),
    planos:              Datastore.create({ filename: path.join(DATA_DIR, 'planos.db'),              autoload: true }),
    pacotes:             Datastore.create({ filename: path.join(DATA_DIR, 'pacotes.db'),             autoload: true }),
    compras:             Datastore.create({ filename: path.join(DATA_DIR, 'compras.db'),             autoload: true }),
    subscriptions:       Datastore.create({ filename: path.join(DATA_DIR, 'subscriptions.db'),       autoload: true }),
    subscription_history:Datastore.create({ filename: path.join(DATA_DIR, 'subscription_history.db'),autoload: true }),
    billing_transactions:Datastore.create({ filename: path.join(DATA_DIR, 'billing_transactions.db'),autoload: true }),
    boletos:             Datastore.create({ filename: path.join(DATA_DIR, 'boletos.db'),             autoload: true }),
    config:              Datastore.create({ filename: path.join(DATA_DIR, 'config.db'),              autoload: true }),
    logs:                Datastore.create({ filename: path.join(DATA_DIR, 'logs.db'),                autoload: true })
  };
}

module.exports = { createDatabase };
