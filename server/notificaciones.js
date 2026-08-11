'use strict';

const db = require('./db');

// Los 9 tipos reales encontrados en server/app.js (crearNotificacion()/
// notificarAdmins()) agrupados por categoría para la UI de preferencias
// (prompt-fase2-notificaciones-sesiones.md). 'estimacion_rechazada' no encaja
// en 'Aprobaciones pendientes' (no es algo pendiente de aprobar, es un aviso
// de rechazo al residente) ni en 'Vencimientos' — va en 'Otras' en vez de
// forzarla a una categoría que no le corresponde.
const CATEGORIAS_NOTIFICACION = {
  aprobaciones_pendientes: {
    label: 'Aprobaciones pendientes',
    tipos: {
      requisicion_pendiente: 'Requisición pendiente de autorización',
      oc_pendiente: 'Orden de compra pendiente de autorización',
      avance_pendiente: 'Avance semanal pendiente de autorización',
      destajo_pendiente: 'Avance de destajo pendiente de autorización',
      estimacion_pendiente: 'Estimación pendiente de aprobación',
      maquinaria_horas_pendiente: 'Reporte de horas de maquinaria pendiente',
    },
  },
  vencimientos_contratos: {
    label: 'Vencimientos y contratos',
    tipos: {
      recordatorio_impuestos: 'Recordatorio de pago de impuestos',
      contrato_por_vencer: 'Contrato próximo a vencer',
    },
  },
  otras: {
    label: 'Otras',
    tipos: {
      estimacion_rechazada: 'Estimación rechazada',
    },
  },
};

// Mismo set de 9 tipos, aplanado — usado para validar el PUT de preferencias
// sin depender de la estructura de categorías.
const TODOS_LOS_TIPOS = Object.values(CATEGORIAS_NOTIFICACION).flatMap((c) => Object.keys(c.tipos));

// prompt-44-critico-operadores-bloqueados.md: qué puestos REALMENTE pueden
// recibir cada tipo — espejo exacto de los destinatarios reales cableados en
// server/app.js (notificarAdmins()/crearNotificacion() de cada endpoint), NO
// una lista aspiracional. GET /api/notificaciones/preferencias usa este mapa
// para no mostrarle a un usuario categorías que nunca le van a aplicar (bug
// real: un operador veía las 8 categorías/tipos de "Aprobaciones pendientes"
// + "Vencimientos y contratos" pese a que ninguna de las dos aplica al rol
// operador — el GET devolvía el catálogo completo sin filtrar por puesto).
// admin/desarrollador NO necesitan entrada aquí: ven el catálogo completo
// siempre (mismo bypass superusuario que el resto de la app), sin importar
// si notificarAdmins() hoy solo consulta puesto='admin' literal.
const ROLES_POR_TIPO = {
  requisicion_pendiente: ['admin'],
  oc_pendiente: ['admin'],
  avance_pendiente: ['admin'],
  destajo_pendiente: ['admin'],
  estimacion_pendiente: ['admin'],
  maquinaria_horas_pendiente: ['cabo'],
  recordatorio_impuestos: ['admin'],
  contrato_por_vencer: ['admin', 'residente'],
  estimacion_rechazada: ['residente'],
};

// Sin fila en notificacion_preferencias para (usuarioId, tipo) = activado por
// default (no romper el comportamiento actual para usuarios existentes).
async function tipoHabilitado(usuarioId, tipo) {
  const { rows } = await db.pool.query(
    'SELECT activo FROM notificacion_preferencias WHERE usuario_id = $1 AND tipo = $2',
    [usuarioId, tipo]
  );
  return rows.length === 0 ? true : rows[0].activo;
}

// Gate centralizado: todo el envío de notificaciones pasa por aquí (incluido
// notificarAdmins(), que llama a esta misma función por cada admin) — un solo
// punto para respetar la preferencia del usuario antes de insertar.
async function crearNotificacion(usuarioId, projectId, tipo, referenciaId, mensaje) {
  if (!(await tipoHabilitado(usuarioId, tipo))) return null;
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

module.exports = {
  crearNotificacion, notificarAdmins, tipoHabilitado,
  CATEGORIAS_NOTIFICACION, TODOS_LOS_TIPOS, ROLES_POR_TIPO,
};
