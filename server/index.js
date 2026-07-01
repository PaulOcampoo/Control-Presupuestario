'use strict';

const os = require('os');
const { initSchema } = require('./db');
const app = require('./app');

const PORT = process.env.PORT || 3000;

initSchema()
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
