'use strict';

// Órdenes de Cambio (prompt-ordenes-cambio.md, diagnóstico previo en
// prompt-diagnostico-ordenes-cambio.md) — solicitud formal de cambio de
// alcance que, al aprobarse, aplica su delta al presupuesto reusando el
// motor ya existente en server/reintegracionPresupuesto.js. Este módulo NO
// reimplementa emparejamiento ni aplicación — solo construye el "estado
// futuro" del presupuesto (existentesActivos + el delta capturado en las
// líneas) en la forma que ese motor ya espera, y orquesta la transacción de
// aprobación. Mismo patrón de separación que server/finanzas.js: los
// endpoints HTTP viven en server/app.js, la lógica de negocio aquí.

const { emparejarConceptos, aplicarCambiosConceptos } = require('./reintegracionPresupuesto');

// Construye un Map<concepto_id, fila> de los conceptos activos de la obra —
// compartido entre el cálculo de monto_delta (al capturar) y la síntesis de
// itemsNuevo (al aprobar), para que ambos vean exactamente los mismos datos.
function indexarPorId(existentesActivos) {
  return new Map(existentesActivos.map((c) => [c.id, c]));
}

// monto_delta se calcula SIEMPRE aquí, nunca se confía en un valor mandado
// por el cliente (mismo criterio que fondo_garantia_monto/estimaciones en
// el resto de la app — un dato financiero derivado nunca es input directo).
function calcularMontoDelta(existentesActivos, lineas) {
  const porId = indexarPorId(existentesActivos);
  let delta = 0;
  for (const l of lineas) {
    if (l.es_concepto_nuevo) {
      delta += Number(l.cantidad) * Number(l.precio_unitario);
    } else {
      const ex = porId.get(Number(l.concepto_id));
      if (!ex) {
        const err = new Error(`El concepto ${l.concepto_id} no existe o no pertenece a esta obra`);
        err.status = 400;
        throw err;
      }
      const importeActual = Number(ex.cantidad) * Number(ex.precio_unitario);
      const importeNuevo = Number(l.cantidad) * Number(l.precio_unitario);
      delta += importeNuevo - importeActual;
    }
  }
  return Number(delta.toFixed(2));
}

// Construye el array "itemsNuevo" que reintegracionPresupuesto.emparejarConceptos
// espera como segundo insumo (junto con los mismos existentesActivos) — es
// una representación COMPLETA del presupuesto resultante, no solo el delta:
// todo concepto activo no tocado por ninguna línea se preserva tal cual (para
// que emparejarConceptos nunca lo mande a `historicos`/soft-delete), los
// tocados por una línea de ajuste llevan sus valores nuevos, y las líneas de
// concepto nuevo se agregan al final.
function sintetizarItemsNuevo(existentesActivos, lineas) {
  const porId = indexarPorId(existentesActivos);
  // Copia superficial de cada existente activo, en la misma forma que espera
  // emparejarConceptos/aplicarCambiosConceptos (codigo/concepto/unidad/
  // cantidad/precio_unitario/importe/grupo/es_total/orden).
  const itemsPorId = new Map(existentesActivos.map((c) => [c.id, {
    codigo: c.codigo, concepto: c.concepto, unidad: c.unidad,
    cantidad: Number(c.cantidad), precio_unitario: Number(c.precio_unitario),
    importe: Number(c.importe), grupo: c.grupo, es_total: 0, orden: c.orden,
  }]));

  const nuevosDeLinea = [];
  let ordenSiguiente = 1;
  for (const l of lineas) {
    if (l.es_concepto_nuevo) {
      const cantidad = Number(l.cantidad);
      const precio = Number(l.precio_unitario);
      nuevosDeLinea.push({
        codigo: l.codigo || null,
        concepto: l.descripcion,
        unidad: l.unidad,
        cantidad, precio_unitario: precio,
        importe: cantidad * precio,
        grupo: null,
        es_total: 0,
        orden: ordenSiguiente++,
      });
      continue;
    }
    const item = itemsPorId.get(Number(l.concepto_id));
    if (!item) {
      const err = new Error(`El concepto ${l.concepto_id} no existe, no pertenece a esta obra, o ya no está activo (¿se eliminó/actualizó el presupuesto después de capturar esta orden de cambio?)`);
      err.status = 409;
      throw err;
    }
    const cantidad = Number(l.cantidad);
    const precio = Number(l.precio_unitario);
    item.cantidad = cantidad;
    item.precio_unitario = precio;
    item.importe = cantidad * precio;
  }

  return [...itemsPorId.values(), ...nuevosDeLinea];
}

// Orquesta la aprobación completa dentro de la transacción ya abierta por el
// caller (`client`): re-lee la orden con FOR UPDATE (evita doble-aprobación
// concurrente), sintetiza el presupuesto resultante, reusa el motor de
// reintegración, y solo si eso tuvo éxito marca la orden como aprobada — si
// aplicarCambiosConceptos lanza, la transacción entera se revierte (la orden
// de cambio se queda en 'pendiente', nunca aprobada a medias).
async function aprobarOrdenCambio(client, pid, ocId, aprobadoPorUserId) {
  const { rows: ocRows } = await client.query(
    'SELECT * FROM ordenes_cambio WHERE id = $1 AND project_id = $2 FOR UPDATE', [ocId, pid]
  );
  const oc = ocRows[0];
  if (!oc) { const err = new Error('Orden de cambio no encontrada'); err.status = 404; throw err; }
  if (oc.estado !== 'pendiente') {
    const err = new Error(`No se puede aprobar: la orden de cambio ya está en estado '${oc.estado}'`);
    err.status = 409;
    throw err;
  }

  const { rows: lineas } = await client.query(
    'SELECT * FROM orden_cambio_conceptos WHERE orden_cambio_id = $1', [ocId]
  );
  // Forbidden Action explícita del prompt: nunca aprobar sin líneas de
  // concepto definidas — ya se exige al crear (ver server/app.js), pero se
  // revalida aquí porque es la última puerta antes de tocar `conceptos`.
  if (!lineas.length) {
    const err = new Error('La orden de cambio no tiene líneas de concepto capturadas — no se puede aprobar');
    err.status = 400;
    throw err;
  }

  const { rows: existentesActivos } = await client.query(
    `SELECT id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo
     FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1`,
    [pid]
  );

  const itemsNuevo = sintetizarItemsNuevo(existentesActivos, lineas);
  const { emparejados, nuevos, historicos, conflictos } = emparejarConceptos(itemsNuevo, existentesActivos);

  if (conflictos.length > 0) {
    const err = new Error('Ambigüedad al aplicar la orden de cambio al presupuesto (conceptos con nombres duplicados) — no se puede aprobar automáticamente.');
    err.status = 409;
    err.conflictos = conflictos;
    throw err;
  }
  // Guardia de seguridad: itemsNuevo es por construcción un superset de
  // existentesActivos (todo concepto activo no tocado se preserva tal cual),
  // así que NUNCA debería producir históricos. Si de todos modos aparece uno
  // (bug de sintetizarItemsNuevo, o el presupuesto cambió entre captura y
  // aprobación de forma inesperada), abortar en vez de soft-borrar conceptos
  // reales sin que la orden de cambio lo haya pedido explícitamente.
  if (historicos.length > 0) {
    const err = new Error('Inconsistencia interna al aplicar la orden de cambio: marcaría conceptos existentes como históricos sin que la orden lo pida — abortando sin aplicar nada.');
    err.status = 500;
    throw err;
  }

  // Cada línea de ajuste YA es la resolución explícita (la justificación +
  // cantidad + precio nuevos se capturan juntos) — nunca hace falta
  // preguntar "precio, cantidad o ambos" como sí exige el flujo Excel.
  const resoluciones = Object.fromEntries(emparejados.map((m) => [m.existente.id, 'ambos']));
  const { totalFinal, aplicados } = await aplicarCambiosConceptos(client, pid, { emparejados, nuevos, historicos, resoluciones });

  await client.query(
    `UPDATE ordenes_cambio SET estado = 'aprobada', aprobado_por = $1, aprobado_en = NOW() WHERE id = $2`,
    [aprobadoPorUserId, ocId]
  );

  return { orden: oc, totalFinal, aplicados, nuevos: nuevos.length, emparejados: emparejados.length };
}

module.exports = { calcularMontoDelta, sintetizarItemsNuevo, aprobarOrdenCambio };
