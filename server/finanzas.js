'use strict';

// Extraído tal cual desde server/app.js (prompt-estado-resultados-tesoreria)
// para que el módulo de Estado de Resultados (Tesorería) pueda reutilizar
// "Erogado Real" sin duplicar la query — comportamiento sin cambios.

const db = require('./db');

function metaToObject(rows) {
  const o = {};
  for (const r of rows) o[r.clave] = r.valor;
  return o;
}

async function presupuestoTotalDe(projectId) {
  const { rows: metaRows } = await db.pool.query('SELECT clave, valor FROM meta WHERE project_id = $1', [projectId]);
  const meta = metaToObject(metaRows);
  if (meta.total_sin_iva) return Number(meta.total_sin_iva);
  const { rows } = await db.pool.query(
    "SELECT importe FROM conceptos WHERE project_id = $1 AND es_total = 1 AND grupo IS NULL ORDER BY orden DESC LIMIT 1",
    [projectId]
  );
  return rows[0] ? rows[0].importe : 0;
}

// ---------------------------------------------------------------------------
// Resumen financiero: Avance Valorizado (% ejecutado × presupuesto, idéntico
// al que ya usa el Resumen) vs Erogado Real (Compras + Gastos Generales) —
// dos fuentes de verdad separadas, nunca fusionadas ni promediadas.
// ---------------------------------------------------------------------------
async function getFinanzasResumenData(pid) {
  const presupuestoTotal = await presupuestoTotalDe(pid);

  const { rows: ultimoRows } = await db.pool.query(`
    SELECT avance_financiero_real FROM avances_semanales
    WHERE project_id = $1 AND avance_financiero_real IS NOT NULL
    ORDER BY semana DESC LIMIT 1
  `, [pid]);
  const pctValorizado = ultimoRows[0] ? Number(ultimoRows[0].avance_financiero_real) : 0;
  const montoValorizado = Number((presupuestoTotal * (pctValorizado / 100)).toFixed(2));

  const { rows: comprasPagadoRows } = await db.pool.query(`
    SELECT COALESCE(SUM(p.monto), 0) AS total
    FROM pagos p
    JOIN ordenes_compra oc ON oc.id = p.orden_compra_id
    WHERE oc.project_id = $1 AND oc.estado != 'cancelada'
  `, [pid]);
  const comprasPagado = Number(comprasPagadoRows[0].total);

  // Comprometido: solo órdenes ya aceptadas por el proveedor (confirmada en
  // adelante) — 'enviada' aún no cuenta como compromiso real de dinero.
  const { rows: comprasComprometidoRows } = await db.pool.query(`
    SELECT oc.id,
           COALESCE(SUM(oci.importe), 0) AS importe_total,
           COALESCE((SELECT SUM(p.monto) FROM pagos p WHERE p.orden_compra_id = oc.id), 0) AS pagado
    FROM ordenes_compra oc
    LEFT JOIN orden_compra_items oci ON oci.orden_compra_id = oc.id
    WHERE oc.project_id = $1 AND oc.estado IN ('confirmada', 'recibida_parcial', 'recibida_completa')
    GROUP BY oc.id
  `, [pid]);
  const comprasComprometido = comprasComprometidoRows.reduce(
    (s, oc) => s + Math.max(0, Number(oc.importe_total) - Number(oc.pagado)), 0
  );

  const { rows: gastosPagadoRows } = await db.pool.query(
    "SELECT COALESCE(SUM(monto), 0) AS total FROM gastos_generales WHERE project_id = $1 AND estado = 'pagado'", [pid]
  );
  const gastosPagado = Number(gastosPagadoRows[0].total);

  const { rows: gastosPendienteRows } = await db.pool.query(
    "SELECT COALESCE(SUM(monto), 0) AS total FROM gastos_generales WHERE project_id = $1 AND estado = 'pendiente'", [pid]
  );
  const gastosPendiente = Number(gastosPendienteRows[0].total);

  // Destajo: costo de mano de obra realmente ejecutado (cantidad_ejecutada,
  // acumulada semana a semana en avance_destajo, × precio_destajo — el mismo
  // cálculo que ya usa la pestaña Destajo como "total_ganado"). No hay
  // distinción pagado/pendiente para destajo en el esquema actual, así que
  // se trata como pagado (mano de obra ya ejecutada = costo real incurrido).
  const { rows: destajoRows } = await db.pool.query(`
    SELECT COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS total
    FROM destajo_items di
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    WHERE di.project_id = $1
  `, [pid]);
  const destajoGanado = Number(destajoRows[0].total);

  // pagos.monto y orden_compra_items.precio_unitario se capturan con IVA
  // incluido (monto real pagado/cotizado), mientras que montoValorizado sale
  // de presupuestoTotal, que es sin IVA. Para que "Erogado Real" sea
  // comparable con "Avance Valorizado" se ajustan aquí SOLO estos dos montos
  // de compras a una base sin IVA (÷1.16) — nunca se toca lo guardado en
  // pagos ni orden_compra_items, que siguen representando el monto real con
  // IVA. gastos_generales queda fuera de este ajuste (fuera de alcance).
  const IVA_RATE = 0.16;
  const comprasPagadoSinIva = Number((comprasPagado / (1 + IVA_RATE)).toFixed(2));
  const comprasComprometidoSinIva = Number((comprasComprometido / (1 + IVA_RATE)).toFixed(2));

  const totalPagado = Number((comprasPagadoSinIva + gastosPagado + destajoGanado).toFixed(2));
  const totalComprometidoNoPagado = Number((comprasComprometidoSinIva + gastosPendiente).toFixed(2));
  const brechaMonto = Number((montoValorizado - totalPagado).toFixed(2));

  return {
    avance_valorizado: {
      pct: pctValorizado,
      monto: montoValorizado,
    },
    erogado_real: {
      compras_pagado: comprasPagadoSinIva,
      compras_pagado_con_iva: Number(comprasPagado.toFixed(2)),
      compras_comprometido: comprasComprometidoSinIva,
      compras_comprometido_con_iva: Number(comprasComprometido.toFixed(2)),
      gastos_generales_pagado: Number(gastosPagado.toFixed(2)),
      gastos_generales_pendiente: Number(gastosPendiente.toFixed(2)),
      destajo_ejecutado: Number(destajoGanado.toFixed(2)),
      total_pagado: totalPagado,
      total_comprometido_no_pagado: totalComprometidoNoPagado,
      iva_ajuste_pct: IVA_RATE * 100,
    },
    brecha: {
      monto: brechaMonto,
      descripcion: 'positivo = se ha avanzado más obra de la que se ha pagado; negativo = se ha pagado más de lo que refleja el avance reportado',
    },
    presupuesto_total: presupuestoTotal,
  };
}

module.exports = { metaToObject, presupuestoTotalDe, getFinanzasResumenData };
