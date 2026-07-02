'use strict';

const { generatePlanning } = require('./planning');

// Inserta muchas filas en pocas consultas (en vez de un round-trip por fila,
// que en Neon/Vercel puede tardar tanto que la función serverless expira a
// mitad de la carga y el navegador lo ve como un corte de conexión).
async function batchInsert(client, table, columns, rows, extraSql = '') {
  if (!rows.length) return [];
  const chunkSize = 400; // columns * chunkSize debe quedar bien por debajo del límite de 65535 params
  const allRows = [];
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const tuples = chunk.map((row, idx) => {
      const base = idx * columns.length;
      values.push(...row);
      return `(${columns.map((_, ci) => `$${base + ci + 1}`).join(',')})`;
    });
    const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ${extraSql}`;
    const { rows: resultRows } = await client.query(sql, values);
    allRows.push(...resultRows);
  }
  return allRows;
}

async function ingest(client, projectId, parsed) {
  const metaEntries = Object.entries(parsed.meta).filter(([, v]) => v != null);
  if (metaEntries.length) {
    await batchInsert(
      client, 'meta', ['project_id', 'clave', 'valor'],
      metaEntries.map(([k, v]) => [projectId, k, String(v)]),
      'ON CONFLICT (project_id, clave) DO UPDATE SET valor = EXCLUDED.valor'
    );
  }

  await batchInsert(
    client, 'conceptos',
    ['project_id', 'codigo', 'concepto', 'unidad', 'cantidad', 'precio_unitario', 'importe', 'grupo', 'es_total', 'orden'],
    parsed.conceptos.map((c) => [projectId, c.codigo, c.concepto, c.unidad, c.cantidad, c.precio_unitario, c.importe, c.grupo, c.es_total, c.orden])
  );

  await batchInsert(
    client, 'insumos',
    ['project_id', 'codigo', 'concepto', 'categoria', 'unidad', 'cantidad_presupuesto', 'precio_presupuesto', 'importe_presupuesto', 'orden'],
    parsed.insumos.map((i) => [projectId, i.codigo, i.concepto, i.categoria, i.unidad, i.cantidad_presupuesto, i.precio_presupuesto, i.importe_presupuesto, i.orden])
  );

  const plan = generatePlanning(parsed.conceptos, parsed.meta);

  await batchInsert(
    client, 'programa_ejecucion',
    ['project_id', 'codigo', 'concepto', 'grupo', 'fecha_inicio', 'fecha_fin', 'duracion_dias', 'importe', 'peso_pct', 'orden'],
    plan.programa.map((p) => [projectId, p.codigo, p.concepto, p.grupo, p.fecha_inicio, p.fecha_fin, p.duracion_dias, p.importe, p.peso_pct, p.orden])
  );

  await batchInsert(
    client, 'avances_semanales',
    ['project_id', 'semana', 'fecha_inicio', 'fecha_fin', 'avance_fisico_programado', 'avance_fisico_real', 'avance_financiero_programado', 'avance_financiero_real'],
    plan.avances.map((a) => [projectId, a.semana, a.fecha_inicio, a.fecha_fin, a.avance_fisico_programado, a.avance_fisico_real, a.avance_financiero_programado, a.avance_financiero_real])
  );

  if (parsed.destajistas && parsed.destajistas.length > 0) {
    const { rows: cRows } = await client.query(
      'SELECT id, codigo FROM conceptos WHERE project_id = $1 AND codigo IS NOT NULL',
      [projectId]
    );
    const conceptoMap = new Map(cRows.map((r) => [r.codigo, r.id]));

    const destRows = await batchInsert(
      client, 'destajistas', ['project_id', 'nombre', 'orden'],
      parsed.destajistas.map((d) => [projectId, d.nombre, d.orden]),
      'RETURNING id'
    );

    const itemRows = [];
    parsed.destajistas.forEach((d, idx) => {
      const destId = destRows[idx].id;
      for (const item of d.items) {
        const conceptoId = item.codigo ? (conceptoMap.get(item.codigo) || null) : null;
        itemRows.push([projectId, destId, conceptoId, item.codigo, item.concepto, item.unidad, item.cantidad_asignada, item.precio_destajo, item.orden]);
      }
    });

    await batchInsert(
      client, 'destajo_items',
      ['project_id', 'destajista_id', 'concepto_id', 'codigo', 'concepto', 'unidad', 'cantidad_asignada', 'precio_destajo', 'orden'],
      itemRows
    );
  }
}

module.exports = { ingest };
