'use strict';

// Emparejamiento de conceptos para la actualización de presupuesto
// preservando avance (ver DISEÑO-ACTUALIZACION-PRESUPUESTO.md, aprobado por
// Paul 2026-07-21, y prompt-conflictos-emparejamiento-presupuesto.md para el
// caso de duplicados legítimos). Compartido entre el endpoint de preview y
// el de confirmar para que ambos produzcan exactamente el mismo resultado
// dado el mismo Excel y el mismo estado de la DB — nunca se duplica esta
// lógica.

function normalizarDescripcion(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// prompt-fix-total-inflado-presupuesto.md (Capas 1 y 2) — total de
// confianza de un Excel recién parseado (parsed = resultado de
// parseWorkbook), mismo criterio EXACTO que presupuestoTotalDe()
// (server/finanzas.js) pero sobre datos en memoria, no contra la DB: nunca
// re-suma conceptos uno por uno (vulnerable a que el parser clasifique mal
// una fila de pie de página/jerarquía), siempre confía primero en el total
// que el propio Excel ya declara (parsed.meta.total_sin_iva, la fila
// "TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA"), y solo si eso falta cae al
// último concepto es_total=1 sin grupo — igual que el fallback de
// presupuestoTotalDe(). Usado por el preview (total_nuevo) y por el
// confirmar (para no sobreescribir meta.total_sin_iva con un re-sumado).
function totalConfiableDesdeParse(parsed) {
  if (parsed.meta && parsed.meta.total_sin_iva != null) return Number(parsed.meta.total_sin_iva);
  const grandTotales = parsed.conceptos.filter((c) => c.es_total && !c.grupo);
  const ultimo = grandTotales[grandTotales.length - 1];
  return ultimo ? Number(ultimo.importe) : 0;
}

// existentesDB: filas de `conceptos` del proyecto, tanto activo=1 como
// activo=0 (para soportar el caso de un concepto histórico que "regresa"),
// SIN incluir la fila es_total=1 (se excluye antes de llamar, o se filtra
// aquí igual que del lado del Excel).
// itemsExcelNuevo: conceptos parseados del Excel nuevo (server/parser.js).
//
// Devuelve { emparejados, nuevos, historicos, conflictos }:
// - emparejados: [{ existente, nuevo, via: 'codigo'|'codigo-duplicado'|'descripcion' }]
// - nuevos: [itemExcel, ...] sin match
// - historicos: [existente, ...] sin match en el Excel nuevo
// - conflictos: ambigüedades que NO se resuelven automáticamente (múltiples
//   existentes con el mismo nombre, o múltiples conceptos nuevos compitiendo
//   por el mismo concepto viejo) — deben reportarse, nunca adivinarse.
function emparejarConceptos(itemsExcelNuevo, existentesDB) {
  const nuevosFiltrados = itemsExcelNuevo.filter((c) => !c.es_total);
  const existentes = existentesDB.filter((c) => !c.es_total);

  // Un código duplicado en cualquiera de los dos lados invalida el match por
  // código SOLO para esos conceptos específicos (no bloquea toda la carga
  // por un problema de datos preexistente) — cae a comparación por
  // descripción, igual que si no tuviera código.
  const countByCode = new Map();
  for (const c of existentes) if (c.codigo) countByCode.set(c.codigo, (countByCode.get(c.codigo) || 0) + 1);
  const excelCountByCode = new Map();
  for (const c of nuevosFiltrados) if (c.codigo) excelCountByCode.set(c.codigo, (excelCountByCode.get(c.codigo) || 0) + 1);

  const existentesByCode = new Map();
  for (const c of existentes) {
    if (!c.codigo) continue;
    if (!existentesByCode.has(c.codigo)) existentesByCode.set(c.codigo, []);
    existentesByCode.get(c.codigo).push(c);
  }
  const existentesByDesc = new Map();
  for (const c of existentes) {
    const key = normalizarDescripcion(c.concepto);
    if (!existentesByDesc.has(key)) existentesByDesc.set(key, []);
    existentesByDesc.get(key).push(c);
  }

  const usedExistenteIds = new Set();
  const enConflictoIds = new Set();
  const emparejados = [];
  const nuevos = [];
  const conflictos = [];

  // Paso 0: duplicados LEGÍTIMOS en el Excel nuevo (misma partida repetida
  // en distintas zonas/áreas — caso real confirmado por Paul, ver
  // prompt-conflictos-emparejamiento-presupuesto.md). Un código con 2+ filas
  // en el Excel nuevo ya no es un conflicto bloqueante: la primera fila
  // empareja normalmente contra el existente (preserva concepto_id/avance/
  // destajo/finanzas), las filas adicionales se agregan como conceptos
  // nuevos. También aplica emparejamiento posicional cuando el código está
  // duplicado en AMBOS lados con el MISMO conteo (metodología AJAL: la
  // primera carga de un presupuesto con partidas repetidas por zona deja la
  // DB con ese mismo patrón N-a-N, y toda actualización subsecuente debe
  // seguir emparejando por posición, no solo la primera — confirmado con
  // datos reales de Kalia, prompt-fase0/fase1-emparejamiento-duplicados-
  // legitimos.md: 12 conflictos → 0). Solo el conteo DISTINTO entre Excel y
  // DB sigue siendo ambigüedad real de datos preexistente sin forma no
  // ambigua de resolverse, y se deja caer al fallback por descripción.
  const codigosDuplicadosExcel = new Set();
  for (const item of nuevosFiltrados) {
    if (!item.codigo) continue;
    if ((excelCountByCode.get(item.codigo) || 0) <= 1) continue;
    const enDB = countByCode.get(item.codigo) || 0;
    if (enDB > 1 && enDB !== excelCountByCode.get(item.codigo)) continue;
    codigosDuplicadosExcel.add(item.codigo);
  }
  for (const codigo of codigosDuplicadosExcel) {
    const itemsDelCodigo = nuevosFiltrados.filter((i) => i.codigo === codigo);
    const candidatos = existentesByCode.get(codigo) || [];
    itemsDelCodigo.forEach((item, i) => {
      if (i < candidatos.length) {
        usedExistenteIds.add(candidatos[i].id);
        emparejados.push({ existente: candidatos[i], nuevo: item, via: 'codigo-duplicado' });
      } else {
        nuevos.push(item);
      }
    });
  }

  // Paso 1: emparejar por código, solo cuando es único en ambos lados (los
  // duplicados legítimos del Paso 0 ya quedaron resueltos y se excluyen aquí).
  const sinMatchCodigo = [];
  for (const item of nuevosFiltrados) {
    if (item.codigo && codigosDuplicadosExcel.has(item.codigo)) continue;
    if (item.codigo && countByCode.get(item.codigo) === 1 && excelCountByCode.get(item.codigo) === 1) {
      const existente = existentesByCode.get(item.codigo)[0];
      usedExistenteIds.add(existente.id);
      emparejados.push({ existente, nuevo: item, via: 'codigo' });
    } else {
      sinMatchCodigo.push(item);
    }
  }

  // Paso 2: fallback a descripción para lo que no empató por código —
  // agrupado por descripción normalizada para detectar ambigüedad en
  // cualquiera de las dos direcciones antes de decidir.
  const nuevosPorDesc = new Map();
  for (const item of sinMatchCodigo) {
    const key = normalizarDescripcion(item.concepto);
    if (!nuevosPorDesc.has(key)) nuevosPorDesc.set(key, []);
    nuevosPorDesc.get(key).push(item);
  }

  for (const [key, itemsExcel] of nuevosPorDesc) {
    const candidatos = (existentesByDesc.get(key) || []).filter((e) => !usedExistenteIds.has(e.id));
    if (itemsExcel.length === 1 && candidatos.length === 1) {
      usedExistenteIds.add(candidatos[0].id);
      emparejados.push({ existente: candidatos[0], nuevo: itemsExcel[0], via: 'descripcion' });
    } else if (candidatos.length > 1 || (itemsExcel.length > 1 && candidatos.length >= 1)) {
      // Ambigüedad real (2 existentes con el mismo nombre, o 2+ conceptos
      // nuevos compitiendo por el mismo concepto viejo, sin que se trate del
      // caso de duplicados legítimos por código ya resuelto en el Paso 0) —
      // se reporta, no se resuelve tomando el primero.
      candidatos.forEach((e) => enConflictoIds.add(e.id));
      conflictos.push({
        descripcion: key,
        nuevos: itemsExcel.map((i) => ({ codigo: i.codigo || null, concepto: i.concepto })),
        existentes: candidatos.map((e) => ({ concepto_id: e.id, codigo: e.codigo, concepto: e.concepto })),
      });
    } else {
      for (const item of itemsExcel) nuevos.push(item);
    }
  }

  const historicos = existentes.filter((e) => !usedExistenteIds.has(e.id) && !enConflictoIds.has(e.id));

  return { emparejados, nuevos, historicos, conflictos };
}

// Determina si un concepto emparejado tiene un cambio de precio/cantidad
// ambiguo que requiere confirmación explícita de Paul (selector precio /
// cantidad / ambos) en vez de aplicarse en silencio:
// - Cambian precio Y cantidad a la vez en un emparejamiento 1:1 normal: no
//   es claro si es cambio de precio, de volumen, o ambos genuinamente.
// - El emparejamiento vino de un código duplicado legítimo (Paso 0) y la
//   fila que quedó pegada al concepto existente trae precio o cantidad
//   distintos: afecta a varias filas del mismo código, así que tampoco es
//   mecánicamente claro que ese cambio aplique al concepto existente.
// Un solo campo distinto (precio O cantidad, no ambos) en un match 1:1
// normal sigue sin ser ambiguo — se aplica igual que hoy, solo informativo.
function calcularCambios(m) {
  const cambiaPrecio = Number(m.existente.precio_unitario) !== Number(m.nuevo.precio_unitario);
  const cambiaCantidad = Number(m.existente.cantidad) !== Number(m.nuevo.cantidad);
  const ambiguo = (cambiaPrecio && cambiaCantidad) || (m.via === 'codigo-duplicado' && (cambiaPrecio || cambiaCantidad));
  return { cambiaPrecio, cambiaCantidad, ambiguo };
}

// Motor de aplicación (prompt-ordenes-cambio.md): extraído tal cual del
// bloque que antes vivía inline en el handler de POST /presupuesto/
// actualizar/confirmar (server/app.js) — mismo SQL, mismo orden de
// operaciones, sin cambiar comportamiento del flujo Excel existente. Se
// extrae para que Órdenes de Cambio pueda reusar el mismo motor de
// aplicación al presupuesto en vez de reimplementarlo (Forbidden Action
// explícita de ese prompt). `client` debe venir de una transacción abierta
// por el caller (db.withTransaction) — esta función no abre/cierra
// transacción propia, ambos callers (Excel y Orden de Cambio) necesitan que
// la actualización de `ordenes_cambio`/el audit_log específico de cada uno
// viva en la MISMA transacción que la escritura a `conceptos`.
//
// resoluciones: { [concepto_id]: 'precio'|'cantidad'|'ambos' } — cómo
// resolver un emparejado donde precio Y cantidad cambian a la vez
// (calcularCambios().ambiguo). El caller Excel exige que el usuario elija
// explícitamente antes de llamar esta función (ver validación previa en
// server/app.js); el caller Orden de Cambio pasa 'ambos' siempre, porque ahí
// la línea capturada YA es la resolución explícita (justificación + cantidad
// + precio nuevos van juntos en la misma captura).
//
// Devuelve { totalFinal, aplicados } — aplicados es el detalle por concepto
// emparejado (para que cada caller arme su propio audit_log.detalle con el
// formato que ya usaba).
// totalConfianzaExcel (prompt-fix-total-inflado-presupuesto.md, Capa 2):
// OPCIONAL — cuando el caller viene de un Excel (Actualizar presupuesto),
// pasa aquí totalConfiableDesdeParse(parsed) del archivo recién parseado,
// y ese valor se usa TAL CUAL para meta.total_sin_iva en vez de re-sumar
// conceptos (la misma re-suma que puede inflarse si el parser clasifica
// mal una fila de pie de página — ver diagnóstico completo en el prompt).
// El caller de Órdenes de Cambio (server/ordenesCambio.js) NO tiene un
// Excel de origen del que tomar un total de confianza — nunca pasa este
// parámetro, y sigue re-sumando exactamente como antes; es el único
// criterio válido ahí, ya que una orden de cambio modifica conceptos
// incrementalmente sin un archivo completo de referencia.
async function aplicarCambiosConceptos(client, pid, { emparejados, nuevos, historicos, resoluciones = {} }, totalConfianzaExcel = null) {
  const { rows: maxOrdenRows } = await client.query(
    'SELECT COALESCE(MAX(orden), 0) AS max_orden FROM conceptos WHERE project_id = $1', [pid]
  );
  const maxOrdenExistente = Number(maxOrdenRows[0].max_orden);

  const aplicados = [];
  for (const m of emparejados) {
    const { existente, nuevo } = m;
    const { ambiguo } = calcularCambios(m);
    let cantidadFinal = Number(nuevo.cantidad);
    let precioFinal = Number(nuevo.precio_unitario);
    if (ambiguo) {
      const eleccion = resoluciones[existente.id];
      if (eleccion === 'precio') cantidadFinal = Number(existente.cantidad);
      else if (eleccion === 'cantidad') precioFinal = Number(existente.precio_unitario);
      // 'ambos' deja cantidadFinal/precioFinal tal cual vienen del origen.
    }
    const importe = cantidadFinal * precioFinal;
    aplicados.push({
      concepto_id: existente.id,
      codigo: existente.codigo,
      precio_anterior: existente.precio_unitario,
      precio_nuevo: precioFinal,
      cantidad_anterior: existente.cantidad,
      cantidad_nueva: cantidadFinal,
    });
    await client.query(
      `UPDATE conceptos SET codigo=$1, concepto=$2, unidad=$3, cantidad=$4, precio_unitario=$5, importe=$6, grupo=$7, activo=1
       WHERE id=$8`,
      [nuevo.codigo || null, nuevo.concepto, nuevo.unidad, cantidadFinal, precioFinal, importe, nuevo.grupo, existente.id]
    );
  }

  for (const nuevo of nuevos) {
    const importe = Number(nuevo.cantidad) * Number(nuevo.precio_unitario);
    await client.query(
      `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9,1)`,
      [pid, nuevo.codigo || null, nuevo.concepto, nuevo.unidad, nuevo.cantidad, nuevo.precio_unitario, importe, nuevo.grupo, maxOrdenExistente + nuevo.orden]
    );
  }

  for (const existente of historicos) {
    await client.query('UPDATE conceptos SET activo = 0 WHERE id = $1', [existente.id]);
  }

  // Recalcula meta.total_sin_iva contra el conjunto activo resultante — o,
  // si viene un total de confianza del Excel (ver comentario del parámetro
  // arriba), usa ese directamente sin re-sumar.
  let totalFinal;
  if (totalConfianzaExcel != null) {
    totalFinal = Number(totalConfianzaExcel);
  } else {
    const { rows: totalRows } = await client.query(
      'SELECT COALESCE(SUM(importe), 0) AS total FROM conceptos WHERE project_id = $1 AND es_total = 0 AND activo = 1',
      [pid]
    );
    totalFinal = Number(totalRows[0].total);
  }
  await client.query(
    `INSERT INTO meta (project_id, clave, valor) VALUES ($1, 'total_sin_iva', $2)
     ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
    [pid, String(totalFinal)]
  );

  // prompt-fix-calcular-total-con-iva.md: total_con_iva/iva_importe NUNCA se
  // leen de una celda del Excel (tampoco en el alta original — ver
  // extractMeta() en parser.js) — siempre se CALCULAN desde total_sin_iva
  // (recién actualizado arriba) e iva_pct (guardado en meta, estable —
  // confirmado "16.00" en todos los proyectos reales de Preview antes de
  // este fix). Antes, total_con_iva/iva_importe solo se escribían una vez en
  // el alta y quedaban congelados en cada actualización posterior —
  // diagnóstico real: proyecto Kalia "Amenidades", total_sin_iva se
  // actualizaba bien pero total_con_iva quedaba desfasado $493.17 del valor
  // correcto porque venía de un Excel de una carga anterior.
  const { rows: ivaPctRows } = await client.query(
    `SELECT valor FROM meta WHERE project_id = $1 AND clave = 'iva_pct'`, [pid]
  );
  if (ivaPctRows[0]) {
    const ivaPct = Number(ivaPctRows[0].valor);
    const ivaImporte = Math.round(totalFinal * (ivaPct / 100) * 100) / 100;
    const totalConIva = Math.round((totalFinal + ivaImporte) * 100) / 100;
    await client.query(
      `INSERT INTO meta (project_id, clave, valor) VALUES ($1, 'iva_importe', $2), ($1, 'total_con_iva', $3)
       ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [pid, String(ivaImporte), String(totalConIva)]
    );
  }

  // Recalcula avance_financiero_real de toda semana con avance capturado,
  // contra los precios/volúmenes ya actualizados arriba y el total nuevo.
  const { rows: semanasConAvance } = await client.query(
    `SELECT DISTINCT ac.semana FROM avance_conceptos ac
     JOIN conceptos c ON c.id = ac.concepto_id
     WHERE c.project_id = $1`,
    [pid]
  );
  for (const { semana } of semanasConAvance) {
    const { rows: acumRows } = await client.query(
      `SELECT COALESCE(SUM(ac.cantidad_ejecutada * c.precio_unitario), 0) AS monto
       FROM avance_conceptos ac JOIN conceptos c ON c.id = ac.concepto_id
       WHERE c.project_id = $1 AND ac.semana <= $2`,
      [pid, semana]
    );
    const montoEjecutado = Number(acumRows[0].monto);
    const financiero = totalFinal > 0 ? Number(((montoEjecutado / totalFinal) * 100).toFixed(2)) : 0;
    await client.query(
      'UPDATE avances_semanales SET avance_financiero_real = $1 WHERE project_id = $2 AND semana = $3',
      [financiero, pid, semana]
    );
  }

  return { totalFinal, aplicados };
}

module.exports = { emparejarConceptos, normalizarDescripcion, calcularCambios, aplicarCambiosConceptos, totalConfiableDesdeParse };
