'use strict';

/*
 * Generación automática del programa de ejecución de los trabajos y de la
 * curva de avance físico-financiero (programado), a partir de:
 *   - Fecha de inicio / fin de obra (tomadas del presupuesto)
 *   - El peso económico (importe) de cada concepto dentro de su frente
 *     de trabajo ("grupo": p.ej. "CALLE LLANURAS", "PASEO PUNTA CUERNA 2")
 *
 * Metodología: cada frente de trabajo corre a lo largo de toda la duración
 * de la obra; dentro de cada frente los conceptos se calendarizan de forma
 * secuencial, con duración proporcional a su peso económico (% de incidencia
 * dentro del frente). El avance financiero programado de cada semana es la
 * suma ponderada del importe de los conceptos activos esa semana entre el
 * importe total del presupuesto (curva "S" clásica). El avance físico
 * programado se aproxima con el mismo peso económico, que es la práctica
 * estándar cuando no se dispone de métricas físicas independientes por
 * concepto.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(str) {
  if (!str) return null;
  const d = new Date(`${str}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * DAY_MS);
}

function diffDays(a, b) {
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

// Only "leaf" budget lines represent actual schedulable work (real unit,
// quantity and amount; not group headers nor TOTAL rows).
function leafConcepts(conceptos) {
  return conceptos.filter((c) => !c.es_total && c.unidad && c.importe > 0);
}

function buildPrograma(conceptos, meta) {
  const inicio = parseDate(meta.inicio_obra);
  const fin = parseDate(meta.fin_obra);
  if (!inicio || !fin || fin <= inicio) return { items: [], inicio: null, fin: null, totalDias: 0 };

  const totalDias = diffDays(inicio, fin) + 1;
  const items = leafConcepts(conceptos);

  const groups = new Map();
  for (const item of items) {
    const key = item.grupo || 'GENERAL';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const result = [];
  let orden = 0;
  for (const [grupo, groupItems] of groups) {
    const groupTotal = groupItems.reduce((s, it) => s + it.importe, 0) || 1;
    let cumWeight = 0;
    groupItems.forEach((item, idx) => {
      const weight = item.importe / groupTotal;
      const startOffset = Math.round(cumWeight * totalDias);
      cumWeight += weight;
      const isLast = idx === groupItems.length - 1;
      const endOffset = isLast ? totalDias - 1 : Math.max(startOffset, Math.round(cumWeight * totalDias) - 1);
      const start = addDays(inicio, startOffset);
      const end = addDays(inicio, Math.max(endOffset, startOffset));
      orden += 1;
      result.push({
        codigo: item.codigo,
        concepto: item.concepto,
        grupo,
        fecha_inicio: fmt(start),
        fecha_fin: fmt(end),
        duracion_dias: diffDays(start, end) + 1,
        importe: item.importe,
        peso_pct: item.importe / (totalImporte(conceptos) || 1),
        orden,
      });
    });
  }
  return { items: result, inicio, fin, totalDias };
}

function totalImporte(conceptos) {
  // Prefer the grand-total row; fall back to summing leaf concepts.
  const totalRow = conceptos.find((c) => c.es_total && /^TOTAL\s+AP|^TOTAL\s+/.test(c.concepto.toUpperCase()) && !c.grupo);
  const grand = conceptos.filter((c) => c.es_total).sort((a, b) => b.importe - a.importe)[0];
  if (grand) return grand.importe;
  return leafConcepts(conceptos).reduce((s, c) => s + c.importe, 0);
}

function buildAvanceSemanal(programa, conceptos) {
  const { items, inicio, fin, totalDias } = programa;
  if (!inicio || !fin || items.length === 0) return [];

  const total = totalImporte(conceptos) || items.reduce((s, i) => s + i.importe, 0) || 1;
  const numWeeks = Math.ceil(totalDias / 7);
  const weeks = [];
  let cumFinanciero = 0;

  for (let w = 0; w < numWeeks; w += 1) {
    const weekStart = addDays(inicio, w * 7);
    const weekEndCandidate = addDays(inicio, Math.min(w * 7 + 6, totalDias - 1));
    const weekEnd = weekEndCandidate > fin ? fin : weekEndCandidate;

    let weeklyAmount = 0;
    for (const item of items) {
      const itemStart = parseDate(item.fecha_inicio);
      const itemEnd = parseDate(item.fecha_fin);
      const overlapStart = itemStart > weekStart ? itemStart : weekStart;
      const overlapEnd = itemEnd < weekEnd ? itemEnd : weekEnd;
      const overlapDays = diffDays(overlapStart, overlapEnd) + 1;
      if (overlapDays > 0) {
        const fraction = overlapDays / item.duracion_dias;
        weeklyAmount += fraction * item.importe;
      }
    }

    cumFinanciero += weeklyAmount;
    const pctFinanciero = Math.min(100, (cumFinanciero / total) * 100);

    weeks.push({
      semana: w + 1,
      fecha_inicio: fmt(weekStart),
      fecha_fin: fmt(weekEnd),
      avance_fisico_programado: Number(pctFinanciero.toFixed(2)),
      avance_fisico_real: null,
      avance_financiero_programado: Number(pctFinanciero.toFixed(2)),
      avance_financiero_real: null,
    });
  }
  return weeks;
}

function generatePlanning(conceptos, meta) {
  const programa = buildPrograma(conceptos, meta);
  const avances = buildAvanceSemanal(programa, conceptos);
  return { programa: programa.items, avances, totalImporte: totalImporte(conceptos) };
}

module.exports = { generatePlanning, totalImporte };
