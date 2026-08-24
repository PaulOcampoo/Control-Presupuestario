'use strict';

// prompt-catalogo-maestro-costos.md, Task 2/5 — carga y parseo de archivos al
// Catálogo Maestro (repositorio GLOBAL, ver server/db.js). Reusa
// parseArchivo4Hojas tal cual (server/crearPresupuestoImport.js) -- ya es el
// parser compartido de 4 hojas exacto por nombre de encabezado, no hace
// falta "refactorizar a función compartida" como sugiere el texto original
// del plan, ya está separado de server/parser.js a propósito.
const { parseArchivo4Hojas } = require('./crearPresupuestoImport');

// Mapeo de parseArchivo4Hojas -> las 5 tablas globales:
//
// catalogo_conceptos <- Hoja 1 "Presupuesto" (1:1 por código).
// catalogo_destajo   <- Hoja 2 "Destajo" (1:1 por código, resuelto contra
//   catalogo_conceptos recién insertado).
// catalogo_matrices  <- Hoja 4 "Matrices": UN row por concepto con la matriz
//   COMPLETA (cabecera + renglones) como JSONB tal cual la devuelve el
//   parser -- es la fuente de verdad que Task 3 va a necesitar para
//   reconstruir la matriz completa al importar a una obra real.
// catalogo_insumos   <- TAMBIÉN sale de la Hoja 4, no de la Hoja 3. La Hoja 3
//   "Insumos" no trae cantidad por concepto (confirmado en
//   ENCABEZADOS_INSUMOS de crearPresupuestoImport.js y en el import real a
//   obra, server/app.js ~3428-3446, que hardcodea cantidad_presupuesto=0 al
//   insertar desde Hoja 3 -- esa hoja es solo un catálogo plano de
//   código/descripción/precio). El plan describe catalogo_insumos
//   explícitamente como "equivalente global de matriz_precio_renglones", y
//   esa tabla (por-obra) SÍ tiene cantidad real por renglón de matriz -- por
//   eso aquí se llena desde los renglones tipo 'insumo' de cada matriz
//   (cantidad real), resolviendo el precio contra la Hoja 3 por código de
//   insumo (mismo mecanismo de resolución "por código" que usa el import
//   real a obra para resolver insumo_id, solo que aquí se resuelve un precio
//   en vez de un FK). Renglones tipo 'factor_pct' se excluyen de
//   catalogo_insumos (no representan un insumo real) pero SÍ quedan
//   preservados dentro del JSONB de catalogo_matrices.
async function procesarArchivoCatalogo(client, archivoId, tmpPath) {
  const parsed = await parseArchivo4Hojas(tmpPath);

  const precioPorCodigoInsumo = new Map(parsed.insumos.map((i) => [i.codigo_insumo, i.precio_presupuesto]));
  const conceptoIdPorCodigo = new Map();

  let numConceptos = 0;
  let numDestajo = 0;
  let numInsumos = 0;
  let numMatrices = 0;

  for (const c of parsed.conceptos) {
    const { rows } = await client.query(
      `INSERT INTO catalogo_conceptos (archivo_id, codigo, concepto, unidad, precio_unitario)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [archivoId, c.codigo, c.concepto, c.unidad, c.precio_unitario]
    );
    conceptoIdPorCodigo.set(c.codigo, rows[0].id);
    numConceptos++;
  }

  for (const d of parsed.destajo) {
    const conceptoId = conceptoIdPorCodigo.get(d.codigo);
    if (!conceptoId) continue; // ya validado por parseArchivo4Hojas (Hoja 2 vs Hoja 1), no debería pasar
    await client.query(
      `INSERT INTO catalogo_destajo (archivo_id, concepto_id, precio_destajo, destajista_nombre)
       VALUES ($1,$2,$3,$4)`,
      [archivoId, conceptoId, d.precio_destajo_maximo, d.destajista_nombre]
    );
    numDestajo++;
  }

  for (const m of parsed.matrices) {
    const conceptoId = conceptoIdPorCodigo.get(m.codigo_concepto);
    if (!conceptoId) continue; // ya validado por parseArchivo4Hojas (Hoja 4 vs Hoja 1), no debería pasar

    await client.query(
      `INSERT INTO catalogo_matrices (archivo_id, concepto_id, datos) VALUES ($1,$2,$3)`,
      [archivoId, conceptoId, JSON.stringify(m)]
    );
    numMatrices++;

    for (const r of m.renglones) {
      if (r.tipo !== 'insumo' || !r.codigo_insumo) continue;
      await client.query(
        `INSERT INTO catalogo_insumos (archivo_id, concepto_id, insumo, cantidad, precio_unitario_insumo)
         VALUES ($1,$2,$3,$4,$5)`,
        [archivoId, conceptoId, r.descripcion || r.codigo_insumo, r.cantidad, precioPorCodigoInsumo.get(r.codigo_insumo) || 0]
      );
      numInsumos++;
    }
  }

  return { numConceptos, numDestajo, numInsumos, numMatrices };
}

// Metadata + conteo de conceptos activos por archivo (GET .../archivos).
async function listarArchivos(pool) {
  const { rows } = await pool.query(`
    SELECT a.id, a.nombre_archivo, a.fecha_carga, a.cargado_por, u.nombre AS cargado_por_nombre,
      a.estado, a.notas_error,
      COUNT(c.id) FILTER (WHERE c.activo) AS conteo_conceptos
    FROM catalogo_archivos a
    LEFT JOIN usuarios u ON u.id = a.cargado_por
    LEFT JOIN catalogo_conceptos c ON c.archivo_id = a.id
    GROUP BY a.id, u.nombre
    ORDER BY a.fecha_carga DESC
  `);
  return rows;
}

// Soft-delete (DELETE .../archivos/:id): desactiva los conceptos del
// archivo, no borra filas físicas ni el blob (Forbidden Action explícita
// del plan). Devuelve el conteo de conceptos desactivados; null si el
// archivo no existe.
async function eliminarArchivo(pool, archivoId) {
  const { rows: archivoRows } = await pool.query('SELECT id FROM catalogo_archivos WHERE id = $1', [archivoId]);
  if (!archivoRows[0]) return null;
  const { rowCount } = await pool.query(
    'UPDATE catalogo_conceptos SET activo = false WHERE archivo_id = $1 AND activo = true',
    [archivoId]
  );
  return rowCount;
}

module.exports = { procesarArchivoCatalogo, listarArchivos, eliminarArchivo };
