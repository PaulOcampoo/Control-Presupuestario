'use strict';

// Extraído tal cual desde server/app.js (prompt-estado-resultados-tesoreria)
// para que el módulo de Estado de Resultados (Tesorería) pueda reutilizar
// "Erogado Real" sin duplicar la query — comportamiento sin cambios.

const db = require('./db');
const { montoSinIva } = require('./calculos');

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

  // Destajo huérfano: destajistas sin ningún trabajador vinculado
  // (trabajadores.destajista_id) — ya está incluido dentro de destajoGanado
  // arriba (no se resta ni se excluye, es costo real ejecutado), pero se
  // reporta aparte, rotulado, porque nunca pasa por nomina_items y por lo
  // tanto no es reconciliable contra ninguna nómina real (mismo criterio de
  // diagnóstico usado en prompt-9/PR #91).
  const { rows: destajoHuerfanoRows } = await db.pool.query(`
    SELECT COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS total
    FROM destajistas dst
    JOIN destajo_items di ON di.destajista_id = dst.id
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    WHERE dst.project_id = $1
      AND NOT EXISTS (SELECT 1 FROM trabajadores t WHERE t.destajista_id = dst.id)
  `, [pid]);
  const destajoHuerfano = Number(destajoHuerfanoRows[0].total);

  // Jornal: sueldo por día trabajado ya pagado, sumado desde nomina_items.
  // Solo nóminas estado='aprobada' cuentan como gasto real (mismo criterio
  // que destajo/PR #91) — una nómina en 'borrador' o 'rechazada' no
  // representa dinero efectivamente pagado todavía.
  const { rows: jornalRows } = await db.pool.query(`
    SELECT COALESCE(SUM(ni.monto_jornal), 0) AS total
    FROM nomina_items ni
    JOIN nominas n ON n.id = ni.nomina_id
    WHERE n.project_id = $1 AND n.estado = 'aprobada'
  `, [pid]);
  const jornalAprobado = Number(jornalRows[0].total);

  // pagos.monto y orden_compra_items.precio_unitario se capturan con IVA
  // incluido (monto real pagado/cotizado), mientras que montoValorizado sale
  // de presupuestoTotal, que es sin IVA. Para que "Erogado Real" sea
  // comparable con "Avance Valorizado" se ajustan aquí SOLO estos dos montos
  // de compras a una base sin IVA (÷1.16) — nunca se toca lo guardado en
  // pagos ni orden_compra_items, que siguen representando el monto real con
  // IVA. gastos_generales queda fuera de este ajuste (fuera de alcance).
  const IVA_RATE = 0.16;
  const comprasPagadoSinIva = montoSinIva(comprasPagado, IVA_RATE);
  const comprasComprometidoSinIva = montoSinIva(comprasComprometido, IVA_RATE);

  const totalPagado = Number((comprasPagadoSinIva + gastosPagado + destajoGanado + jornalAprobado).toFixed(2));
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
      destajo_huerfano: Number(destajoHuerfano.toFixed(2)),
      jornal_aprobado: Number(jornalAprobado.toFixed(2)),
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

// ---------------------------------------------------------------------------
// Compromisos Abiertos (prompt-compromisos-abiertos.md): desglose por
// categoría/proveedor del mismo "comprometido no pagado" que ya calcula
// getFinanzasResumenData arriba (mismo filtro de estatus de OC, misma
// fórmula Math.max(0, total - pagado) por OC) — NO se toca ni se reusa esa
// función para no arriesgar el número ya validado en producción; esta es una
// query independiente que debe reproducir el mismo resultado agregado.
//
// Una OC puede mezclar insumos de varias categorías (insumos.categoria:
// MATERIALES/MANO DE OBRA/EQUIPO Y HERRAMIENTA/...), pero los pagos se
// registran contra la OC completa, no por renglón — no existe un dato real
// de "cuánto de lo pagado corresponde a cada categoría". Decisión confirmada
// con Paul: prorratear pagado/pendiente por el peso de cada categoría en el
// importe total de la OC (peso = importe_categoria / importe_total_oc). Es
// una estimación, no un hecho — el campo `prorrateado` marca las filas de
// una OC con más de una categoría para que la UI lo etiquete como tal.
//
// La suma de Math.max(0, cat.importe - cat.pagado) sobre todas las
// categorías de una OC es matemáticamente idéntica a Math.max(0,
// importe_total_oc - pagado_oc) (el peso de pagado es uniforme entre
// categorías de una misma OC), así que el total agregado aquí coincide
// centavo a centavo con `compras_comprometido_con_iva` de
// getFinanzasResumenData sin necesidad de compartir código.
// ---------------------------------------------------------------------------
async function getCompromisosAbiertosData(pid) {
  const ESTATUS_COMPROMETIBLE = "('confirmada', 'recibida_parcial', 'recibida_completa')";

  const { rows: itemRows } = await db.pool.query(`
    SELECT oc.id AS oc_id, oc.folio, oc.fecha, oc.estado,
           pv.id AS proveedor_id, pv.nombre AS proveedor_nombre,
           i.categoria, COALESCE(SUM(oci.importe), 0) AS importe_categoria
    FROM ordenes_compra oc
    JOIN proveedores pv ON pv.id = oc.proveedor_id
    JOIN orden_compra_items oci ON oci.orden_compra_id = oc.id
    JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE oc.project_id = $1 AND oc.estado IN ${ESTATUS_COMPROMETIBLE}
    GROUP BY oc.id, oc.folio, oc.fecha, oc.estado, pv.id, pv.nombre, i.categoria
    ORDER BY oc.fecha DESC, oc.id DESC
  `, [pid]);

  const { rows: pagoRows } = await db.pool.query(`
    SELECT oc.id AS oc_id, COALESCE(SUM(p.monto), 0) AS pagado
    FROM ordenes_compra oc
    LEFT JOIN pagos p ON p.orden_compra_id = oc.id
    WHERE oc.project_id = $1 AND oc.estado IN ${ESTATUS_COMPROMETIBLE}
    GROUP BY oc.id
  `, [pid]);
  const pagadoPorOc = new Map(pagoRows.map((r) => [r.oc_id, Number(r.pagado)]));

  const ocMap = new Map();
  for (const row of itemRows) {
    if (!ocMap.has(row.oc_id)) {
      ocMap.set(row.oc_id, {
        oc_id: row.oc_id, folio: row.folio, fecha: row.fecha, estado: row.estado,
        proveedor_id: row.proveedor_id, proveedor_nombre: row.proveedor_nombre,
        categorias: [], importe_total: 0,
      });
    }
    const oc = ocMap.get(row.oc_id);
    const importe = Number(row.importe_categoria);
    oc.categorias.push({ categoria: row.categoria || 'Sin categoría', importe });
    oc.importe_total += importe;
  }

  const filas = [];
  let totalRaw = 0, pagadoRaw = 0, pendienteRaw = 0;
  for (const oc of ocMap.values()) {
    const pagadoOc = pagadoPorOc.get(oc.oc_id) || 0;
    const prorrateado = oc.categorias.length > 1;
    for (const cat of oc.categorias) {
      const peso = oc.importe_total > 0 ? cat.importe / oc.importe_total : 0;
      const pagadoCat = pagadoOc * peso;
      const pendienteCat = Math.max(0, cat.importe - pagadoCat);
      totalRaw += cat.importe;
      pagadoRaw += pagadoCat;
      pendienteRaw += pendienteCat;
      filas.push({
        oc_id: oc.oc_id,
        folio: oc.folio || `OC #${oc.oc_id}`,
        fecha: oc.fecha,
        estado: oc.estado,
        proveedor_id: oc.proveedor_id,
        proveedor_nombre: oc.proveedor_nombre,
        categoria: cat.categoria,
        monto_total: Number(cat.importe.toFixed(2)),
        monto_pagado: Number(pagadoCat.toFixed(2)),
        monto_pendiente: Number(pendienteCat.toFixed(2)),
        prorrateado,
      });
    }
  }

  return {
    filas,
    total: {
      monto_total: Number(totalRaw.toFixed(2)),
      monto_pagado: Number(pagadoRaw.toFixed(2)),
      monto_pendiente: Number(pendienteRaw.toFixed(2)),
    },
  };
}

module.exports = { metaToObject, presupuestoTotalDe, getFinanzasResumenData, getCompromisosAbiertosData };
