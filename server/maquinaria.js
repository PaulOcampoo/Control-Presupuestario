'use strict';

/*
 * Módulo de Maquinaria propia (prompt-modulo-maquinaria) — catálogo global
 * de equipos (no por obra, igual que Proveedores), combustible y
 * mantenimiento a cargo de taller/admin/desarrollador, horas de uso
 * capturadas por cabo (hoy solo retroexcavadoras), y un presupuesto único
 * para toda la flota.
 *
 * DISEÑO DE PRIMER BORRADOR, pendiente de revisión con Paul:
 *   - Asignación cabo=horas / taller=combustible+mantenimiento.
 *   - presupuesto_maquinaria como monto único sin periodo (no mensual/anual)
 *     por ambigüedad sin resolver — fila singleton (id=1).
 *   - Umbral de alerta de presupuesto fijo en 90% (ALERTA_PRESUPUESTO_PCT).
 */

const db = require('./db');

const ALERTA_PRESUPUESTO_PCT = 90;

async function listEquipos() {
  const { rows } = await db.pool.query(`
    SELECT e.*, p.nombre AS obra_nombre
    FROM equipos_maquinaria e
    LEFT JOIN proyectos p ON p.id = e.obra_id
    WHERE e.activo = true
    ORDER BY e.nombre
  `);
  return rows;
}

async function createEquipo({ nombre, tipo, identificador, estado, obra_id }) {
  const { rows } = await db.pool.query(
    `INSERT INTO equipos_maquinaria (nombre, tipo, identificador, estado, obra_id)
     VALUES ($1, $2, $3, COALESCE($4, 'activo'), $5) RETURNING *`,
    [nombre, tipo || 'retroexcavadora', identificador || null, estado, obra_id || null]
  );
  return rows[0];
}

async function updateEquipo(id, { nombre, tipo, identificador, estado, obra_id }) {
  const { rows } = await db.pool.query(
    `UPDATE equipos_maquinaria SET
       nombre = COALESCE($1, nombre),
       tipo = COALESCE($2, tipo),
       identificador = COALESCE($3, identificador),
       estado = COALESCE($4, estado),
       obra_id = $5
     WHERE id = $6 AND activo = true RETURNING *`,
    [nombre || null, tipo || null, identificador || null, estado || null, obra_id ?? null, id]
  );
  return rows[0];
}

async function softDeleteEquipo(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE equipos_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

async function listCombustible(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT c.*, e.nombre AS equipo_nombre, u.nombre AS registrado_por_nombre
    FROM combustible_maquinaria c
    JOIN equipos_maquinaria e ON e.id = c.equipo_id
    LEFT JOIN usuarios u ON u.id = c.registrado_por
    WHERE c.activo = true ${equipoId ? 'AND c.equipo_id = $1' : ''}
    ORDER BY c.fecha DESC, c.id DESC
  `, equipoId ? [equipoId] : []);
  return rows;
}

async function createCombustible({ equipo_id, fecha, litros, costo, registrado_por }) {
  const { rows } = await db.pool.query(
    `INSERT INTO combustible_maquinaria (equipo_id, fecha, litros, costo, registrado_por)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [equipo_id, fecha, litros, costo, registrado_por]
  );
  return rows[0];
}

async function softDeleteCombustible(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE combustible_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

async function listMantenimientos(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT m.*, e.nombre AS equipo_nombre, u.nombre AS registrado_por_nombre
    FROM mantenimientos_maquinaria m
    JOIN equipos_maquinaria e ON e.id = m.equipo_id
    LEFT JOIN usuarios u ON u.id = m.registrado_por
    WHERE m.activo = true ${equipoId ? 'AND m.equipo_id = $1' : ''}
    ORDER BY m.fecha DESC, m.id DESC
  `, equipoId ? [equipoId] : []);
  return rows;
}

async function createMantenimiento({ equipo_id, fecha, tipo, descripcion, costo, proveedor, registrado_por }) {
  const { rows } = await db.pool.query(
    `INSERT INTO mantenimientos_maquinaria (equipo_id, fecha, tipo, descripcion, costo, proveedor, registrado_por)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [equipo_id, fecha, tipo, descripcion || null, costo, proveedor || null, registrado_por]
  );
  return rows[0];
}

async function softDeleteMantenimiento(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE mantenimientos_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

async function listHoras(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT h.*, e.nombre AS equipo_nombre, u.nombre AS operador_nombre, p.nombre AS obra_nombre
    FROM reportes_horas_maquinaria h
    JOIN equipos_maquinaria e ON e.id = h.equipo_id
    LEFT JOIN usuarios u ON u.id = h.operador_id
    LEFT JOIN proyectos p ON p.id = h.obra_id
    WHERE h.activo = true ${equipoId ? 'AND h.equipo_id = $1' : ''}
    ORDER BY h.fecha DESC, h.id DESC
  `, equipoId ? [equipoId] : []);
  return rows;
}

async function createHoras({ equipo_id, operador_id, fecha, horas, obra_id }) {
  const { rows } = await db.pool.query(
    `INSERT INTO reportes_horas_maquinaria (equipo_id, operador_id, fecha, horas, obra_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [equipo_id, operador_id, fecha, horas, obra_id || null]
  );
  return rows[0];
}

async function softDeleteHoras(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE reportes_horas_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

async function getResumen() {
  const { rows: presRows } = await db.pool.query('SELECT monto_total FROM presupuesto_maquinaria WHERE id = 1');
  const montoTotal = Number(presRows[0]?.monto_total || 0);
  const { rows: gastoRows } = await db.pool.query(`
    SELECT
      COALESCE((SELECT SUM(costo) FROM combustible_maquinaria WHERE activo = true), 0) AS combustible,
      COALESCE((SELECT SUM(costo) FROM mantenimientos_maquinaria WHERE activo = true), 0) AS mantenimiento
  `);
  const gastoCombustible = Number(gastoRows[0].combustible);
  const gastoMantenimiento = Number(gastoRows[0].mantenimiento);
  const gastoTotal = gastoCombustible + gastoMantenimiento;
  const pctGastado = montoTotal > 0 ? (gastoTotal / montoTotal) * 100 : 0;
  return {
    monto_total: montoTotal,
    gasto_combustible: gastoCombustible,
    gasto_mantenimiento: gastoMantenimiento,
    gasto_total: gastoTotal,
    pct_gastado: pctGastado,
    alerta: pctGastado >= ALERTA_PRESUPUESTO_PCT,
    umbral_alerta_pct: ALERTA_PRESUPUESTO_PCT,
  };
}

async function updatePresupuesto(montoTotal) {
  const { rows } = await db.pool.query(
    `UPDATE presupuesto_maquinaria SET monto_total = $1, actualizado_en = NOW() WHERE id = 1 RETURNING *`,
    [montoTotal]
  );
  return rows[0];
}

module.exports = {
  listEquipos, createEquipo, updateEquipo, softDeleteEquipo,
  listCombustible, createCombustible, softDeleteCombustible,
  listMantenimientos, createMantenimiento, softDeleteMantenimiento,
  listHoras, createHoras, softDeleteHoras,
  getResumen, updatePresupuesto,
};
