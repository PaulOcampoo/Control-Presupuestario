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

// Presupuesto SUGERIDO de maquinaria (prompt-maquinaria-presupuesto-automatico,
// Fase 2) — no reemplaza el monto manual de presupuesto_maquinaria, solo lo
// prellena. Confirmado con Paul (Fase 1):
//   - Fuente primaria: SUM(insumos.importe_presupuesto) WHERE categoria =
//     'EQUIPO Y HERRAMIENTA', por obra.
//   - Respaldo: si esa suma da 0 (o la obra no tiene filas de esa
//     categoría), usar meta.subtotal_herramienta_equipo si existe para esa
//     obra — es un valor ya confirmado alguna vez vía el flujo de extracción
//     de contrato, independiente de si el PDF sigue en la tabla `contratos`.
// Cada obra queda marcada con su `fuente` ('insumos'|'meta'|'ninguno') para
// que el frontend pueda indicar cuándo un monto vino del respaldo — es
// dinero real que ve el cliente, debe quedar trazable de dónde salió.
async function getPresupuestoSugerido() {
  const { rows } = await db.pool.query(`
    SELECT p.id AS project_id, p.nombre AS obra, p.cliente_id, c.nombre AS cliente,
      COALESCE((
        SELECT SUM(i.importe_presupuesto) FROM insumos i
        WHERE i.project_id = p.id AND i.categoria = 'EQUIPO Y HERRAMIENTA'
      ), 0) AS suma_insumos,
      (SELECT valor FROM meta m WHERE m.project_id = p.id AND m.clave = 'subtotal_herramienta_equipo') AS meta_valor
    FROM proyectos p
    LEFT JOIN clientes c ON c.id = p.cliente_id
    ORDER BY c.nombre NULLS LAST, p.nombre
  `);

  const obras = rows.map((r) => {
    const sumaInsumos = Number(r.suma_insumos) || 0;
    let monto = sumaInsumos;
    let fuente = 'insumos';
    if (sumaInsumos <= 0) {
      if (r.meta_valor != null && Number(r.meta_valor) > 0) {
        monto = Number(r.meta_valor);
        fuente = 'meta';
      } else {
        monto = 0;
        fuente = 'ninguno';
      }
    }
    return {
      project_id: r.project_id, obra: r.obra,
      cliente_id: r.cliente_id, cliente: r.cliente || 'Sin cliente asignado',
      monto, fuente,
    };
  });

  const porClienteMap = new Map();
  for (const o of obras) {
    const key = o.cliente_id ?? 'sin_cliente';
    if (!porClienteMap.has(key)) {
      porClienteMap.set(key, { cliente_id: o.cliente_id, cliente: o.cliente, monto: 0, fuente_mixta: false, obras: [] });
    }
    const entry = porClienteMap.get(key);
    entry.monto += o.monto;
    entry.obras.push(o);
    if (o.fuente === 'meta') entry.fuente_mixta = true;
  }

  const porCliente = [...porClienteMap.values()].sort((a, b) => a.cliente.localeCompare(b.cliente));
  const totalSugerido = porCliente.reduce((s, c) => s + c.monto, 0);
  const fuenteMixtaGlobal = porCliente.some((c) => c.fuente_mixta);
  return { total_sugerido: totalSugerido, fuente_mixta: fuenteMixtaGlobal, por_cliente: porCliente };
}

// Reporte de Maquinaria por cliente (Fase 2): presupuesto sugerido (arriba)
// vs. gasto real (combustible + mantenimiento) de los equipos actualmente
// asignados a obras de ese cliente. Limitación conocida: el gasto se
// atribuye según la obra ACTUAL del equipo (equipos_maquinaria.obra_id) —
// si un equipo cambió de obra después de que se le cargó combustible, ese
// gasto histórico queda con la obra/cliente de HOY, no la de cuando se
// generó. Es la única relación equipo↔obra↔cliente que existe hoy.
async function getReportePorCliente() {
  const sugerido = await getPresupuestoSugerido();
  const sugeridoPorCliente = new Map(sugerido.por_cliente.map((c) => [c.cliente_id, c]));

  const { rows: clientes } = await db.pool.query('SELECT id, nombre FROM clientes ORDER BY nombre');
  const porCliente = [];
  for (const cliente of clientes) {
    const { rows: gastoRows } = await db.pool.query(`
      SELECT
        COALESCE((
          SELECT SUM(cm.costo) FROM combustible_maquinaria cm
          JOIN equipos_maquinaria e ON e.id = cm.equipo_id
          JOIN proyectos p ON p.id = e.obra_id
          WHERE p.cliente_id = $1 AND cm.activo = true
        ), 0) AS gasto_combustible,
        COALESCE((
          SELECT SUM(mm.costo) FROM mantenimientos_maquinaria mm
          JOIN equipos_maquinaria e ON e.id = mm.equipo_id
          JOIN proyectos p ON p.id = e.obra_id
          WHERE p.cliente_id = $1 AND mm.activo = true
        ), 0) AS gasto_mantenimiento
    `, [cliente.id]);
    const sug = sugeridoPorCliente.get(cliente.id);
    const gastoCombustible = Number(gastoRows[0].gasto_combustible);
    const gastoMantenimiento = Number(gastoRows[0].gasto_mantenimiento);
    porCliente.push({
      cliente_id: cliente.id,
      cliente: cliente.nombre,
      presupuesto_sugerido: sug?.monto || 0,
      fuente_mixta: sug?.fuente_mixta || false,
      gasto_combustible: gastoCombustible,
      gasto_mantenimiento: gastoMantenimiento,
      gasto_total: gastoCombustible + gastoMantenimiento,
    });
  }

  // Gasto de equipos sin obra asignada — no atribuible a ningún cliente.
  const { rows: sinObraRows } = await db.pool.query(`
    SELECT
      COALESCE((
        SELECT SUM(cm.costo) FROM combustible_maquinaria cm
        JOIN equipos_maquinaria e ON e.id = cm.equipo_id
        WHERE e.obra_id IS NULL AND cm.activo = true
      ), 0) AS gasto_combustible,
      COALESCE((
        SELECT SUM(mm.costo) FROM mantenimientos_maquinaria mm
        JOIN equipos_maquinaria e ON e.id = mm.equipo_id
        WHERE e.obra_id IS NULL AND mm.activo = true
      ), 0) AS gasto_mantenimiento
  `);
  const sinObraCombustible = Number(sinObraRows[0].gasto_combustible);
  const sinObraMantenimiento = Number(sinObraRows[0].gasto_mantenimiento);

  return {
    total_sugerido: sugerido.total_sugerido,
    fuente_mixta: sugerido.fuente_mixta,
    por_cliente: porCliente,
    sin_obra_asignada: {
      gasto_combustible: sinObraCombustible,
      gasto_mantenimiento: sinObraMantenimiento,
      gasto_total: sinObraCombustible + sinObraMantenimiento,
    },
  };
}

module.exports = {
  listEquipos, createEquipo, updateEquipo, softDeleteEquipo,
  listCombustible, createCombustible, softDeleteCombustible,
  listMantenimientos, createMantenimiento, softDeleteMantenimiento,
  listHoras, createHoras, softDeleteHoras,
  getResumen, updatePresupuesto,
  getPresupuestoSugerido, getReportePorCliente,
};
