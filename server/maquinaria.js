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

// operadorId: cuando viene (rol operador real, nunca "Vista como" — el
// backend usa el JWT real, ver prompt-p2-aislamiento-operador.md), filtra en
// la propia consulta SQL a solo las máquinas asignadas a ese operador — no
// se filtra en el frontend ni con un WHERE posterior en JS.
async function listEquipos(operadorId = null) {
  const { rows } = await db.pool.query(`
    SELECT e.*, p.nombre AS obra_nombre, c.nombre AS cliente_asignado_nombre, u.nombre AS operador_asignado_nombre
    FROM equipos_maquinaria e
    LEFT JOIN proyectos p ON p.id = e.obra_id
    LEFT JOIN clientes c ON c.id = e.cliente_asignado_id
    LEFT JOIN usuarios u ON u.id = e.operador_asignado_id
    WHERE e.activo = true ${operadorId ? 'AND e.operador_asignado_id = $1' : ''}
    ORDER BY e.nombre
  `, operadorId ? [operadorId] : []);
  return rows;
}

// Lectura individual — usada por GET /api/maquinaria/equipos/:id, que además
// del 404 (no existe) valida 403 (operador pidiendo una máquina ajena) sin
// exponer el objeto en ese caso.
async function getEquipoById(id) {
  const { rows } = await db.pool.query(`
    SELECT e.*, p.nombre AS obra_nombre, c.nombre AS cliente_asignado_nombre, u.nombre AS operador_asignado_nombre
    FROM equipos_maquinaria e
    LEFT JOIN proyectos p ON p.id = e.obra_id
    LEFT JOIN clientes c ON c.id = e.cliente_asignado_id
    LEFT JOIN usuarios u ON u.id = e.operador_asignado_id
    WHERE e.id = $1 AND e.activo = true
  `, [id]);
  return rows[0];
}

// Reasignación de cliente (prompt-a-maquinaria-por-cliente.md): un solo
// UPDATE alcanza para "quitar del cliente anterior" porque es un único
// valor por equipo, nunca una relación muchos-a-muchos.
async function asignarClienteEquipo(id, cliente_id) {
  const { rows } = await db.pool.query(
    `UPDATE equipos_maquinaria SET cliente_asignado_id = $1
     WHERE id = $2 AND activo = true RETURNING *`,
    [cliente_id ?? null, id]
  );
  return rows[0];
}

// Asignación de operador (prompt-p2-aislamiento-operador.md) — mismo patrón
// que asignarClienteEquipo: un solo UPDATE, un solo valor por equipo (no
// tabla puente), nullable/reasignable en cualquier momento. Independiente de
// cliente_asignado_id y de obra_id — no los toca ni los deriva.
async function asignarOperadorEquipo(id, operador_id) {
  const { rows } = await db.pool.query(
    `UPDATE equipos_maquinaria SET operador_asignado_id = $1
     WHERE id = $2 AND activo = true RETURNING *`,
    [operador_id ?? null, id]
  );
  return rows[0];
}

async function createEquipo({ nombre, tipo, identificador, estado, obra_id, categoria_uso }) {
  const { rows } = await db.pool.query(
    `INSERT INTO equipos_maquinaria (nombre, tipo, identificador, estado, obra_id, categoria_uso)
     VALUES ($1, $2, $3, COALESCE($4, 'activo'), $5, COALESCE($6, 'pesada')) RETURNING *`,
    [nombre, tipo || 'retroexcavadora', identificador || null, estado, obra_id || null, categoria_uso || null]
  );
  return rows[0];
}

async function updateEquipo(id, { nombre, tipo, identificador, estado, obra_id, categoria_uso }) {
  const { rows } = await db.pool.query(
    `UPDATE equipos_maquinaria SET
       nombre = COALESCE($1, nombre),
       tipo = COALESCE($2, tipo),
       identificador = COALESCE($3, identificador),
       estado = COALESCE($4, estado),
       obra_id = $5,
       categoria_uso = COALESCE($6, categoria_uso)
     WHERE id = $7 AND activo = true RETURNING *`,
    [nombre || null, tipo || null, identificador || null, estado || null, obra_id ?? null, categoria_uso || null, id]
  );
  return rows[0];
}

// Registro abierto de responsable diario (prompt-responsable-diario-equipo-
// menor.md) — solo para equipos categoria_uso='menor'; sin candado de
// ownership (a diferencia de reportes_horas_maquinaria), cualquiera con
// acceso al módulo puede registrar para cualquier equipo.
async function listResponsablesDiarios(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT rd.*, u.nombre AS registrado_por_nombre
    FROM equipo_responsable_diario rd
    LEFT JOIN usuarios u ON u.id = rd.registrado_por
    WHERE rd.equipo_id = $1
    ORDER BY rd.fecha DESC, rd.id DESC
  `, [equipoId]);
  return rows;
}

async function createResponsableDiario({ equipo_id, fecha, nombre_responsable, registrado_por }) {
  const { rows } = await db.pool.query(
    `INSERT INTO equipo_responsable_diario (equipo_id, fecha, nombre_responsable, registrado_por)
     VALUES ($1, COALESCE($2, CURRENT_DATE), $3, $4) RETURNING *`,
    [equipo_id, fecha || null, nombre_responsable, registrado_por]
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

// lectura (prompt-10-programa-consumibles.md): opcional, solo la usa el
// registro de diesel del operador vía /api/maquinaria/consumibles — el flujo
// existente de jefe_maquinaria (POST /api/maquinaria/combustible) sigue sin
// mandarla, queda NULL igual que siempre.
async function createCombustible({ equipo_id, fecha, litros, costo, registrado_por, lectura }) {
  const { rows } = await db.pool.query(
    `INSERT INTO combustible_maquinaria (equipo_id, fecha, litros, costo, registrado_por, lectura)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [equipo_id, fecha, litros, costo, registrado_por, lectura ?? null]
  );
  return rows[0];
}

async function softDeleteCombustible(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE combustible_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

// LEFT JOIN (no JOIN): prompt-4-bitacora-taller-jefe-maquinaria.md —
// equipo_id ahora es nullable (entradas generales de taller, sin equipo),
// un INNER JOIN las excluiría por completo del resultado.
async function listMantenimientos(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT m.*, e.nombre AS equipo_nombre, u.nombre AS registrado_por_nombre
    FROM mantenimientos_maquinaria m
    LEFT JOIN equipos_maquinaria e ON e.id = m.equipo_id
    LEFT JOIN usuarios u ON u.id = m.registrado_por
    WHERE m.activo = true ${equipoId ? 'AND m.equipo_id = $1' : ''}
    ORDER BY m.fecha DESC, m.id DESC
  `, equipoId ? [equipoId] : []);
  return rows;
}

async function createMantenimiento({ equipo_id, fecha, tipo, descripcion, costo, proveedor, registrado_por, refaccion_descripcion, refaccion_costo }) {
  const { rows } = await db.pool.query(
    `INSERT INTO mantenimientos_maquinaria
       (equipo_id, fecha, tipo, descripcion, costo, proveedor, registrado_por, refaccion_descripcion, refaccion_costo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [equipo_id || null, fecha, tipo, descripcion || null, costo, proveedor || null, registrado_por,
      refaccion_descripcion || null, refaccion_costo ?? null]
  );
  return rows[0];
}

async function softDeleteMantenimiento(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE mantenimientos_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

// operadorId (prompt-p3-filtro-horas-operador.md): filtra por h.operador_id
// (quien capturó el reporte), NO por equipos_maquinaria.operador_asignado_id
// — un reporte histórico pertenece a quien lo capturó, aunque la máquina se
// haya reasignado a otro operador después. Filtro en el propio SQL.
async function listHoras(equipoId, operadorId) {
  const conditions = ['h.activo = true'];
  const params = [];
  if (equipoId) { params.push(equipoId); conditions.push(`h.equipo_id = $${params.length}`); }
  if (operadorId) { params.push(operadorId); conditions.push(`h.operador_id = $${params.length}`); }
  const { rows } = await db.pool.query(`
    SELECT h.*, e.nombre AS equipo_nombre, u.nombre AS operador_nombre, p.nombre AS obra_nombre,
      ur.nombre AS revisado_por_nombre
    FROM reportes_horas_maquinaria h
    JOIN equipos_maquinaria e ON e.id = h.equipo_id
    LEFT JOIN usuarios u ON u.id = h.operador_id
    LEFT JOIN proyectos p ON p.id = h.obra_id
    LEFT JOIN usuarios ur ON ur.id = h.revisado_por
    WHERE ${conditions.join(' AND ')}
    ORDER BY h.fecha DESC, h.id DESC
  `, params);
  return rows;
}

// Todo reporte nuevo entra en 'pendiente' — el estado inicial no lo decide
// el llamador (prompt-3-flujo-aprobacion-cabo-operador.md: operador captura,
// cabo autoriza/rechaza vía updateEstadoHoras más abajo).
async function createHoras({ equipo_id, operador_id, fecha, horas, obra_id, actividad }) {
  const { rows } = await db.pool.query(
    `INSERT INTO reportes_horas_maquinaria (equipo_id, operador_id, fecha, horas, obra_id, actividad, estado)
     VALUES ($1, $2, $3, $4, $5, $6, 'pendiente') RETURNING *`,
    [equipo_id, operador_id, fecha, horas, obra_id || null, actividad || null]
  );
  return rows[0];
}

async function softDeleteHoras(id) {
  const { rowCount } = await db.pool.query(
    'UPDATE reportes_horas_maquinaria SET activo = false WHERE id = $1', [id]
  );
  return rowCount > 0;
}

// Transición pendiente -> autorizado/rechazado. El WHERE estado='pendiente'
// hace la transición atómica (evita que dos cabos autoricen/rechacen el
// mismo reporte en una carrera) y a la vez sirve de candado "solo se revisa
// una vez" — devuelve undefined si el reporte no existe, ya no está activo,
// o ya fue revisado antes.
async function updateEstadoHoras(id, estado, revisadoPor) {
  const { rows } = await db.pool.query(
    `UPDATE reportes_horas_maquinaria
     SET estado = $1, revisado_por = $2, revisado_en = NOW()
     WHERE id = $3 AND activo = true AND estado = 'pendiente'
     RETURNING *`,
    [estado, revisadoPor, id]
  );
  return rows[0];
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
// vs. gasto real (combustible + mantenimiento + personal) de los equipos
// actualmente asignados a obras de ese cliente. Limitación conocida: el gasto
// se atribuye según la obra ACTUAL del equipo (equipos_maquinaria.obra_id) —
// si un equipo cambió de obra después de que se le cargó combustible, ese
// gasto histórico queda con la obra/cliente de HOY, no la de cuando se
// generó. Es la única relación equipo↔obra↔cliente que existe hoy.
//
// gasto_personal (prompt-nomina-personal-maquinaria-implementacion.md):
// SUM(nomina_items.monto_total) de trabajadores con categoria_costo =
// 'maquinaria', solo de nóminas 'aprobada' — mismo criterio de "dinero real"
// que ya exige el resto del sistema de Nómina (una nómina en borrador/revisión
// puede cambiar o rechazarse, no debe contarse como gasto todavía). A
// diferencia de combustible/mantenimiento (atribuidos vía equipos_maquinaria.
// obra_id, que es mutable), aquí se atribuye vía nominas.project_id, que es
// fijo por periodo de nómina — no hay el mismo problema de reatribución
// retroactiva. reportes_horas_maquinaria NO se toca ni se referencia aquí.
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
        ), 0) AS gasto_mantenimiento,
        COALESCE((
          SELECT SUM(ni.monto_total) FROM nomina_items ni
          JOIN trabajadores t ON t.id = ni.trabajador_id AND t.categoria_costo = 'maquinaria'
          JOIN nominas n ON n.id = ni.nomina_id AND n.estado = 'aprobada'
          JOIN proyectos p ON p.id = n.project_id
          WHERE p.cliente_id = $1
        ), 0) AS gasto_personal
    `, [cliente.id]);
    const sug = sugeridoPorCliente.get(cliente.id);
    const gastoCombustible = Number(gastoRows[0].gasto_combustible);
    const gastoMantenimiento = Number(gastoRows[0].gasto_mantenimiento);
    const gastoPersonal = Number(gastoRows[0].gasto_personal);
    porCliente.push({
      cliente_id: cliente.id,
      cliente: cliente.nombre,
      presupuesto_sugerido: sug?.monto || 0,
      fuente_mixta: sug?.fuente_mixta || false,
      gasto_combustible: gastoCombustible,
      gasto_mantenimiento: gastoMantenimiento,
      gasto_personal: gastoPersonal,
      gasto_total: gastoCombustible + gastoMantenimiento + gastoPersonal,
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

// Estado de la unidad (prompt-6-estado-unidad-operador.md) — checklist de
// seguridad/preventivos del operador, distinto de mantenimientos_maquinaria
// (bitácora de taller de jefe_maquinaria).
//
// operadorId (mismo criterio que listEquipos arriba): cuando viene, filtra
// en la propia consulta SQL a solo el/los equipo(s) asignados a ese
// operador — usado cuando un operador consulta esta vista (tiene puede_ver,
// ver defaultPermisosParaRol), nunca la flota completa de otros operadores.
// LEFT JOIN LATERAL trae la ÚLTIMA captura por equipo (o ninguna, si nunca
// se ha capturado) — un LEFT JOIN normal con MAX(creado_en) traería todas
// las columnas desalineadas entre filas distintas.
async function listEstadoUnidadResumen(operadorId = null) {
  const { rows } = await db.pool.query(`
    SELECT e.id AS equipo_id, e.nombre AS equipo_nombre, e.tipo, e.categoria, e.identificador,
      eu.id AS estado_id, eu.fecha, eu.tipo_unidad, eu.items, eu.lectura, eu.observaciones, eu.creado_en,
      u.nombre AS operador_nombre
    FROM equipos_maquinaria e
    LEFT JOIN LATERAL (
      SELECT * FROM estado_unidad WHERE equipo_id = e.id ORDER BY creado_en DESC LIMIT 1
    ) eu ON true
    LEFT JOIN usuarios u ON u.id = eu.operador_id
    WHERE e.activo = true ${operadorId ? 'AND e.operador_asignado_id = $1' : ''}
    ORDER BY e.nombre
  `, operadorId ? [operadorId] : []);
  return rows.map((r) => ({
    ...r,
    tiene_critico: Array.isArray(r.items) && r.items.some((it) => it.estado === 'critico'),
  }));
}

// Histórico completo (no solo la última) de un equipo — más reciente primero.
async function listEstadoUnidadHistorico(equipoId) {
  const { rows } = await db.pool.query(`
    SELECT eu.*, u.nombre AS operador_nombre
    FROM estado_unidad eu
    LEFT JOIN usuarios u ON u.id = eu.operador_id
    WHERE eu.equipo_id = $1
    ORDER BY eu.creado_en DESC
  `, [equipoId]);
  return rows.map((r) => ({
    ...r,
    tiene_critico: Array.isArray(r.items) && r.items.some((it) => it.estado === 'critico'),
  }));
}

async function createEstadoUnidad({ equipo_id, operador_id, fecha, tipo_unidad, items, lectura, observaciones }) {
  const { rows } = await db.pool.query(
    `INSERT INTO estado_unidad (equipo_id, operador_id, fecha, tipo_unidad, items, lectura, observaciones)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [equipo_id, operador_id, fecha, tipo_unidad, JSON.stringify(items), lectura, observaciones || null]
  );
  return rows[0];
}

// Programa de consumibles (prompt-10-programa-consumibles.md) — decisión
// consultada: 'diesel' NO tiene fila propia aquí, usa createCombustible de
// arriba (escribe en combustible_maquinaria, la misma tabla de siempre de
// jefe_maquinaria) con su propia validación de ownership en el endpoint.
// Esta tabla solo cubre los 3 aceites, que sí son nuevos de verdad.
async function createConsumible({ equipo_id, tipo, cantidad, unidad, lectura, operador_id, fecha, costo_estimado, insumo_id }) {
  const { rows } = await db.pool.query(
    `INSERT INTO consumibles_maquinaria (equipo_id, tipo, cantidad, unidad, lectura, operador_id, fecha, costo_estimado, insumo_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [equipo_id, tipo, cantidad, unidad || 'litros', lectura ?? null, operador_id, fecha, costo_estimado ?? null, insumo_id ?? null]
  );
  return rows[0];
}

// Resuelve costo/IVA desde Insumos para un tipo de consumible — mismo
// criterio "precio más recio" que costosCatalogoQuery (server/app.js): toma
// el insumo con ese concepto de la obra creada más recientemente entre
// TODAS las obras (los equipos de Maquinaria no están estrictamente
// atados a una sola obra vía obra_id, ver comentario en server/db.js).
// Insumos no distingue aceite motor/hidráulico/transmisión — los 3 resuelven
// contra el mismo concepto genérico 'ACEITE' (confirmado en diagnóstico:
// no hay entradas más específicas). 'gasolina' sí tiene su propio concepto
// 'GASOLINA' en Insumos, distinto de 'DIESEL' (confirmado en diagnóstico,
// prompt-agregar-gasolina-consumibles.md) — NO cae en el bucket 'ACEITE'.
// Devuelve null si no hay ningún insumo con ese concepto — la captura nunca
// se bloquea por esto (Forbidden Action).
const CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE = { diesel: 'DIESEL', gasolina: 'GASOLINA' };
async function resolverCostoConsumible(tipo) {
  const concepto = CONCEPTO_INSUMO_POR_TIPO_CONSUMIBLE[tipo] || 'ACEITE';
  const { rows } = await db.pool.query(`
    SELECT i.id, i.precio_presupuesto, i.iva_tasa
    FROM insumos i JOIN proyectos p ON p.id = i.project_id
    WHERE i.concepto = $1
    ORDER BY p.creado_en DESC, i.id DESC
    LIMIT 1
  `, [concepto]);
  return rows[0] || null;
}

// Unifica combustible_maquinaria (diesel) + consumibles_maquinaria (3
// aceites) en un solo listado — mismo criterio de filtro por operador que
// listEquipos/listEstadoUnidadResumen (operadorId viene solo cuando el
// requester es operador, acota a solo sus unidades). fechaDesde/fechaHasta
// para el filtro de periodo (semana/mes/rango) que pide la vista de
// cabo/jefe_maquinaria — se aplican con "col IS NULL OR" para poder
// compartir los mismos parámetros en las 2 mitades del UNION ALL.
async function listConsumibles({ equipoId = null, operadorId = null, fechaDesde = null, fechaHasta = null } = {}) {
  const params = [equipoId, operadorId, fechaDesde, fechaHasta];
  const { rows } = await db.pool.query(`
    SELECT e.id AS equipo_id, e.nombre AS equipo_nombre, 'diesel' AS tipo,
      cm.litros AS cantidad, 'litros' AS unidad, cm.lectura, cm.fecha,
      cm.costo AS costo_estimado, cm.registrado_por AS operador_id,
      u.nombre AS operador_nombre, cm.creado_en, cm.id AS registro_id
    FROM combustible_maquinaria cm
    JOIN equipos_maquinaria e ON e.id = cm.equipo_id
    LEFT JOIN usuarios u ON u.id = cm.registrado_por
    WHERE cm.activo = true
      AND ($1::int IS NULL OR cm.equipo_id = $1)
      AND ($2::int IS NULL OR cm.registrado_por = $2)
      AND ($3::date IS NULL OR cm.fecha >= $3)
      AND ($4::date IS NULL OR cm.fecha <= $4)

    UNION ALL

    SELECT e.id AS equipo_id, e.nombre AS equipo_nombre, co.tipo,
      co.cantidad, co.unidad, co.lectura, co.fecha,
      co.costo_estimado, co.operador_id,
      u.nombre AS operador_nombre, co.creado_en, co.id AS registro_id
    FROM consumibles_maquinaria co
    JOIN equipos_maquinaria e ON e.id = co.equipo_id
    LEFT JOIN usuarios u ON u.id = co.operador_id
    WHERE co.activo = true
      AND ($1::int IS NULL OR co.equipo_id = $1)
      AND ($2::int IS NULL OR co.operador_id = $2)
      AND ($3::date IS NULL OR co.fecha >= $3)
      AND ($4::date IS NULL OR co.fecha <= $4)

    ORDER BY fecha DESC, creado_en DESC
  `, params);
  return rows;
}

module.exports = {
  listEquipos, getEquipoById, createEquipo, updateEquipo, softDeleteEquipo,
  asignarClienteEquipo, asignarOperadorEquipo,
  listResponsablesDiarios, createResponsableDiario,
  listCombustible, createCombustible, softDeleteCombustible,
  listMantenimientos, createMantenimiento, softDeleteMantenimiento,
  listHoras, createHoras, softDeleteHoras, updateEstadoHoras,
  getResumen, updatePresupuesto,
  getPresupuestoSugerido, getReportePorCliente,
  listEstadoUnidadResumen, listEstadoUnidadHistorico, createEstadoUnidad,
  createConsumible, resolverCostoConsumible, listConsumibles,
};
