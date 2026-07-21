'use strict';

// Emparejamiento de conceptos para la actualización de presupuesto
// preservando avance (ver DISEÑO-ACTUALIZACION-PRESUPUESTO.md, aprobado por
// Paul 2026-07-21). Compartido entre el endpoint de preview y el de
// confirmar para que ambos produzcan exactamente el mismo resultado dado el
// mismo Excel y el mismo estado de la DB — nunca se duplica esta lógica.

function normalizarDescripcion(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}

// existentesDB: filas de `conceptos` del proyecto, tanto activo=1 como
// activo=0 (para soportar el caso de un concepto histórico que "regresa"),
// SIN incluir la fila es_total=1 (se excluye antes de llamar, o se filtra
// aquí igual que del lado del Excel).
// itemsExcelNuevo: conceptos parseados del Excel nuevo (server/parser.js).
//
// Devuelve { emparejados, nuevos, historicos, conflictos }:
// - emparejados: [{ existente, nuevo, via: 'codigo'|'descripcion' }]
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

  // Paso 1: emparejar por código, solo cuando es único en ambos lados.
  const sinMatchCodigo = [];
  for (const item of nuevosFiltrados) {
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
      // nuevos compitiendo por el mismo concepto viejo) — se reporta, no se
      // resuelve tomando el primero.
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

module.exports = { emparejarConceptos, normalizarDescripcion };
