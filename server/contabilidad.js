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

/*
 * Contabilidad Fase 4 (prompt-contabilidad-fase4-depreciacion.md) —
 * parámetros de depreciación de maquinaria (línea recta), aislada de
 * equipos_maquinaria (solo lectura vía FK). Sin snapshot mensual: todo se
 * deriva on-the-fly en cada consulta desde depreciacion_maquinaria.
 */

function mesIndice(anio, mes) { return anio * 12 + (mes - 1); } // mes 1-12, índice absoluto para restar meses entre fechas

// params: { valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, fecha_baja }
// mesConsultado: 'YYYY-MM'. Función pura, sin acceso a DB — fácil de probar a mano.
function calcularDepreciacion(params, mesConsultado) {
  const valorAdquisicion = Number(params.valor_adquisicion);
  const valorRescate = Number(params.valor_rescate) || 0;
  const vidaUtilMeses = Number(params.vida_util_meses);
  const depreciable = valorAdquisicion - valorRescate;
  const depreciacionMensual = vidaUtilMeses > 0 ? depreciable / vidaUtilMeses : 0;

  const [anioConsulta, mesConsulta] = String(mesConsultado).split('-').map(Number);
  const fAdq = new Date(params.fecha_adquisicion);
  const anioAdq = fAdq.getUTCFullYear();
  const mesAdq = fAdq.getUTCMonth() + 1;

  // Si el equipo se dio de baja antes del mes consultado, el límite de
  // acumulación es el mes de la baja, no el mes consultado (diagnóstico
  // Fase 4, punto 5 — "depreciación truncada").
  let limiteAnio = anioConsulta;
  let limiteMes = mesConsulta;
  if (params.fecha_baja) {
    const fBaja = new Date(params.fecha_baja);
    const idxBaja = mesIndice(fBaja.getUTCFullYear(), fBaja.getUTCMonth() + 1);
    const idxConsulta = mesIndice(anioConsulta, mesConsulta);
    if (idxBaja < idxConsulta) { limiteAnio = fBaja.getUTCFullYear(); limiteMes = fBaja.getUTCMonth() + 1; }
  }

  // +1: el mes de adquisición ya cuenta como el primer mes depreciado.
  const mesesTranscurridos = Math.max(0, mesIndice(limiteAnio, limiteMes) - mesIndice(anioAdq, mesAdq) + 1);
  const depreciacionAcumulada = Math.min(depreciacionMensual * mesesTranscurridos, depreciable);
  const valorEnLibros = valorAdquisicion - depreciacionAcumulada;

  return {
    depreciacion_mensual: Number(depreciacionMensual.toFixed(2)),
    meses_transcurridos: mesesTranscurridos,
    depreciacion_acumulada: Number(depreciacionAcumulada.toFixed(2)),
    valor_en_libros: Number(valorEnLibros.toFixed(2)),
  };
}

function mesActualYYYYMM() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function listDepreciacion({ mes } = {}) {
  const mesConsultado = mes || mesActualYYYYMM();
  const { rows } = await db.pool.query(`
    SELECT d.*, e.nombre AS equipo_nombre, e.tipo AS equipo_tipo, e.identificador AS equipo_identificador, e.estado AS equipo_estado
    FROM depreciacion_maquinaria d
    JOIN equipos_maquinaria e ON e.id = d.equipo_id
    ORDER BY e.nombre
  `);
  return rows.map((r) => ({ ...r, ...calcularDepreciacion(r, mesConsultado), mes: mesConsultado }));
}

// Equipos activos (soft-delete de equipos_maquinaria, no confundir con
// estado='baja') que aún no tienen parámetros de depreciación capturados.
async function listEquiposDisponiblesDepreciacion() {
  const { rows } = await db.pool.query(`
    SELECT e.* FROM equipos_maquinaria e
    WHERE e.activo = true AND NOT EXISTS (SELECT 1 FROM depreciacion_maquinaria d WHERE d.equipo_id = e.id)
    ORDER BY e.nombre
  `);
  return rows;
}

async function createDepreciacion({ equipo_id, valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, creado_por }) {
  const { rows: equipoRows } = await db.pool.query('SELECT id FROM equipos_maquinaria WHERE id = $1', [equipo_id]);
  if (!equipoRows[0]) {
    const err = new Error('El equipo indicado no existe');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.pool.query(
    `INSERT INTO depreciacion_maquinaria (equipo_id, valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, creado_por)
     VALUES ($1,$2,$3,$4,COALESCE($5,0),$6) RETURNING *`,
    [equipo_id, valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, creado_por]
  );
  return rows[0];
}

async function updateDepreciacion(id, { valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, fecha_baja }) {
  const { rows } = await db.pool.query(
    `UPDATE depreciacion_maquinaria SET
       valor_adquisicion = COALESCE($1, valor_adquisicion),
       fecha_adquisicion = COALESCE($2::date, fecha_adquisicion),
       vida_util_meses = COALESCE($3, vida_util_meses),
       valor_rescate = COALESCE($4, valor_rescate),
       fecha_baja = COALESCE($5::date, fecha_baja)
     WHERE id = $6 RETURNING *`,
    [valor_adquisicion, fecha_adquisicion, vida_util_meses, valor_rescate, fecha_baja, id]
  );
  return rows[0] || null;
}

// Póliza de depreciación — SIEMPRE opcional y confirmada explícitamente por
// el usuario (server/app.js exige body.confirmado === true antes de llamar
// esto); nunca se genera sola. cuenta_id fijo = 5107 (seed de Fase 1/4).
async function generarPolizaDepreciacion(depreciacionId, mes, usuarioId) {
  const { rows: depRows } = await db.pool.query(`
    SELECT d.*, e.nombre AS equipo_nombre FROM depreciacion_maquinaria d
    JOIN equipos_maquinaria e ON e.id = d.equipo_id
    WHERE d.id = $1
  `, [depreciacionId]);
  if (!depRows[0]) {
    const err = new Error('No se encontraron parámetros de depreciación para ese equipo');
    err.status = 404;
    throw err;
  }
  const { rows: cuentaRows } = await db.pool.query("SELECT id FROM cuentas_contables WHERE codigo = '5107'");
  if (!cuentaRows[0]) {
    const err = new Error('No existe la cuenta contable 5107 (Depreciación) — revisa el catálogo de cuentas');
    err.status = 500;
    throw err;
  }
  const dep = depRows[0];
  const { depreciacion_mensual } = calcularDepreciacion(dep, mes);
  if (!(depreciacion_mensual > 0)) {
    const err = new Error('La depreciación calculada para este mes es 0 — no se genera póliza');
    err.status = 400;
    throw err;
  }
  const [anio, mesNum] = mes.split('-');
  const nombreMes = new Date(Date.UTC(Number(anio), Number(mesNum) - 1, 1)).toLocaleDateString('es-MX', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const { rows } = await db.pool.query(
    `INSERT INTO polizas (tipo, fecha, cuenta_id, monto, concepto, usuario_id)
     VALUES ('diario', CURRENT_DATE, $1, $2, $3, $4) RETURNING *`,
    [cuentaRows[0].id, depreciacion_mensual, `Depreciación ${dep.equipo_nombre} — ${nombreMes}`, usuarioId]
  );
  return rows[0];
}

/*
 * Contabilidad Fase 5 (prompt-contabilidad-fase5-exportacion.md) — export
 * mensual consolidado a Excel. Silo separado de Finanzas/Erogado Real
 * (diagnóstico Fase 0) — solo consolida las 4 fuentes propias de
 * Contabilidad, nunca cruza con esos datos. Sin persistir/cachear nada:
 * las 4 queries corren al vuelo en cada request, igual que el resto del
 * módulo.
 */

// Límites [inicio, fin) del mes 'YYYY-MM', como DATE strings — fin es el
// día 1 del mes siguiente (exclusivo), para no depender de cuántos días
// tiene el mes ni de zonas horarias en la comparación.
function limitesMes(mes) {
  const [anio, m] = mes.split('-').map(Number);
  const inicio = `${mes}-01`;
  const anioFin = m === 12 ? anio + 1 : anio;
  const mesFin = m === 12 ? 1 : m + 1;
  const fin = `${anioFin}-${String(mesFin).padStart(2, '0')}-01`;
  return { inicio, fin };
}

// project_id no existe directo en movimientos_bancarios — el filtro de obra
// para esa hoja usa el project_id de la póliza con la que se concilió
// (diagnóstico Fase 5, punto 2 — confirmado como JOIN correcto, no
// ambiguo: todo movimiento con estatus='conciliado' tiene poliza_id
// NOT NULL por construcción, conciliarMovimiento/desconciliarMovimiento
// siempre actualizan ambos juntos, así que el JOIN nunca deja fuera un
// conciliado real).
async function getDatosExportacionMes({ mes, projectId }) {
  const { inicio, fin } = limitesMes(mes);

  const paramsPolizas = [inicio, fin];
  let wherePolizas = 'p.fecha >= $1 AND p.fecha < $2';
  if (projectId) { paramsPolizas.push(projectId); wherePolizas += ` AND p.project_id = $${paramsPolizas.length}`; }
  const { rows: polizas } = await db.pool.query(`
    SELECT p.*, c.codigo AS cuenta_codigo, c.nombre AS cuenta_nombre, pr.nombre AS project_nombre
    FROM polizas p
    JOIN cuentas_contables c ON c.id = p.cuenta_id
    LEFT JOIN proyectos pr ON pr.id = p.project_id
    WHERE ${wherePolizas}
    ORDER BY p.fecha, p.id
  `, paramsPolizas);

  const paramsCfdi = [inicio, fin];
  let whereCfdi = 'c.fecha_emision >= $1 AND c.fecha_emision < $2';
  if (projectId) { paramsCfdi.push(projectId); whereCfdi += ` AND c.project_id = $${paramsCfdi.length}`; }
  const { rows: cfdi } = await db.pool.query(`
    SELECT c.*, pr.nombre AS project_nombre
    FROM cfdi c
    LEFT JOIN proyectos pr ON pr.id = c.project_id
    WHERE ${whereCfdi}
    ORDER BY c.fecha_emision, c.id
  `, paramsCfdi);

  // Solo estatus='conciliado' — un movimiento pendiente no tiene contraparte
  // contable todavía y no aporta al reporte del contador (forbidden action
  // explícita del prompt).
  const paramsMov = [inicio, fin];
  let whereMov = "m.estatus = 'conciliado' AND m.fecha >= $1 AND m.fecha < $2";
  if (projectId) { paramsMov.push(projectId); whereMov += ` AND pz.project_id = $${paramsMov.length}`; }
  const { rows: movimientos } = await db.pool.query(`
    SELECT m.*, cb.nombre AS cuenta_nombre, pz.concepto AS poliza_concepto
    FROM movimientos_bancarios m
    JOIN cuentas_bancarias cb ON cb.id = m.cuenta_bancaria_id
    JOIN polizas pz ON pz.id = m.poliza_id
    WHERE ${whereMov}
    ORDER BY m.fecha, m.id
  `, paramsMov);

  // Depreciación no tiene "eventos del mes" (cálculo on-the-fly, sin
  // snapshot) — se evalúa calcularDepreciacion() en `mes` para cada equipo
  // configurado, cruzando equipos_maquinaria.obra_id para el filtro de obra.
  // fecha_adquisicion < fin del mes consultado: un equipo comprado DESPUÉS
  // del mes que se está exportando no debe aparecer (encontrado probando el
  // mes-sin-datos del checkpoint — sin este filtro, todo equipo configurado
  // aparecía sin importar el mes pedido, incluso años antes de comprarlo).
  const paramsDeprec = [fin];
  let whereDeprec = 'd.fecha_adquisicion < $1';
  if (projectId) { paramsDeprec.push(projectId); whereDeprec += ` AND e.obra_id = $${paramsDeprec.length}`; }
  const { rows: deprecRows } = await db.pool.query(`
    SELECT d.*, e.nombre AS equipo_nombre, e.identificador AS equipo_identificador
    FROM depreciacion_maquinaria d
    JOIN equipos_maquinaria e ON e.id = d.equipo_id
    WHERE ${whereDeprec}
    ORDER BY e.nombre
  `, paramsDeprec);
  const depreciacion = deprecRows.map((r) => ({ ...r, ...calcularDepreciacion(r, mes) }));

  // Pagos de OC del mes (prompt-fase2-cierre-mensual-pagos-oc.md) — misma
  // fuente que GET /api/contabilidad/pagos (server/app.js), filtrada por
  // fecha de pago en vez de traer las últimas 200 sin filtro de mes.
  const paramsPagos = [inicio, fin];
  let wherePagos = 'p.fecha >= $1 AND p.fecha < $2';
  if (projectId) { paramsPagos.push(projectId); wherePagos += ` AND oc.project_id = $${paramsPagos.length}`; }
  const { rows: pagos } = await db.pool.query(`
    SELECT p.id, p.fecha, p.monto, p.metodo, p.referencia, p.cfdi_id,
           oc.id AS oc_id, oc.folio AS oc_folio, oc.project_id,
           pr.nombre AS project_nombre,
           pv.nombre AS proveedor_nombre, pv.rfc AS proveedor_rfc,
           c.uuid AS cfdi_uuid, c.total AS cfdi_total
    FROM pagos p
    JOIN ordenes_compra oc ON oc.id = p.orden_compra_id
    JOIN proveedores pv ON pv.id = oc.proveedor_id
    LEFT JOIN proyectos pr ON pr.id = oc.project_id
    LEFT JOIN cfdi c ON c.id = p.cfdi_id
    WHERE ${wherePagos}
    ORDER BY p.fecha, p.id
  `, paramsPagos);

  return { polizas, cfdi, movimientos, depreciacion, pagos };
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
  calcularDepreciacion,
  listDepreciacion,
  listEquiposDisponiblesDepreciacion,
  createDepreciacion,
  updateDepreciacion,
  generarPolizaDepreciacion,
  getDatosExportacionMes,
  limitesMes,
};
