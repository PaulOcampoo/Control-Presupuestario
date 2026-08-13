'use strict';

/*
 * Contabilidad Fase 1 (prompt-contabilidad-fase1-cuentas-polizas.md) —
 * catálogo de cuentas contables + registro de pólizas. Silo intencionalmente
 * separado de Finanzas/Erogado Real (diagnóstico Fase 0, punto 4) — sin
 * cruce automático. Gateado por auth.requireContabilidadAccess (whitelist),
 * no por checkPermiso — ver server/auth.js.
 *
 * codigo de cuenta: formato numérico con prefijo por tipo, confirmado con
 * Paul en el diagnóstico Fase 0 — 1xxx=activo, 2xxx=pasivo, 3xxx=capital,
 * 4xxx=ingreso, 5xxx=gasto. El CHECK en server/db.js valida lo mismo a nivel
 * DB; esta validación en código es solo para dar un mensaje de error legible
 * antes de golpear ese CHECK con el texto crudo de Postgres.
 */

const db = require('./db');

const PREFIJO_POR_TIPO = {
  activo: '1',
  pasivo: '2',
  capital: '3',
  ingreso: '4',
  gasto: '5',
};

function validarCodigoParaTipo(codigo, tipo) {
  const prefijo = PREFIJO_POR_TIPO[tipo];
  if (!prefijo || !/^[0-9]{4,}$/.test(codigo) || codigo[0] !== prefijo) {
    const err = new Error(
      `El código debe ser numérico (mínimo 4 dígitos) e iniciar con ${prefijo || '?'} para el tipo '${tipo}' (ej. ${prefijo}101)`
    );
    err.status = 400;
    throw err;
  }
}

async function listCuentas({ tipo, estatus } = {}) {
  const where = [];
  const params = [];
  if (tipo) { params.push(tipo); where.push(`tipo = $${params.length}`); }
  if (estatus) { params.push(estatus); where.push(`estatus = $${params.length}`); }
  const sql = `
    SELECT * FROM cuentas_contables
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY codigo
  `;
  const { rows } = await db.pool.query(sql, params);
  return rows;
}

async function createCuenta({ codigo, nombre, tipo, creado_por }) {
  validarCodigoParaTipo(codigo, tipo);
  const { rows } = await db.pool.query(
    `INSERT INTO cuentas_contables (codigo, nombre, tipo, creado_por) VALUES ($1,$2,$3,$4) RETURNING *`,
    [codigo, nombre, tipo, creado_por]
  );
  return rows[0];
}

// codigo NUNCA se edita — solo nombre y tipo. Si tipo cambia, debe seguir
// siendo compatible con el prefijo del codigo ya existente (inmutable); si
// no, se rechaza pidiendo inactivar + dar de alta una cuenta nueva.
async function updateCuenta(id, { nombre, tipo }) {
  const { rows: actual } = await db.pool.query('SELECT * FROM cuentas_contables WHERE id = $1', [id]);
  if (!actual[0]) return null;
  const tipoFinal = tipo || actual[0].tipo;
  if (tipo) validarCodigoParaTipo(actual[0].codigo, tipoFinal);
  const { rows } = await db.pool.query(
    `UPDATE cuentas_contables SET nombre = COALESCE($1, nombre), tipo = $2 WHERE id = $3 RETURNING *`,
    [nombre?.trim() || null, tipoFinal, id]
  );
  return rows[0] || null;
}

async function setCuentaEstatus(id, estatus) {
  const { rows } = await db.pool.query(
    `UPDATE cuentas_contables SET estatus = $1 WHERE id = $2 RETURNING *`,
    [estatus, id]
  );
  return rows[0] || null;
}

async function listPolizas({ tipo, cuenta_id, project_id, desde, hasta, estatus } = {}) {
  const where = [];
  const params = [];
  if (tipo) { params.push(tipo); where.push(`p.tipo = $${params.length}`); }
  if (cuenta_id) { params.push(cuenta_id); where.push(`p.cuenta_id = $${params.length}`); }
  if (project_id === 'sin-obra') {
    where.push('p.project_id IS NULL');
  } else if (project_id) {
    params.push(project_id); where.push(`p.project_id = $${params.length}`);
  }
  if (desde) { params.push(desde); where.push(`p.fecha >= $${params.length}`); }
  if (hasta) { params.push(hasta); where.push(`p.fecha <= $${params.length}`); }
  if (estatus) { params.push(estatus); where.push(`p.estatus = $${params.length}`); }
  const sql = `
    SELECT p.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre,
           pr.nombre AS project_nombre, u.nombre AS usuario_nombre
    FROM polizas p
    JOIN cuentas_contables c ON c.id = p.cuenta_id
    LEFT JOIN proyectos pr ON pr.id = p.project_id
    LEFT JOIN usuarios u ON u.id = p.usuario_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.fecha DESC, p.id DESC
  `;
  const { rows } = await db.pool.query(sql, params);
  return rows;
}

async function createPoliza({ tipo, fecha, cuenta_id, monto, concepto, referencia_factura, project_id, usuario_id }) {
  const { rows: cuentaRows } = await db.pool.query('SELECT estatus FROM cuentas_contables WHERE id = $1', [cuenta_id]);
  if (!cuentaRows[0]) {
    const err = new Error('La cuenta contable indicada no existe');
    err.status = 400;
    throw err;
  }
  if (cuentaRows[0].estatus !== 'activa') {
    const err = new Error('La cuenta contable indicada está inactiva');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.pool.query(
    `INSERT INTO polizas (tipo, fecha, cuenta_id, monto, concepto, referencia_factura, project_id, usuario_id)
     VALUES ($1,COALESCE($2::date, CURRENT_DATE),$3,$4,$5,$6,$7,$8) RETURNING *`,
    [tipo, fecha || null, cuenta_id, monto, concepto, referencia_factura || null, project_id || null, usuario_id]
  );
  return rows[0];
}

async function cancelarPoliza(id, canceladoPor) {
  const { rows } = await db.pool.query(
    `UPDATE polizas SET estatus = 'cancelada', cancelado_por = $1, cancelado_en = NOW()
     WHERE id = $2 AND estatus != 'cancelada' RETURNING *`,
    [canceladoPor, id]
  );
  return rows[0] || null;
}

module.exports = {
  listCuentas,
  createCuenta,
  updateCuenta,
  setCuentaEstatus,
  listPolizas,
  createPoliza,
  cancelarPoliza,
};
