'use strict';

const { generatePlanning } = require('./planning');

async function ingest(client, projectId, parsed) {
  const upsertMeta = `
    INSERT INTO meta (project_id, clave, valor) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor
  `;
  for (const [k, v] of Object.entries(parsed.meta)) {
    if (v != null) await client.query(upsertMeta, [projectId, k, String(v)]);
  }

  for (const c of parsed.conceptos) {
    await client.query(
      `INSERT INTO conceptos
         (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [projectId, c.codigo, c.concepto, c.unidad, c.cantidad, c.precio_unitario, c.importe, c.grupo, c.es_total, c.orden]
    );
  }

  for (const i of parsed.insumos) {
    await client.query(
      `INSERT INTO insumos
         (project_id, codigo, concepto, categoria, unidad, cantidad_presupuesto, precio_presupuesto, importe_presupuesto, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [projectId, i.codigo, i.concepto, i.categoria, i.unidad, i.cantidad_presupuesto, i.precio_presupuesto, i.importe_presupuesto, i.orden]
    );
  }

  const plan = generatePlanning(parsed.conceptos, parsed.meta);

  for (const p of plan.programa) {
    await client.query(
      `INSERT INTO programa_ejecucion
         (project_id, codigo, concepto, grupo, fecha_inicio, fecha_fin, duracion_dias, importe, peso_pct, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [projectId, p.codigo, p.concepto, p.grupo, p.fecha_inicio, p.fecha_fin, p.duracion_dias, p.importe, p.peso_pct, p.orden]
    );
  }

  for (const a of plan.avances) {
    await client.query(
      `INSERT INTO avances_semanales
         (project_id, semana, fecha_inicio, fecha_fin, avance_fisico_programado, avance_fisico_real, avance_financiero_programado, avance_financiero_real)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, a.semana, a.fecha_inicio, a.fecha_fin, a.avance_fisico_programado, a.avance_fisico_real, a.avance_financiero_programado, a.avance_financiero_real]
    );
  }
}

module.exports = { ingest };
