'use strict';

const { generatePlanning } = require('./planning');
const matricesImport = require('./matricesImport');

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

// prompt-matrices-auto-import-alta-obra.md: userId es opcional (los 2 call
// sites de crear-presupuesto/import-completo en server/app.js no pasan
// matricesBloques, así que nunca llegan al bloque que lo usa) -- solo
// POST /api/projects (alta real desde un .xlsx) lo manda.
async function ingest(client, projectId, parsed, userId = null) {
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
    const dp = parsed.destajoPrecios || {};

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
        // Si el precio viene del Excel de destajistas úsalo; si no, busca en
        // la hoja Destajo de precios por código (fallback parseDestajoPrecios).
        const precio = item.precio_destajo > 0
          ? item.precio_destajo
          : (item.codigo && dp[item.codigo] ? dp[item.codigo] : 0);
        itemRows.push([projectId, destId, conceptoId, item.codigo, item.concepto, item.unidad, item.cantidad_asignada, precio, item.orden]);
      }
    });

    await batchInsert(
      client, 'destajo_items',
      ['project_id', 'destajista_id', 'concepto_id', 'codigo', 'concepto', 'unidad', 'cantidad_asignada', 'precio_destajo', 'orden'],
      itemRows
    );
  }

  // prompt-matrices-auto-import-alta-obra.md: hoja "Matrices" (formato
  // Neodata APU) del mismo workbook, resuelta contra los conceptos/insumos
  // recién insertados arriba en esta misma transacción -- mismo matching
  // (matricesImport.resolverBloqueImportacion) que ya usa el importador
  // manual (/api/projects/:id/matrices/import/*), que se deja intacto para
  // obras existentes o para corregir/actualizar matrices después.
  //
  // Todo-o-nada a propósito (igual que el import de 4 hojas de PR #176): si
  // CUALQUIER bloque no se puede resolver, se lanza y toda la transacción
  // de alta de obra hace rollback -- no queda una obra con conceptos pero
  // sin matrices a medias. conceptoIdsConMatriz siempre vacío: una obra
  // recién creada en esta misma llamada nunca pudo tener una matriz previa.
  if (parsed.matricesBloques && parsed.matricesBloques.length > 0) {
    const { rows: conceptoRows } = await client.query(
      'SELECT id, codigo FROM conceptos WHERE project_id = $1 AND activo = 1 AND codigo IS NOT NULL', [projectId]
    );
    const { rows: insumoRows } = await client.query(
      'SELECT id, codigo, categoria, precio_presupuesto FROM insumos WHERE project_id = $1 AND codigo IS NOT NULL', [projectId]
    );
    const conceptosPorCodigo = new Map();
    for (const c of conceptoRows) {
      if (!conceptosPorCodigo.has(c.codigo)) conceptosPorCodigo.set(c.codigo, []);
      conceptosPorCodigo.get(c.codigo).push(c);
    }
    const insumosPorCodigo = new Map(insumoRows.map((i) => [i.codigo, i]));

    const resultados = parsed.matricesBloques.map((bloque) => matricesImport.resolverBloqueImportacion(
      bloque, { conceptosPorCodigo, insumosPorCodigo, conceptoIdsConMatriz: new Set() }
    ));

    // Misma salvaguarda que prepararImportacionMatrices: 2 bloques del mismo
    // archivo resolviendo al mismo concepto_id violaría el UNIQUE(concepto_id).
    const vistos = new Set();
    for (const r of resultados) {
      if (r.estado !== 'ok') continue;
      if (vistos.has(r.concepto_id)) { r.estado = 'error'; r.motivo = `Código de análisis "${r.codigo_analisis}" duplicado dentro de este mismo archivo.`; continue; }
      vistos.add(r.concepto_id);
    }

    const conErrores = resultados.filter((r) => r.estado === 'error');
    if (conErrores.length) {
      throw new Error(`No se pudo generar la matriz de precio unitario para "${conErrores[0].codigo_analisis || '(sin código)'}": ${conErrores[0].motivo}`);
    }

    for (const r of resultados) {
      if (r.estado !== 'ok') continue; // 'omitido' no debería darse en una obra recién creada
      const p = r._persistencia;
      const basicoIdPorCodigo = new Map();
      for (const b of p.basicosResueltos) {
        const { rows } = await client.query(
          `INSERT INTO matrices_precio_unitario (es_basico, project_id, codigo, descripcion, unidad, creado_por, actualizado_por)
           VALUES (true, $1, $2, $3, $4, $5, $5) RETURNING id`,
          [projectId, b.codigo, b.descripcion, b.unidad || null, userId]
        );
        basicoIdPorCodigo.set(b.codigo, rows[0].id);
        await matricesImport.insertarRenglones(client, rows[0].id, b.renglones);
      }
      const { rows: matrizRows } = await client.query(
        `INSERT INTO matrices_precio_unitario
           (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre, creado_por, actualizado_por)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING id`,
        [p.concepto_id, p.pct_indirecto, p.pct_utilidad, p.pct_financiamiento, p.rendimiento, p.partida, p.analisis_no, p.cuadrilla_nombre, userId]
      );
      const renglonesFinales = [
        ...p.renglonesDirectos,
        ...p.renglonesBasicoRef.map((rb) => ({
          categoria: 'BASICOS', tipo: 'basico_ref',
          basico_matriz_id: basicoIdPorCodigo.get(rb.codigo_basico), cantidad: rb.cantidad,
        })),
      ];
      await matricesImport.insertarRenglones(client, matrizRows[0].id, renglonesFinales);
    }
  }
}

module.exports = { ingest };
