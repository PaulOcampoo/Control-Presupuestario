'use strict';

// prompt-corte-de-obra.md: reporte comparativo Presupuesto vs Real,
// desglosado en Mano de Obra / Materiales / Equipo y Herramienta, a una
// fecha de corte manual. Módulo de solo lectura — no crea ni migra schema
// (insumos.categoria y matrices_precio_unitario ya existían, confirmado en
// Fase 0 del prompt).
//
// Real: Nómina aprobada + Destajo ejecutado (mano de obra directa, mismo
// criterio de "costo ya incurrido" que server/finanzas.js) + pagos de OC
// prorrateados por insumos.categoria (MATERIALES/MANO DE OBRA/EQUIPO Y
// HERRAMIENTA) — mismo prorrateo por peso de importe dentro de la OC que ya
// usa fetchOrdenesComprometiblesPorObra en finanzas.js para "Compromisos
// Abiertos", reescrito aquí de forma independiente (self-contained, sin
// tocar finanzas.js — Forbidden Action del prompt) porque necesita
// filtrar pagos por fecha_corte, algo que ningún agregador existente hace.
//
// Presupuesto: únicamente cuando el 100% de los conceptos activos de la
// obra tienen una matriz_precio_unitario COMPLETA (las 3 categorías con
// subtotal, vía calcularMatrizNeodata) — un desglose parcial sería, en la
// práctica, indistinguible de un $0 inventado (confirmado con datos reales:
// la obra 30 tiene 2 de 27 conceptos con matriz, ambos con cantidad=0 — una
// suma parcial ahí literalmente daría $0, el peor caso posible del "nunca
// inventar" del prompt). "Total" de Presupuesto SÍ se muestra siempre
// (presupuestoTotalDe, ya validado en producción) — es un número
// independiente de las matrices, no tiene sentido ocultarlo solo porque el
// desglose por categoría no esté completo.
//
// Matrices con algún renglón tipo='basico_ref' se tratan como incompletas
// para este reporte (no se resuelve la cadena de básicos aquí, a propósito
// — fuera de alcance, ver Forbidden Actions): ninguna obra real hoy usa
// básicos en un análisis de concepto real, confirmado en Fase 0.

const db = require('./db');
const { montoSinIva, totalConIvaDeItems } = require('./calculos');
const { calcularMatrizNeodata, MATRIZ_CATEGORIAS } = require('./matricesImport');
const { presupuestoTotalDe } = require('./finanzas');

const IVA_RATE = 0.16;
const CATEGORIAS_REPORTE = ['MATERIALES', 'MANO DE OBRA', 'EQUIPO Y HERRAMIENTA'];

function initCategorias() {
  return { MATERIALES: 0, 'MANO DE OBRA': 0, 'EQUIPO Y HERRAMIENTA': 0 };
}

// ---------------------------------------------------------------------------
// Presupuesto desglosado por categoría (vía matrices_precio_unitario)
// ---------------------------------------------------------------------------
async function buildDesglosePresupuesto(pids) {
  const resultado = new Map();
  for (const pid of pids) resultado.set(pid, { disponible: false, categorias: null });
  if (!pids.length) return resultado;

  const { rows: conceptoRows } = await db.pool.query(
    'SELECT id, project_id, cantidad FROM conceptos WHERE project_id = ANY($1) AND es_total = 0 AND activo = 1',
    [pids]
  );
  const conceptosPorProyecto = new Map();
  for (const c of conceptoRows) {
    if (!conceptosPorProyecto.has(c.project_id)) conceptosPorProyecto.set(c.project_id, []);
    conceptosPorProyecto.get(c.project_id).push(c);
  }
  const conceptoIds = conceptoRows.map((c) => c.id);
  if (!conceptoIds.length) return resultado; // sin conceptos activos -> "No disponible" en todas

  const { rows: matrizRows } = await db.pool.query(
    'SELECT * FROM matrices_precio_unitario WHERE concepto_id = ANY($1)', [conceptoIds]
  );
  const matrizPorConcepto = new Map(matrizRows.map((m) => [m.concepto_id, m]));
  const matrizIds = matrizRows.map((m) => m.id);

  const { rows: renglonRows } = matrizIds.length ? await db.pool.query(`
    SELECT r.matriz_id, r.categoria, r.tipo, r.insumo_id, r.cantidad, r.operador, r.factor_referencia, r.orden,
           i.precio_presupuesto
    FROM matriz_precio_renglones r
    LEFT JOIN insumos i ON i.id = r.insumo_id
    WHERE r.matriz_id = ANY($1)
    ORDER BY r.matriz_id, r.categoria, r.orden, r.id
  `, [matrizIds]) : { rows: [] };

  const renglonesPorMatriz = new Map();
  const matrizConBasicoRef = new Set();
  for (const r of renglonRows) {
    if (r.tipo === 'basico_ref') matrizConBasicoRef.add(r.matriz_id);
    if (!renglonesPorMatriz.has(r.matriz_id)) renglonesPorMatriz.set(r.matriz_id, []);
    renglonesPorMatriz.get(r.matriz_id).push(r);
  }

  for (const pid of pids) {
    const conceptos = conceptosPorProyecto.get(pid) || [];
    if (!conceptos.length) continue; // ya quedó "No disponible" arriba
    const subtot = initCategorias();
    let todasCompletas = true;
    for (const c of conceptos) {
      const matriz = matrizPorConcepto.get(c.id);
      if (!matriz || matrizConBasicoRef.has(matriz.id)) { todasCompletas = false; continue; }
      const renglones = renglonesPorMatriz.get(matriz.id) || [];
      const calculo = calcularMatrizNeodata(renglones, matriz);
      if (!calculo.completa) { todasCompletas = false; continue; }
      for (const cat of calculo.categorias) {
        if (!CATEGORIAS_REPORTE.includes(cat.categoria)) continue;
        subtot[cat.categoria] += (cat.subtotal || 0) * Number(c.cantidad || 0);
      }
    }
    if (todasCompletas) resultado.set(pid, { disponible: true, categorias: subtot });
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

function filaComparativa(presupuesto, real, realConIva) {
  const p = presupuesto != null ? Number(presupuesto.toFixed(2)) : null;
  const r = Number(real.toFixed(2));
  return {
    presupuesto: p,
    real: r,
    real_con_iva: Number(realConIva.toFixed(2)),
    variacion_monto: p != null ? Number((r - p).toFixed(2)) : null,
    variacion_pct: (p != null && p > 0) ? Number((((r - p) / p) * 100).toFixed(2)) : null,
  };
}

function sumarFila(obras, key) {
  const real = obras.reduce((s, o) => s + o.filas[key].real, 0);
  const realConIva = obras.reduce((s, o) => s + o.filas[key].real_con_iva, 0);
  const todasDisponibles = obras.length > 0 && obras.every((o) => o.filas[key].presupuesto != null);
  const presupuesto = todasDisponibles ? obras.reduce((s, o) => s + o.filas[key].presupuesto, 0) : null;
  return filaComparativa(presupuesto, real, realConIva);
}

// pids: obras a incluir (ya filtradas por scoping de acceso en el caller).
// scope: 'obra' | 'todas' — solo afecta qué arma el caller con la respuesta,
// esta función siempre calcula ambos (obras[] + agregado) porque es barato.
async function getCorteObraData(pids, fechaCorte) {
  if (!pids.length) return { fecha_corte: fechaCorte, obras: [], agregado: null };

  const [presupuestoMap, realMap, proyectosRows] = await Promise.all([
    buildDesglosePresupuesto(pids),
    buildDesgloseReal(pids, fechaCorte),
    db.pool.query('SELECT id, nombre FROM proyectos WHERE id = ANY($1)', [pids]),
  ]);
  const nombrePorId = new Map(proyectosRows.rows.map((r) => [r.id, r.nombre]));
  const presupuestoTotalPorPid = new Map(
    await Promise.all(pids.map(async (pid) => [pid, await presupuestoTotalDe(pid)]))
  );

  const obras = pids.map((pid) => {
    const pres = presupuestoMap.get(pid);
    const real = realMap.get(pid);
    const presCat = (cat) => (pres.disponible ? pres.categorias[cat] : null);

    const realMO = real.categorias['MANO DE OBRA'] + real.jornal + real.destajo;
    const realMOConIva = real.categoriasConIva['MANO DE OBRA'] + real.jornal + real.destajo;
    const realMat = real.categorias.MATERIALES;
    const realMatConIva = real.categoriasConIva.MATERIALES;
    const realEq = real.categorias['EQUIPO Y HERRAMIENTA'];
    const realEqConIva = real.categoriasConIva['EQUIPO Y HERRAMIENTA'];

    const filas = {
      mano_de_obra: filaComparativa(presCat('MANO DE OBRA'), realMO, realMOConIva),
      materiales: filaComparativa(presCat('MATERIALES'), realMat, realMatConIva),
      equipo_herramienta: filaComparativa(presCat('EQUIPO Y HERRAMIENTA'), realEq, realEqConIva),
      total: filaComparativa(presupuestoTotalPorPid.get(pid), realMO + realMat + realEq, realMOConIva + realMatConIva + realEqConIva),
    };

    return {
      obra: { id: pid, nombre: nombrePorId.get(pid) || `Obra ${pid}` },
      presupuesto_desglose_disponible: pres.disponible,
      filas,
      advertencias: real.sinCategoria > 0.005
        ? [`Se excluyeron ${real.sinCategoria.toFixed(2)} en pagos de OC cuyos insumos no tienen categoría asignada — no se le asignó ninguna de las 3 categorías del reporte.`]
        : [],
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

module.exports = { getCorteObraData };
