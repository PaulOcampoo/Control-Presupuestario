'use strict';

const { initSchema } = require('../server/db');
const { ensureBootstrapAdmin } = require('../server/auth');
const app = require('../server/app');

// Lazy one-time schema init — runs once per cold start.
// Si initSchema falla (ej. Neon en cold-start excede el timeout), se
// resetea initPromise para que el siguiente request reintente en vez
// de reusar la promesa rechazada y fallar permanentemente hasta el
// próximo cold-start de la función.
let initPromise = null;
function ensureInit() {
  if (!initPromise) {
    initPromise = initSchema()
      .then(() => ensureBootstrapAdmin())
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

module.exports = async (req, res) => {
  await ensureInit();
  return app(req, res);
};
