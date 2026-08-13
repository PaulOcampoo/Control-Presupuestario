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

/*
 * Contabilidad Fase 3 (prompt-contabilidad-fase3-conciliacion.md) —
 * cuentas bancarias corporativas + importación/conciliación de movimientos
 * bancarios. COMPLETAMENTE separado de cuentas_control/movimientos_control
 * (control personal de saldo de Paul/Fer) — nunca reusar esas tablas aquí,
 * confirmado en diagnóstico Fase 3.
 */

async function listCuentasBancarias({ activo } = {}) {
  const where = [];
  const params = [];
  if (activo != null) { params.push(activo === 'true' || activo === true); where.push(`activo = $${params.length}`); }
  const { rows } = await db.pool.query(
    `SELECT * FROM cuentas_bancarias ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY nombre`,
    params
  );
  return rows;
}

async function createCuentaBancaria({ nombre, banco, numero_cuenta }) {
  const { rows } = await db.pool.query(
    `INSERT INTO cuentas_bancarias (nombre, banco, numero_cuenta) VALUES ($1,$2,$3) RETURNING *`,
    [nombre, banco || null, numero_cuenta || null]
  );
  return rows[0];
}

async function updateCuentaBancaria(id, { nombre, banco, numero_cuenta, activo }) {
  const { rows } = await db.pool.query(
    `UPDATE cuentas_bancarias SET
       nombre = COALESCE($1, nombre),
       banco = COALESCE($2, banco),
       numero_cuenta = COALESCE($3, numero_cuenta),
       activo = COALESCE($4, activo)
     WHERE id = $5 RETURNING *`,
    [nombre?.trim() || null, banco?.trim() || null, numero_cuenta?.trim() || null, activo, id]
  );
  return rows[0] || null;
}

// Separa las filas ya parseadas en nuevas vs. ya existentes según el mismo
// criterio del UNIQUE compuesto (cuenta_bancaria_id, fecha, monto,
// descripcion) — el preview nunca escribe, solo informa qué pasaría.
async function diffMovimientosImportacion(cuentaBancariaId, movimientos) {
  if (!movimientos.length) return { nuevos: [], yaExistentes: [] };
  const { rows: existentes } = await db.pool.query(
    `SELECT fecha, monto, descripcion FROM movimientos_bancarios WHERE cuenta_bancaria_id = $1`,
    [cuentaBancariaId]
  );
  const clave = (m) => `${m.fecha}|${Number(m.monto).toFixed(2)}|${m.descripcion}`;
  const existentesSet = new Set(existentes.map((e) => clave({ ...e, fecha: String(e.fecha).slice(0, 10) })));
  const nuevos = [];
  const yaExistentes = [];
  for (const m of movimientos) {
    (existentesSet.has(clave(m)) ? yaExistentes : nuevos).push(m);
  }
  return { nuevos, yaExistentes };
}

// Inserta dentro de una transacción con ON CONFLICT DO NOTHING — reimportar
// el mismo archivo (o uno con filas repetidas) es un no-op seguro para las
// filas repetidas, nunca un error ni un duplicado.
async function confirmarImportacionMovimientos(cuentaBancariaId, movimientos, importadoPor) {
  return db.withTransaction(async (client) => {
    let insertados = 0;
    for (const m of movimientos) {
      const { rows } = await client.query(
        `INSERT INTO movimientos_bancarios (cuenta_bancaria_id, fecha, descripcion, monto, tipo, importado_por)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cuenta_bancaria_id, fecha, monto, descripcion) DO NOTHING
         RETURNING id`,
        [cuentaBancariaId, m.fecha, m.descripcion, m.monto, m.tipo, importadoPor]
      );
      if (rows[0]) insertados += 1;
    }
    return { insertados, omitidos: movimientos.length - insertados };
  });
}

// Sugerencia de póliza (diagnóstico Fase 3, punto 3): mismo monto exacto,
// fecha dentro de ±3 días, póliza activa y que ningún otro movimiento ya
// haya usado — nunca auto-concilia, solo se muestra como sugerencia visual
// para que el usuario confirme o elija otra.
async function listMovimientos({ cuenta_bancaria_id, estatus, desde, hasta } = {}) {
  const where = [];
  const params = [];
  if (cuenta_bancaria_id) { params.push(cuenta_bancaria_id); where.push(`m.cuenta_bancaria_id = $${params.length}`); }
  if (estatus) { params.push(estatus); where.push(`m.estatus = $${params.length}`); }
  if (desde) { params.push(desde); where.push(`m.fecha >= $${params.length}`); }
  if (hasta) { params.push(hasta); where.push(`m.fecha <= $${params.length}`); }
  const sql = `
    SELECT m.*, cb.nombre AS cuenta_nombre,
           pz.concepto AS poliza_concepto, pz.fecha AS poliza_fecha, pz.monto AS poliza_monto,
           sug.id AS sugerencia_poliza_id, sug.concepto AS sugerencia_concepto,
           sug.fecha AS sugerencia_fecha, sug.monto AS sugerencia_monto
    FROM movimientos_bancarios m
    JOIN cuentas_bancarias cb ON cb.id = m.cuenta_bancaria_id
    LEFT JOIN polizas pz ON pz.id = m.poliza_id
    LEFT JOIN LATERAL (
      SELECT p2.id, p2.concepto, p2.fecha, p2.monto
      FROM polizas p2
      WHERE p2.estatus = 'activa'
        AND p2.monto = m.monto
        AND p2.fecha BETWEEN m.fecha - INTERVAL '3 days' AND m.fecha + INTERVAL '3 days'
        AND NOT EXISTS (SELECT 1 FROM movimientos_bancarios m2 WHERE m2.poliza_id = p2.id)
      ORDER BY ABS(p2.fecha - m.fecha)
      LIMIT 1
    ) sug ON m.estatus = 'pendiente'
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m.fecha DESC, m.id DESC
  `;
  const { rows } = await db.pool.query(sql, params);
  return rows;
}

async function conciliarMovimiento(id, polizaId, conciliadoPor) {
  const { rows: polizaRows } = await db.pool.query('SELECT estatus FROM polizas WHERE id = $1', [polizaId]);
  if (!polizaRows[0]) {
    const err = new Error('La póliza indicada no existe');
    err.status = 400;
    throw err;
  }
  if (polizaRows[0].estatus !== 'activa') {
    const err = new Error('La póliza indicada está cancelada');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.pool.query(
    `UPDATE movimientos_bancarios SET poliza_id = $1, estatus = 'conciliado', conciliado_por = $2, conciliado_en = NOW()
     WHERE id = $3 AND estatus = 'pendiente' RETURNING *`,
    [polizaId, conciliadoPor, id]
  );
  return rows[0] || null;
}

async function desconciliarMovimiento(id) {
  const { rows } = await db.pool.query(
    `UPDATE movimientos_bancarios SET poliza_id = NULL, estatus = 'pendiente', conciliado_por = NULL, conciliado_en = NULL
     WHERE id = $1 AND estatus = 'conciliado' RETURNING *`,
    [id]
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
  listCuentasBancarias,
  createCuentaBancaria,
  updateCuentaBancaria,
  diffMovimientosImportacion,
  confirmarImportacionMovimientos,
  listMovimientos,
  conciliarMovimiento,
  desconciliarMovimiento,
};
