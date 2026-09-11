'use strict';

// prompt-corte-de-obra.md + prompt-corte-obra-v2-implementacion.md: reporte
// comparativo Presupuesto vs Real, desglosado en Mano de Obra / Materiales /
// Equipo y Herramienta, a una fecha de corte manual. Módulo de solo
// lectura — no crea ni migra schema.
//
// Real tiene DOS columnas (v2):
//   - Pagado: Nómina aprobada + Destajo ejecutado (costo ya incurrido,
//     mismo criterio que server/finanzas.js) + pagos de OC prorrateados por
//     insumos.categoria — mismo prorrateo por peso de importe dentro de la
//     OC que ya usa fetchOrdenesComprometiblesPorObra en finanzas.js para
//     "Compromisos Abiertos", reescrito aquí de forma independiente
//     (self-contained) porque necesita filtrar pagos por fecha_corte, algo
//     que ningún agregador existente hace.
//   - Avance Valorizado: reusa avanceValorizadoPorObra (server/finanzas.js,
//     extraída de getErogadoRealAgregado para este propósito) — SOLO Total
//     es calculable; por categoría es "No disponible" porque no existe
//     ninguna vinculación poblada entre conceptos (que tienen % de avance)
//     e insumos/categoría — concepto_insumos tiene 1 fila en toda la base y
//     ni siquiera tiene columna `cantidad` (confirmado en Fase 0 de este
//     prompt, y ya documentado en server/db.js).
//
// Por Pagar (prompt-corte-obra-rediseno.md): reusa sin cambios
// fetchOrdenesComprometiblesPorObra (server/finanzas.js) — el mismo cálculo
// exacto que ya alimenta la pestaña "Compromisos Abiertos" (OC en estado
// confirmada/recibida_parcial/recibida_completa, prorrateado por categoría,
// menos lo ya pagado). Ver buildPorPagar() abajo para el porqué de no
// filtrar por fecha_corte.
//
// Presupuesto (v2) = SUM(insumos.importe_presupuesto) GROUP BY categoria —
// reemplaza matrices_precio_unitario (diagnóstico previo: completa y
// reconciliada solo en 1 de 7 obras reales). insumos.importe_presupuesto SÍ
// tiene dato real en las 7 obras, pero sub-representa el Total oficial
// entre 11% y 64% según la obra (confirmado con reconciliación fila-por-
// fila contra el Excel original: es una limitación de la hoja "Listado de
// insumos" del archivo fuente, no una pérdida de datos en el import/parser)
// — por eso cada categoría expone `porcentaje_cobertura` contra el Total
// oficial en vez de fingir que son la misma cifra. Si Σ importe_presupuesto
// = 0 para la obra (sin insumos importados, ej. Excel con formato no
// reconocido), las 3 categorías quedan "No disponible", igual que antes.
// "Total" de Presupuesto SIGUE siendo presupuestoTotalDe/meta.total_sin_iva
// (fuente ya validada) — nunca la suma de categorías, que es una fuente
// distinta y no reconciliada a propósito (ver comentario arriba).

const db = require('./db');
const { montoSinIva, totalConIvaDeItems } = require('./calculos');
const { avanceValorizadoPorObra, fetchOrdenesComprometiblesPorObra } = require('./finanzas');

const IVA_RATE = 0.16;
const CATEGORIAS_REPORTE = ['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA'];

function initCategorias() {
  return { MATERIALES: 0, 'MANO DE OBRA': 0, 'EQUIPO Y HERRAMIENTA': 0 };
}

// ---------------------------------------------------------------------------
// Presupuesto desglosado por categoría — SUM(insumos.importe_presupuesto)
// GROUP BY categoria, project_id. Fuente directa del import de Excel (hoja
// "Listado de insumos"), independiente de matrices_precio_unitario.
// insumos.categoria es nullable a nivel de schema aunque hoy está 100%
// poblada — un insumo sin categoría NUNCA se asigna a una de las 3
// categorías del reporte (eso sería inventar el dato faltante); se excluye
// del Σ y se reporta aparte como advertencia si tiene importe > 0.
// ---------------------------------------------------------------------------
async function buildDesglosePresupuesto(pids, presupuestoTotalPorPid) {
  const resultado = new Map();
  for (const pid of pids) resultado.set(pid, { disponible: false, categorias: null, sinCategoria: 0, inconsistente: false });
  if (!pids.length) return resultado;

  const { rows } = await db.pool.query(`
    SELECT project_id, categoria, COALESCE(SUM(importe_presupuesto), 0) AS total
    FROM insumos
    WHERE project_id = ANY($1)
    GROUP BY project_id, categoria
  `, [pids]);

  const porProyecto = new Map();
  for (const pid of pids) porProyecto.set(pid, { categorias: initCategorias(), sinCategoria: 0 });
  for (const r of rows) {
    const acc = porProyecto.get(r.project_id);
    const total = Number(r.total);
    if (CATEGORIAS_REPORTE.includes(r.categoria)) acc.categorias[r.categoria] += total;
    else acc.sinCategoria += total;
  }

  for (const pid of pids) {
    const { categorias, sinCategoria } = porProyecto.get(pid);
    const suma = CATEGORIAS_REPORTE.reduce((s, cat) => s + categorias[cat], 0);
    if (suma <= 0) {
      resultado.set(pid, { disponible: false, categorias: null, sinCategoria, inconsistente: false });
      continue;
    }
    // Stop Condition del prompt: una categoría no puede superar el Total
    // oficial de la obra — si pasa, es un dato inconsistente que se debe
    // reportar explícito, nunca ocultar silenciosamente recortándolo.
    const totalOficial = presupuestoTotalPorPid.get(pid) || 0;
    const inconsistente = CATEGORIAS_REPORTE.some((cat) => totalOficial > 0 && categorias[cat] > totalOficial);
    resultado.set(pid, { disponible: true, categorias, sinCategoria, inconsistente });
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Real desglosado por categoría, con datos hasta fecha_corte
// ---------------------------------------------------------------------------
async function buildDesgloseReal(pids, fechaCorte) {
  const resultado = new Map();
  for (const pid of pids) {
    resultado.set(pid, {
      categorias: initCategorias(), categoriasConIva: initCategorias(),
      jornal: 0, destajo: 0, sinCategoria: 0,
    });
  }
  if (!pids.length) return resultado;

  // Nómina aprobada cuyo periodo ya concluyó al corte (mismo criterio de
  // "costo ya incurrido" que jornalAprobado en finanzas.js, con el filtro de
  // fecha añadido).
  const { rows: jornalRows } = await db.pool.query(`
    SELECT n.project_id AS pid, COALESCE(SUM(ni.monto_jornal), 0) AS total
    FROM nomina_items ni JOIN nominas n ON n.id = ni.nomina_id
    WHERE n.project_id = ANY($1) AND n.estado = 'aprobada' AND n.fecha_fin <= $2
    GROUP BY n.project_id
  `, [pids, fechaCorte]);
  for (const r of jornalRows) resultado.get(r.pid).jornal = Number(r.total);

  // Destajo ejecutado hasta la última semana cuyo fecha_fin ya cerró al
  // corte (avances_semanales.fecha_fin, mismo dato que ya usa el Resumen
  // para acotar por fecha una serie que solo vive indexada por # de semana).
  const { rows: destajoRows } = await db.pool.query(`
    SELECT di.project_id AS pid, COALESCE(SUM(ad.cantidad_ejecutada * di.precio_destajo), 0) AS total
    FROM destajo_items di
    JOIN avance_destajo ad ON ad.destajo_item_id = di.id
    JOIN avances_semanales av ON av.project_id = di.project_id AND av.semana = ad.semana
    WHERE di.project_id = ANY($1) AND av.fecha_fin <= $2
    GROUP BY di.project_id
  `, [pids, fechaCorte]);
  for (const r of destajoRows) resultado.get(r.pid).destajo = Number(r.total);

  // Pagos de OC hasta fecha_corte, por orden (mismo filtro estado!='cancelada'
  // y p.activo=true que compras_pagado en finanzas.js).
  const { rows: pagoRows } = await db.pool.query(`
    SELECT oc.id AS oc_id, oc.project_id AS pid, SUM(p.monto) AS pagado
    FROM ordenes_compra oc
    JOIN pagos p ON p.orden_compra_id = oc.id AND p.activo = true AND p.fecha <= $2
    WHERE oc.project_id = ANY($1) AND oc.estado != 'cancelada'
    GROUP BY oc.id, oc.project_id
  `, [pids, fechaCorte]);
  if (!pagoRows.length) return resultado;

  const ocIds = pagoRows.map((r) => r.oc_id);
  const pagadoPorOc = new Map(pagoRows.map((r) => [r.oc_id, Number(r.pagado)]));
  const proyectoPorOc = new Map(pagoRows.map((r) => [r.oc_id, r.pid]));

  // Composición por categoría de cada OC con pago (mismo patrón de
  // fetchOrdenesComprometiblesPorObra en finanzas.js: items crudos +
  // totalConIvaDeItems por (oc, categoría), respetando oc.incluye_iva).
  const { rows: itemRows } = await db.pool.query(`
    SELECT oc.id AS oc_id, oc.incluye_iva, i.categoria, oci.importe, i.iva_tasa
    FROM ordenes_compra oc
    JOIN orden_compra_items oci ON oci.orden_compra_id = oc.id
    JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
    JOIN insumos i ON i.id = ri.insumo_id
    WHERE oc.id = ANY($1)
  `, [ocIds]);

  const itemsPorOcCategoria = new Map(); // oc_id -> Map(categoria -> items[])
  const incluyeIvaPorOc = new Map();
  for (const row of itemRows) {
    incluyeIvaPorOc.set(row.oc_id, row.incluye_iva);
    if (!itemsPorOcCategoria.has(row.oc_id)) itemsPorOcCategoria.set(row.oc_id, new Map());
    const porCat = itemsPorOcCategoria.get(row.oc_id);
    // insumos.categoria es nullable a nivel de schema aunque hoy está 100%
    // poblada (confirmado en Fase 0) — un insumo sin categoría NUNCA se
    // asigna a una de las 3 categorías del reporte (eso sería inventar el
    // dato faltante); se acumula aparte y se reporta como advertencia.
    const cat = CATEGORIAS_REPORTE.includes(row.categoria) ? row.categoria : null;
    if (!porCat.has(cat)) porCat.set(cat, []);
    porCat.get(cat).push({ importe: row.importe, iva_tasa: row.iva_tasa });
  }

  for (const ocId of ocIds) {
    const pid = proyectoPorOc.get(ocId);
    const pagadoOc = pagadoPorOc.get(ocId) || 0;
    const porCat = itemsPorOcCategoria.get(ocId);
    if (!porCat || !porCat.size) continue; // OC sin items resueltos a insumo (no debería pasar)
    const incluyeIva = incluyeIvaPorOc.get(ocId);

    let importeTotalOc = 0;
    const desgloseOc = [];
    for (const [cat, items] of porCat.entries()) {
      const importe = totalConIvaDeItems(items, incluyeIva);
      desgloseOc.push({ cat, importe });
      importeTotalOc += importe;
    }

    const acc = resultado.get(pid);
    for (const { cat, importe } of desgloseOc) {
      const peso = importeTotalOc > 0 ? importe / importeTotalOc : 0;
      const pagadoCat = pagadoOc * peso;
      if (cat) acc.categoriasConIva[cat] += pagadoCat;
      else acc.sinCategoria += pagadoCat;
    }
  }

  // Ajuste sin-IVA solo para la comparación contra presupuesto (que es
  // sin IVA) — mismo criterio que comprasPagadoSinIva en finanzas.js. Nómina
  // y Destajo no llevan IVA, se dejan tal cual.
  for (const pid of pids) {
    const acc = resultado.get(pid);
    for (const cat of CATEGORIAS_REPORTE) {
      acc.categorias[cat] = montoSinIva(acc.categoriasConIva[cat], IVA_RATE);
    }
  }
  return resultado;
}

// ---------------------------------------------------------------------------
// Por Pagar por categoría (prompt-corte-obra-rediseno.md, Fase 0 confirmó
// reutilizable sin cambios en finanzas.js): mismo cálculo que ya usa
// Compromisos Abiertos (fetchOrdenesComprometiblesPorObra — OC en estado
// confirmada/recibida_parcial/recibida_completa, prorrateado por categoría
// según el peso de cada una en el importe total de la OC, menos lo ya
// pagado). A propósito NO se filtra por fecha_corte: "Por Pagar" es deuda
// abierta HOY (mismo criterio que la pestaña Compromisos Abiertos, que
// tampoco tiene noción de fecha de corte) — filtrar por una fecha de corte
// pasada requeriría rehacer el prorrateo con pagos parciales a esa fecha,
// una pieza nueva no pedida explícitamente; el caso de uso principal
// (fecha_corte = hoy, nuevo default) coincide exactamente de cualquier forma.
async function buildPorPagar(pids) {
  const resultado = new Map();
  for (const pid of pids) resultado.set(pid, { categorias: initCategorias(), sinCategoria: 0 });
  if (!pids.length) return resultado;

  const { ocMap, pagadoPorOc } = await fetchOrdenesComprometiblesPorObra(pids);
  for (const oc of ocMap.values()) {
    const acc = resultado.get(oc.project_id);
    if (!acc) continue;
    const pagadoOc = pagadoPorOc.get(oc.oc_id) || 0;
    for (const cat of oc.categorias) {
      const peso = oc.importe_total > 0 ? cat.importe / oc.importe_total : 0;
      const pendienteCat = Math.max(0, cat.importe - pagadoOc * peso);
      if (CATEGORIAS_REPORTE.includes(cat.categoria)) acc.categorias[cat.categoria] += pendienteCat;
      else acc.sinCategoria += pendienteCat;
    }
  }
  return resultado;
}

// pctCobertura: solo aplica a las 3 filas de categoría (importe_categoria /
// Total oficial); null en la fila Total (sería 100% siempre, no informativo).
// realAvanceValorizado: solo aplica a la fila Total (ver comentario de
// cabecera — por categoría no existe vinculación concepto↔insumo).
function filaComparativa(presupuesto, pctCobertura, realPagado, realPagadoConIva, realAvanceValorizado, realPorPagar) {
  const p = presupuesto != null ? Number(presupuesto.toFixed(2)) : null;
  const rp = Number(realPagado.toFixed(2));
  return {
    presupuesto: p,
    presupuesto_pct_cobertura: pctCobertura != null ? Number(pctCobertura.toFixed(1)) : null,
    real_pagado: rp,
    real_pagado_con_iva: Number(realPagadoConIva.toFixed(2)),
    real_por_pagar: Number(realPorPagar.toFixed(2)),
    real_avance_valorizado: realAvanceValorizado != null ? Number(realAvanceValorizado.toFixed(2)) : null,
    variacion_monto: p != null ? Number((rp - p).toFixed(2)) : null,
    variacion_pct: (p != null && p > 0) ? Number((((rp - p) / p) * 100).toFixed(2)) : null,
  };
}

function sumarFila(obras, key) {
  const realPagado = obras.reduce((s, o) => s + o.filas[key].real_pagado, 0);
  const realPagadoConIva = obras.reduce((s, o) => s + o.filas[key].real_pagado_con_iva, 0);
  const realPorPagar = obras.reduce((s, o) => s + o.filas[key].real_por_pagar, 0);
  const todasDisponibles = obras.length > 0 && obras.every((o) => o.filas[key].presupuesto != null);
  const presupuesto = todasDisponibles ? obras.reduce((s, o) => s + o.filas[key].presupuesto, 0) : null;
  // Cobertura agregada = Σ categoría / Σ Total oficial (nunca promedio de %
  // ya redondeados) — el Total oficial de cada obra vive en su propia fila
  // "total", reusado aquí en vez de re-sumar otra fuente.
  const totalOficialSum = obras.reduce((s, o) => s + (o.filas.total.presupuesto || 0), 0);
  const pctCobertura = (key !== 'total' && presupuesto != null && totalOficialSum > 0)
    ? (presupuesto / totalOficialSum) * 100 : null;
  const realAvanceValorizado = key === 'total'
    ? obras.reduce((s, o) => s + (o.filas[key].real_avance_valorizado || 0), 0)
    : null;
  return filaComparativa(presupuesto, pctCobertura, realPagado, realPagadoConIva, realAvanceValorizado, realPorPagar);
}

// pids: obras a incluir (ya filtradas por scoping de acceso en el caller).
// scope: 'obra' | 'todas' — solo afecta qué arma el caller con la respuesta,
// esta función siempre calcula ambos (obras[] + agregado) porque es barato.
async function getCorteObraData(pids, fechaCorte) {
  if (!pids.length) return { fecha_corte: fechaCorte, obras: [], agregado: null };

  const [avanceValorizadoRows, realMap, porPagarMap, proyectosRows] = await Promise.all([
    avanceValorizadoPorObra(pids),
    buildDesgloseReal(pids, fechaCorte),
    buildPorPagar(pids),
    db.pool.query('SELECT id, nombre FROM proyectos WHERE id = ANY($1)', [pids]),
  ]);
  const nombrePorId = new Map(proyectosRows.rows.map((r) => [r.id, r.nombre]));
  const presupuestoTotalPorPid = new Map(avanceValorizadoRows.map((r) => [r.id, r.presupuesto_total]));
  const avanceValorizadoMontoPorPid = new Map(avanceValorizadoRows.map((r) => [r.id, r.avance_monto]));

  const presupuestoMap = await buildDesglosePresupuesto(pids, presupuestoTotalPorPid);

  const obras = pids.map((pid) => {
    const pres = presupuestoMap.get(pid);
    const real = realMap.get(pid);
    const porPagar = porPagarMap.get(pid);
    const totalOficial = presupuestoTotalPorPid.get(pid) || 0;
    const presCat = (cat) => (pres.disponible ? pres.categorias[cat] : null);
    const pctCobertura = (cat) => (pres.disponible && totalOficial > 0) ? (pres.categorias[cat] / totalOficial) * 100 : null;

    const realMO = real.categorias['MANO DE OBRA'] + real.jornal + real.destajo;
    const realMOConIva = real.categoriasConIva['MANO DE OBRA'] + real.jornal + real.destajo;
    const realMat = real.categorias.MATERIALES;
    const realMatConIva = real.categoriasConIva.MATERIALES;
    const realEq = real.categorias['EQUIPO Y HERRAMIENTA'];
    const realEqConIva = real.categoriasConIva['EQUIPO Y HERRAMIENTA'];
    // Por Pagar de Mano de Obra: solo la porción comprada vía OC (mano de
    // obra subcontratada con orden de compra) — Nómina/Destajo ya son costo
    // incurrido y pagado en el mismo momento en que se captura, sin estado
    // "pendiente de pago" en el alcance actual de la app.
    const porPagarTotal = porPagar.categorias['MANO DE OBRA'] + porPagar.categorias.MATERIALES + porPagar.categorias['EQUIPO Y HERRAMIENTA'];

    const filas = {
      mano_de_obra: filaComparativa(presCat('MANO DE OBRA'), pctCobertura('MANO DE OBRA'), realMO, realMOConIva, null, porPagar.categorias['MANO DE OBRA']),
      materiales: filaComparativa(presCat('MATERIALES'), pctCobertura('MATERIALES'), realMat, realMatConIva, null, porPagar.categorias.MATERIALES),
      equipo_herramienta: filaComparativa(presCat('EQUIPO Y HERRAMIENTA'), pctCobertura('EQUIPO Y HERRAMIENTA'), realEq, realEqConIva, null, porPagar.categorias['EQUIPO Y HERRAMIENTA']),
      total: filaComparativa(totalOficial, null, realMO + realMat + realEq, realMOConIva + realMatConIva + realEqConIva, avanceValorizadoMontoPorPid.get(pid) || 0, porPagarTotal),
    };

    const advertencias = [];
    if (real.sinCategoria > 0.005) {
      advertencias.push(`Se excluyeron ${real.sinCategoria.toFixed(2)} en pagos de OC cuyos insumos no tienen categoría asignada — no se le asignó ninguna de las 3 categorías del reporte.`);
    }
    if (pres.sinCategoria > 0.005) {
      advertencias.push(`Se excluyeron ${pres.sinCategoria.toFixed(2)} de presupuesto de insumos sin categoría asignada en el catálogo — no se le asignó ninguna de las 3 categorías del reporte.`);
    }
    if (pres.inconsistente) {
      advertencias.push('El presupuesto de al menos una categoría (vía catálogo de insumos) supera el Total oficial de la obra — dato inconsistente, revisar el catálogo de insumos de esta obra.');
    }
    if (porPagar.sinCategoria > 0.005) {
      advertencias.push(`Se excluyeron ${porPagar.sinCategoria.toFixed(2)} de Por Pagar en OC cuyos insumos no tienen categoría asignada — no se le asignó ninguna de las 3 categorías del reporte.`);
    }

    return {
      obra: { id: pid, nombre: nombrePorId.get(pid) || `Obra ${pid}` },
      presupuesto_desglose_disponible: pres.disponible,
      filas,
      advertencias,
    };
  });

  const agregado = {
    mano_de_obra: sumarFila(obras, 'mano_de_obra'),
    materiales: sumarFila(obras, 'materiales'),
    equipo_herramienta: sumarFila(obras, 'equipo_herramienta'),
    total: sumarFila(obras, 'total'),
  };

  return { fecha_corte: fechaCorte, obras, agregado };
}

// ---------------------------------------------------------------------------
// Detalle de una categoría, una obra (prompt-corte-obra-rediseno.md): lo que
// buildDesgloseReal arriba SOLO trae agregado (confirmado en Fase 0 de este
// prompt), aquí se listan los renglones individuales que componen esa suma —
// mismos filtros/joins exactos que buildDesgloseReal (misma fecha_corte,
// mismo criterio "costo ya incurrido"), pero sin sumar. Nunca recalcula un
// número distinto al que ya muestra la tarjeta — solo expone el detalle
// detrás de él (Forbidden Action del prompt).
// ---------------------------------------------------------------------------
async function getCorteObraDetalleCategoria(pid, categoria, fechaCorte) {
  const insumosPromise = db.pool.query(`
    SELECT codigo, concepto, unidad, cantidad_presupuesto, precio_presupuesto, importe_presupuesto
    FROM insumos
    WHERE project_id = $1 AND categoria = $2
    ORDER BY importe_presupuesto DESC NULLS LAST, concepto
  `, [pid, categoria]);

  const movimientos = [];

  // Nómina y Destajo solo componen "Pagado" de Mano de Obra (ver
  // getCorteObraData arriba: realMO = categoria MANO DE OBRA vía OC + jornal
  // + destajo) — para cualquier otra categoría no hay nada que listar aquí.
  const nominaPromise = categoria === 'MANO DE OBRA'
    ? db.pool.query(`
        SELECT n.fecha_fin AS fecha, t.nombre AS concepto, ni.monto_jornal AS monto
        FROM nomina_items ni
        JOIN nominas n ON n.id = ni.nomina_id
        JOIN trabajadores t ON t.id = ni.trabajador_id
        WHERE n.project_id = $1 AND n.estado = 'aprobada' AND n.fecha_fin <= $2 AND ni.monto_jornal <> 0
        ORDER BY n.fecha_fin DESC
      `, [pid, fechaCorte])
    : Promise.resolve({ rows: [] });

  const destajoPromise = categoria === 'MANO DE OBRA'
    ? db.pool.query(`
        SELECT av.fecha_fin AS fecha, di.concepto, (ad.cantidad_ejecutada * di.precio_destajo) AS monto
        FROM avance_destajo ad
        JOIN destajo_items di ON di.id = ad.destajo_item_id
        JOIN avances_semanales av ON av.project_id = di.project_id AND av.semana = ad.semana
        WHERE di.project_id = $1 AND av.fecha_fin <= $2 AND (ad.cantidad_ejecutada * di.precio_destajo) <> 0
        ORDER BY av.fecha_fin DESC
      `, [pid, fechaCorte])
    : Promise.resolve({ rows: [] });

  // Pagos de OC: mismo criterio que buildDesgloseReal (estado != 'cancelada',
  // pago activo, fecha <= fecha_corte), a nivel de pago individual — luego se
  // prorratea cada pago por el peso de esta categoría dentro de SU orden
  // (mismo peso, misma fórmula que arriba), no un pago completo por renglón.
  const pagosPromise = db.pool.query(`
    SELECT p.id AS pago_id, p.fecha, p.monto, oc.id AS oc_id, oc.folio, oc.incluye_iva
    FROM pagos p
    JOIN ordenes_compra oc ON oc.id = p.orden_compra_id
    WHERE oc.project_id = $1 AND oc.estado != 'cancelada' AND p.activo = true AND p.fecha <= $2
    ORDER BY p.fecha DESC
  `, [pid, fechaCorte]);

  const [insumosRes, nominaRes, destajoRes, pagosRes] = await Promise.all([
    insumosPromise, nominaPromise, destajoPromise, pagosPromise,
  ]);

  for (const r of nominaRes.rows) {
    movimientos.push({ fecha: r.fecha, origen: 'Nómina', concepto: r.concepto, monto: Number(r.monto) });
  }
  for (const r of destajoRes.rows) {
    movimientos.push({ fecha: r.fecha, origen: 'Destajo', concepto: r.concepto, monto: Number(r.monto) });
  }

  if (pagosRes.rows.length) {
    const ocIds = [...new Set(pagosRes.rows.map((r) => r.oc_id))];
    const { rows: itemRows } = await db.pool.query(`
      SELECT oc.id AS oc_id, i.categoria, oci.importe, i.iva_tasa
      FROM ordenes_compra oc
      JOIN orden_compra_items oci ON oci.orden_compra_id = oc.id
      JOIN requisicion_items ri ON ri.id = oci.requisicion_item_id
      JOIN insumos i ON i.id = ri.insumo_id
      WHERE oc.id = ANY($1)
    `, [ocIds]);

    const itemsPorOcCategoria = new Map(); // oc_id -> Map(categoria -> items[])
    for (const row of itemRows) {
      if (!itemsPorOcCategoria.has(row.oc_id)) itemsPorOcCategoria.set(row.oc_id, new Map());
      const porCat = itemsPorOcCategoria.get(row.oc_id);
      if (!porCat.has(row.categoria)) porCat.set(row.categoria, []);
      porCat.get(row.categoria).push({ importe: row.importe, iva_tasa: row.iva_tasa });
    }

    for (const pago of pagosRes.rows) {
      const porCat = itemsPorOcCategoria.get(pago.oc_id);
      if (!porCat) continue;
      const importePorCat = new Map();
      let importeTotalOc = 0;
      for (const [cat, items] of porCat.entries()) {
        const importe = totalConIvaDeItems(items, pago.incluye_iva);
        importePorCat.set(cat, importe);
        importeTotalOc += importe;
      }
      const importeCat = importePorCat.get(categoria) || 0;
      if (importeCat <= 0 || importeTotalOc <= 0) continue;
      const peso = importeCat / importeTotalOc;
      const prorrateado = porCat.size > 1;
      movimientos.push({
        fecha: pago.fecha,
        origen: 'Orden de Compra',
        concepto: `${pago.folio || `OC #${pago.oc_id}`}${prorrateado ? ' (prorrateado por categoría)' : ''}`,
        monto: Number((pago.monto * peso).toFixed(2)),
      });
    }
  }

  movimientos.sort((a, b) => (a.fecha < b.fecha ? 1 : a.fecha > b.fecha ? -1 : 0));

  return {
    categoria,
    insumos: insumosRes.rows.map((r) => ({
      codigo: r.codigo,
      concepto: r.concepto,
      unidad: r.unidad,
      cantidad_presupuesto: Number(r.cantidad_presupuesto),
      precio_presupuesto: Number(r.precio_presupuesto),
      importe_presupuesto: Number(r.importe_presupuesto),
    })),
    movimientos,
  };
}

module.exports = { getCorteObraData, getCorteObraDetalleCategoria, CATEGORIAS_REPORTE };
