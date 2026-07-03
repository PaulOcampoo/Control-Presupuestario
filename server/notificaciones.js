'use strict';

const db = require('./db');

async function crearNotificacion(usuarioId, projectId, tipo, referenciaId, mensaje) {
  const { rows } = await db.pool.query(
    `INSERT INTO notificaciones (usuario_id, project_id, tipo, referencia_id, mensaje)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [usuarioId, projectId, tipo, referenciaId, mensaje]
  );
  return rows[0];
}

// Reusada por fases futuras (impuestos, vencimiento de contrato, requisición
// publicada, OC publicada) para avisar a todos los administradores activos.
async function notificarAdmins(projectId, tipo, referenciaId, mensaje) {
  const { rows: admins } = await db.pool.query(
    "SELECT id FROM usuarios WHERE puesto = 'admin' AND activo = true"
  );
  return Promise.all(admins.map((a) => crearNotificacion(a.id, projectId, tipo, referenciaId, mensaje)));
}

module.exports = { crearNotificacion, notificarAdmins };
