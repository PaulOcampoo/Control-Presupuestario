'use strict';

/*
 * Estado de Resultados (Tesorería) — prompt-estado-resultados-tesoreria.
 *
 * Decisiones confirmadas con Paul tras diagnóstico de Fase 0:
 *   - Vínculo factura↔contrato: solo project_id. La tabla `contratos` es 1:1
 *     con project_id (UNIQUE) y no guarda montos — el importe_contratado/
 *     total_contratado extraído del PDF vive como filas sueltas en `meta`
 *     (clave/valor TEXT). Un contrato_id FK habría sido redundante.
 *   - Margen Bruto se calcula sobre Ingresos FACTURADOS (no cobrados). La
 *     cobranza real (suma de cobros) se expone aparte como métrica de flujo
 *     de caja, sin afectar el margen.
 *
 * Egresos = Erogado Real completo (total_pagado + total_comprometido_no_pagado)
 * de getFinanzasResumenData, no solo lo ya desembolsado — así queda en la
 * misma base "incurrido" que Ingresos facturados (devengado, no caja). Ambos
 * componentes se exponen por separado en la respuesta (nunca fusionados sin
 * mostrarlos), mismo criterio que ya aplica el ajuste de IVA en Finanzas.
 */

const db = require('./db');
const { getFinanzasResumenData } = require('./finanzas');

const EPSILON = 0.01; // tolerancia de centavos por redondeo en comparaciones de montos

function calcularEstatusFactura(montoTotal, montoCobrado) {
  if (montoCobrado <= EPSILON) return 'pendiente';
  if (montoCobrado + EPSILON >= montoTotal) return 'cobrada_total';
  return 'cobrada_parcial';
}

async function listFacturas(projectId) {
  const { rows } = await db.pool.query(`
    SELECT f.*, COALESCE(SUM(c.monto_cobrado), 0) AS monto_cobrado
    FROM facturas f
    LEFT JOIN cobros c ON c.factura_id = f.id
    WHERE f.project_id = $1
    GROUP BY f.id
    ORDER BY f.fecha_emision DESC, f.id DESC
  `, [projectId]);
  return rows.map((r) => ({ ...r, monto_cobrado: Number(r.monto_cobrado) }));
}

async function getFactura(id) {
  const { rows } = await db.pool.query(`
    SELECT f.*, COALESCE(SUM(c.monto_cobrado), 0) AS monto_cobrado
    FROM facturas f
    LEFT JOIN cobros c ON c.factura_id = f.id
    WHERE f.id = $1
    GROUP BY f.id
  `, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], monto_cobrado: Number(rows[0].monto_cobrado) };
}

async function tieneCobros(facturaId) {
  const { rows } = await db.pool.query('SELECT 1 FROM cobros WHERE factura_id = $1 LIMIT 1', [facturaId]);
  return rows.length > 0;
}

async function createFactura({ project_id, folio, concepto, fecha_emision, monto_subtotal, iva, monto_total, creado_por }) {
  const { rows } = await db.pool.query(
    `INSERT INTO facturas (project_id, folio, concepto, fecha_emision, monto_subtotal, iva, monto_total, creado_por)
     VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5,$6,$7,$8) RETURNING *`,
    [project_id, folio || null, concepto, fecha_emision || null, monto_subtotal, iva, monto_total, creado_por]
  );
  return { ...rows[0], monto_cobrado: 0 };
}

async function updateFactura(id, { folio, concepto, fecha_emision, monto_subtotal, iva, monto_total }) {
  if (await tieneCobros(id)) {
    const err = new Error('No se puede editar una factura que ya tiene cobros registrados');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.pool.query(
    `UPDATE facturas SET
       folio = COALESCE($1, folio),
       concepto = COALESCE($2, concepto),
       fecha_emision = COALESCE($3::date, fecha_emision),
       monto_subtotal = COALESCE($4, monto_subtotal),
       iva = COALESCE($5, iva),
       monto_total = COALESCE($6, monto_total)
     WHERE id = $7 AND estatus != 'cancelada'
     RETURNING *`,
    [folio?.trim() || null, concepto?.trim() || null, fecha_emision || null, monto_subtotal, iva, monto_total, id]
  );
  return rows[0] || null;
}

async function cancelarFactura(id) {
  if (await tieneCobros(id)) {
    const err = new Error('No se puede cancelar una factura que ya tiene cobros registrados');
    err.status = 400;
    throw err;
  }
  const { rows } = await db.pool.query(
    "UPDATE facturas SET estatus = 'cancelada' WHERE id = $1 AND estatus != 'cancelada' RETURNING *",
    [id]
  );
  return rows[0] || null;
}

// Registra un cobro y recalcula el estatus de la factura a partir de la
// suma real de cobros (nunca se confía en un contador incremental aparte).
async function registrarCobro({ factura_id, fecha_cobro, monto_cobrado, forma_pago, creado_por }) {
  return db.withTransaction(async (client) => {
    const { rows: facRows } = await client.query('SELECT * FROM facturas WHERE id = $1 FOR UPDATE', [factura_id]);
    const factura = facRows[0];
    if (!factura) {
      const err = new Error('Factura no encontrada');
      err.status = 404;
      throw err;
    }
    if (factura.estatus === 'cancelada') {
      const err = new Error('No se puede registrar un cobro contra una factura cancelada');
      err.status = 400;
      throw err;
    }

    const { rows: cobroRows } = await client.query(
      `INSERT INTO cobros (factura_id, fecha_cobro, monto_cobrado, forma_pago, creado_por)
       VALUES ($1,COALESCE($2::date, CURRENT_DATE),$3,$4,$5) RETURNING *`,
      [factura_id, fecha_cobro || null, monto_cobrado, forma_pago || null, creado_por]
    );

    const { rows: sumRows } = await client.query(
      'SELECT COALESCE(SUM(monto_cobrado), 0) AS total FROM cobros WHERE factura_id = $1', [factura_id]
    );
    const totalCobrado = Number(sumRows[0].total);
    const nuevoEstatus = calcularEstatusFactura(Number(factura.monto_total), totalCobrado);

    const { rows: updRows } = await client.query(
      'UPDATE facturas SET estatus = $1 WHERE id = $2 RETURNING *',
      [nuevoEstatus, factura_id]
    );

    return { factura: { ...updRows[0], monto_cobrado: totalCobrado }, cobro: cobroRows[0] };
  });
}

async function listCobros(facturaId) {
  const { rows } = await db.pool.query(
    'SELECT * FROM cobros WHERE factura_id = $1 ORDER BY fecha_cobro DESC, id DESC', [facturaId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Estado de Resultados por obra: Ingresos (facturado, sin y con IVA) vs
// Egresos (Erogado Real completo de Finanzas) = Margen Bruto.
// ---------------------------------------------------------------------------
async function getEstadoResultadosPorObra(projectId, { desde, hasta } = {}) {
  const params = [projectId];
  let filtroFecha = '';
  if (desde) { params.push(desde); filtroFecha += ` AND fecha_emision >= $${params.length}::date`; }
  if (hasta) { params.push(hasta); filtroFecha += ` AND fecha_emision <= $${params.length}::date`; }

  const { rows: ingRows } = await db.pool.query(`
    SELECT COALESCE(SUM(monto_subtotal), 0) AS sin_iva,
           COALESCE(SUM(iva), 0) AS iva_total,
           COALESCE(SUM(monto_total), 0) AS con_iva,
           COUNT(*) AS num_facturas
    FROM facturas
    WHERE project_id = $1 AND estatus != 'cancelada' ${filtroFecha}
  `, params);
  const ing = ingRows[0];

  const { rows: cobRows } = await db.pool.query(`
    SELECT COALESCE(SUM(c.monto_cobrado), 0) AS total
    FROM cobros c
    JOIN facturas f ON f.id = c.factura_id
    WHERE f.project_id = $1 AND f.estatus != 'cancelada'
  `, [projectId]);
  const cobrado = Number(cobRows[0].total);

  const finanzas = await getFinanzasResumenData(projectId);
  const er = finanzas.erogado_real;
  const egresosTotal = Number((er.total_pagado + er.total_comprometido_no_pagado).toFixed(2));

  const ingresosSinIva = Number(ing.sin_iva);
  const margenBruto = Number((ingresosSinIva - egresosTotal).toFixed(2));
  const margenPct = ingresosSinIva > 0 ? Number(((margenBruto / ingresosSinIva) * 100).toFixed(2)) : null;

  return {
    project_id: projectId,
    periodo: { desde: desde || null, hasta: hasta || null },
    ingresos: {
      facturado_sin_iva: ingresosSinIva,
      facturado_iva: Number(ing.iva_total),
      facturado_con_iva: Number(ing.con_iva),
      cobrado_total: cobrado,
      num_facturas: Number(ing.num_facturas),
    },
    egresos: {
      total: egresosTotal,
      pagado: er.total_pagado,
      comprometido_no_pagado: er.total_comprometido_no_pagado,
      desglose: {
        compras_pagado: er.compras_pagado,
        compras_comprometido: er.compras_comprometido,
        gastos_generales_pagado: er.gastos_generales_pagado,
        gastos_generales_pendiente: er.gastos_generales_pendiente,
        destajo_ejecutado: er.destajo_ejecutado,
      },
    },
    margen_bruto: margenBruto,
    margen_pct: margenPct,
  };
}

// Obras a las que el usuario tiene acceso — mismo criterio que GET /api/projects
// (admin/desarrollador ven todas, el resto solo las de usuario_proyectos).
async function proyectosAccesiblesPara(user) {
  if (user.puesto === 'admin' || user.puesto === 'desarrollador') {
    return db.listProjects();
  }
  const { rows } = await db.pool.query(`
    SELECT p.* FROM proyectos p
    JOIN usuario_proyectos up ON up.project_id = p.id
    WHERE up.usuario_id = $1
    ORDER BY p.id DESC
  `, [user.id]);
  return rows;
}

async function getEstadoResultadosConsolidado(user, { desde, hasta } = {}) {
  const proyectos = await proyectosAccesiblesPara(user);
  const porObra = await Promise.all(
    proyectos.map(async (p) => ({
      project_id: p.id,
      nombre: p.nombre,
      ...(await getEstadoResultadosPorObra(p.id, { desde, hasta })),
    }))
  );

  const totales = porObra.reduce((acc, o) => {
    acc.ingresos_sin_iva += o.ingresos.facturado_sin_iva;
    acc.ingresos_con_iva += o.ingresos.facturado_con_iva;
    acc.cobrado_total += o.ingresos.cobrado_total;
    acc.egresos_total += o.egresos.total;
    acc.margen_bruto += o.margen_bruto;
    return acc;
  }, { ingresos_sin_iva: 0, ingresos_con_iva: 0, cobrado_total: 0, egresos_total: 0, margen_bruto: 0 });

  const round2 = (n) => Number(n.toFixed(2));
  return {
    periodo: { desde: desde || null, hasta: hasta || null },
    totales: {
      ingresos_sin_iva: round2(totales.ingresos_sin_iva),
      ingresos_con_iva: round2(totales.ingresos_con_iva),
      cobrado_total: round2(totales.cobrado_total),
      egresos_total: round2(totales.egresos_total),
      margen_bruto: round2(totales.margen_bruto),
      margen_pct: totales.ingresos_sin_iva > 0
        ? round2((totales.margen_bruto / totales.ingresos_sin_iva) * 100)
        : null,
    },
    obras: porObra,
  };
}

module.exports = {
  listFacturas,
  getFactura,
  createFactura,
  updateFactura,
  cancelarFactura,
  registrarCobro,
  listCobros,
  getEstadoResultadosPorObra,
  getEstadoResultadosConsolidado,
};
