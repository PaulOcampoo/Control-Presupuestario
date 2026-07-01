'use strict';

const { initSchema } = require('../server/db');
const app = require('../server/app');

// Lazy one-time schema init — runs once per cold start
let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = initSchema();
  return initPromise;
}

module.exports = async (req, res) => {
  await ensureInit();
  return app(req, res);
};
