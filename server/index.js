'use strict';

const os = require('os');
const { initSchema } = require('./db');
const { ensureBootstrapAdmin } = require('./auth');
const app = require('./app');

const PORT = process.env.PORT || 3000;

// Medición básica de performance (prompt-cerrar-gaps-mayores.md, Punto 4):
// tiempo de initSchema() en cada arranque — da visibilidad sobre el deadlock
// ya documentado en Notion sin resolverlo aquí (fuera de alcance de este
// prompt), y sobre cold starts lentos en general.
const initSchemaStart = Date.now();
initSchema()
  .then(() => {
    console.log(`[perf] initSchema() tardó ${Date.now() - initSchemaStart}ms`);
  })
  .then(() => ensureBootstrapAdmin())
  .then(() => {
    app.listen(PORT, () => {
      const nets = os.networkInterfaces();
      const lan = Object.values(nets).flat().find((n) => n && n.family === 'IPv4' && !n.internal);
      console.log('\nControl presupuestal escuchando en:');
      console.log(`  Local:        http://localhost:${PORT}`);
      if (lan) console.log(`  Red/Telefono: http://${lan.address}:${PORT}`);
      console.log('');
    });
  })
  .catch((err) => {
    console.error('Error al inicializar la base de datos:', err.message);
    process.exit(1);
  });
