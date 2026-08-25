'use strict';

// prompt-catalogo-maestro-costos.md, Task 2/5 — carga y parseo de archivos al
// Catálogo Maestro (repositorio GLOBAL, ver server/db.js). Reusa
// parseArchivo4Hojas tal cual (server/crearPresupuestoImport.js) -- ya es el
// parser compartido de 4 hojas exacto por nombre de encabezado, no hace
// falta "refactorizar a función compartida" como sugiere el texto original
// del plan, ya está separado de server/parser.js a propósito.
const ExcelJS = require('exceljs');
const { parseArchivo4Hojas } = require('./crearPresupuestoImport');
// prompt-normalizador-universal-ajal.md: fallback para el formato real
// "AJAL" (letterhead + header variable, ver comentario de alcance en el
// propio módulo) — solo se intenta cuando parseArchivo4Hojas ya falló en
// encontrar una hoja "Presupuesto" estándar, nunca antes.
const { normalizarArchivoAjal } = require('./normalizadorAjal');

// Intenta primero el parser estándar (comportamiento actual, sin cambios —
// archivos que ya funcionan con hoja "Presupuesto"/"Destajo" en fila 1 no
// deben pasar por el normalizador nuevo). Si ese falla específicamente por
// no encontrar la hoja de Presupuesto, intenta el formato AJAL antes de
// rendirse. Cualquier otro error del parser estándar (ej. archivo
// inconsistente Hoja 2 vs Hoja 1) se propaga tal cual — ese tipo de error no
// tiene relación con el nombre/formato de hoja y no debe silenciarse.
const MENSAJE_SIN_HOJA_PRESUPUESTO_ESTANDAR = 'El archivo no tiene una hoja "Presupuesto" con al menos 1 concepto.';
async function parseArchivoConFallbackAjal(tmpPath) {
  try {
    const parsed = await parseArchivo4Hojas(tmpPath);
    return { parsed, formatoDetectado: 'estandar' };
  } catch (errEstandar) {
    if (errEstandar.message !== MENSAJE_SIN_HOJA_PRESUPUESTO_ESTANDAR) throw errEstandar;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(tmpPath);
    const nombresHoja = wb.worksheets.map((s) => s.name);
    const parsed = await normalizarArchivoAjal(tmpPath, nombresHoja);
    return { parsed, formatoDetectado: 'ajal' };
  }
}

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
//   codigo_insumo se guarda en columna propia (además de 'insumo', la
//   etiqueta legible) -- Task 3 lo necesita intacto para resolver/crear el
//   insumo correspondiente en la obra destino; guardarlo mezclado con la
//   descripción en un solo campo de texto lo hacía irrecuperable cuando
//   ambos existían (bug real, corregido antes de escribir Task 3).
// prompt-normalizador-universal-ajal.md (Fase adicional: preview/confirm
// para el camino AJAL): separada de procesarArchivoCatalogo para que el
// endpoint de upload pueda parsear+decidir el formato ANTES de comprometerse
// a persistir, y el endpoint de confirmación pueda reusar exactamente la
// misma lógica de inserción sin duplicarla. formatoDetectado se recibe como
// parámetro (no se vuelve a resolver aquí) porque el caller ya lo obtuvo de
// parseArchivoConFallbackAjal como parte del mismo parseo cuyo resultado
// (`parsed`) se le pasa a esta función.
async function persistirArchivoParseado(client, archivoId, parsed, formatoDetectado) {
  await client.query('UPDATE catalogo_archivos SET formato_detectado = $1 WHERE id = $2', [formatoDetectado, archivoId]);

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
        `INSERT INTO catalogo_insumos (archivo_id, concepto_id, insumo, codigo_insumo, cantidad, precio_unitario_insumo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [archivoId, conceptoId, r.descripcion || r.codigo_insumo, r.codigo_insumo, r.cantidad, precioPorCodigoInsumo.get(r.codigo_insumo) || 0]
      );
      numInsumos++;
    }
  }

  return { numConceptos, numDestajo, numInsumos, numMatrices, formatoDetectado };
}

// Wrapper usado por el camino de formato ESTÁNDAR (sin cambios de
// comportamiento: parsea y persiste en el mismo paso, tal como funcionaba
// antes de agregar el preview/confirm de AJAL). El camino AJAL en
// server/app.js llama parseArchivoConFallbackAjal y persistirArchivoParseado
// por separado, con la confirmación explícita del usuario en medio.
async function procesarArchivoCatalogo(client, archivoId, tmpPath) {
  const { parsed, formatoDetectado } = await parseArchivoConFallbackAjal(tmpPath);
  return persistirArchivoParseado(client, archivoId, parsed, formatoDetectado);
}

// Metadata + conteo de conceptos activos por archivo (GET .../archivos).
async function listarArchivos(pool) {
  const { rows } = await pool.query(`
    SELECT a.id, a.nombre_archivo, a.fecha_carga, a.cargado_por, u.nombre AS cargado_por_nombre,
      a.estado, a.notas_error, a.formato_detectado,
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

// Task 3/5 — búsqueda de conceptos por texto (código o nombre) a través de
// TODOS los archivos activos. Deliberadamente SIN dedupe por código (a
// diferencia de conceptosCatalogoQuery en server/app.js, que sí hace
// DISTINCT ON — ese catálogo agregado modela "un concepto real vigente por
// obra", pero aquí el usuario está navegando un catálogo de REFERENCIA con
// posible traslape entre archivos subidos por separado, y quedarse solo con
// "el más reciente" escondería silenciosamente destajo/precio distintos de
// otro archivo igual de válido). Requiere q no vacío para no devolver miles
// de filas sin filtro -- límite duro de 100 resultados por la misma razón.
async function buscarConceptos(pool, q) {
  const { rows } = await pool.query(
    `SELECT c.id, c.codigo, c.concepto, c.unidad, c.precio_unitario,
       c.archivo_id, a.nombre_archivo, a.fecha_carga,
       EXISTS (SELECT 1 FROM catalogo_destajo d WHERE d.concepto_id = c.id) AS tiene_destajo,
       EXISTS (SELECT 1 FROM catalogo_insumos i WHERE i.concepto_id = c.id) AS tiene_insumos,
       EXISTS (SELECT 1 FROM catalogo_matrices m WHERE m.concepto_id = c.id) AS tiene_matriz
     FROM catalogo_conceptos c
     JOIN catalogo_archivos a ON a.id = c.archivo_id
     WHERE c.activo = true AND (c.concepto ILIKE $1 OR c.codigo ILIKE $1)
     ORDER BY a.fecha_carga DESC, c.codigo
     LIMIT 100`,
    [`%${q}%`]
  );
  return rows;
}

// Task 3/5 — importar conceptos seleccionados del Catálogo Maestro a una
// obra YA EXISTENTE (proyecto_id). Deliberadamente NO reusa server/ingest.js
// (aunque el plan dice "usando la MISMA lógica de ingest()"): ingest() está
// diseñado para ALTA DE OBRA DESDE CERO -- además de conceptos/insumos,
// genera programa_ejecucion + avances_semanales completos (generatePlanning)
// para TODOS los conceptos de la obra, y su bloque de matrices asume
// conceptoIdsConMatriz siempre vacío ("una obra recién creada nunca pudo
// tener una matriz previa" -- comentario explícito en ingest.js). Llamarlo
// contra una obra EXISTENTE recalcularía/duplicaría programa y avance de
// TODA la obra, no solo de los conceptos nuevos -- exactamente lo que
// CLAUDE.md prohíbe ("preservar siempre datos existentes de avance"). En su
// lugar se replica el patrón manual de
// /api/costos/crear-presupuesto/import-completo/confirm (resolver por
// código, transacción única), extendido con lo que ese flujo nunca necesitó
// por ser siempre alta-desde-cero: name-matching de destajista contra los
// YA EXISTENTES en la obra destino, y resolución de insumo por código
// también contra los YA EXISTENTES (nunca se asume que la obra está vacía).
//
// Colisión de código con un concepto YA activo en la obra destino: se omite
// (nunca se sobreescribe ni duplica -- mismo criterio de "preservar datos
// existentes"), reportado en omitidos_duplicados para que el caller
// (Task 4) se lo muestre al usuario.
//
// "Auto-creación de destajista genérico si no hay match" (texto del plan):
// no existe ningún destajista genérico "Mano de Obra General" en este
// codebase (confirmado -- el único fallback real es el nombre literal
// 'Sin destajista asignado', usado en import-completo/confirm cuando
// destajista_nombre viene vacío). Se sigue ese mismo criterio real: si no
// hay match por nombre (case-insensitive) contra los destajistas ya
// existentes en la obra, se crea uno nuevo con el nombre del catálogo (o
// 'Sin destajista asignado' si venía vacío) -- "genérico" en el sentido de
// "no curado a mano", no un nombre fijo inventado sin precedente real.
async function importarAObra(client, proyectoId, catalogoConceptoIds) {
  const { rows: seleccionados } = await client.query(
    `SELECT id, codigo, concepto, unidad, precio_unitario FROM catalogo_conceptos WHERE id = ANY($1) AND activo = true`,
    [catalogoConceptoIds]
  );
  const encontrados = new Set(seleccionados.map((c) => c.id));
  const noEncontrados = catalogoConceptoIds.filter((id) => !encontrados.has(id));
  if (noEncontrados.length) {
    const err = new Error(`concepto_id no encontrado o inactivo en el catálogo maestro: ${noEncontrados.join(', ')}`);
    err.status = 400;
    throw err;
  }

  const { rows: existentesObra } = await client.query(
    `SELECT codigo FROM conceptos WHERE project_id = $1 AND activo = 1 AND codigo IS NOT NULL`, [proyectoId]
  );
  const codigosExistentes = new Set(existentesObra.map((c) => c.codigo));
  const aImportar = seleccionados.filter((c) => !codigosExistentes.has(c.codigo));
  const omitidosDuplicados = seleccionados
    .filter((c) => codigosExistentes.has(c.codigo))
    .map((c) => ({ concepto_id_catalogo: c.id, codigo: c.codigo, concepto: c.concepto }));

  if (!aImportar.length) return { importados: [], omitidos_duplicados: omitidosDuplicados };

  const { rows: [{ max_orden: maxOrdenConcepto }] } = await client.query(
    `SELECT COALESCE(MAX(orden), 0) AS max_orden FROM conceptos WHERE project_id = $1`, [proyectoId]
  );
  let siguienteOrdenConcepto = maxOrdenConcepto + 1;

  const { rows: destajistasObra } = await client.query(`SELECT id, nombre FROM destajistas WHERE project_id = $1`, [proyectoId]);
  const destajistaIdPorNombreLower = new Map(destajistasObra.map((d) => [d.nombre.toLowerCase(), d.id]));
  const { rows: [{ max_orden: maxOrdenDestajista }] } = await client.query(
    `SELECT COALESCE(MAX(orden), 0) AS max_orden FROM destajistas WHERE project_id = $1`, [proyectoId]
  );
  let siguienteOrdenDestajista = maxOrdenDestajista + 1;

  const { rows: insumosObra } = await client.query(`SELECT id, codigo FROM insumos WHERE project_id = $1 AND codigo IS NOT NULL`, [proyectoId]);
  const insumoIdPorCodigo = new Map(insumosObra.map((i) => [i.codigo, i.id]));
  const { rows: [{ max_orden: maxOrdenInsumo }] } = await client.query(
    `SELECT COALESCE(MAX(orden), 0) AS max_orden FROM insumos WHERE project_id = $1`, [proyectoId]
  );
  let siguienteOrdenInsumo = maxOrdenInsumo + 1;

  const importados = [];

  for (const c of aImportar) {
    const { rows: conceptoRows } = await client.query(
      `INSERT INTO conceptos (project_id, codigo, concepto, unidad, cantidad, precio_unitario, importe, grupo, es_total, orden, activo)
       VALUES ($1,$2,$3,$4,0,$5,0,NULL,0,$6,1) RETURNING id`,
      [proyectoId, c.codigo, c.concepto, c.unidad, c.precio_unitario, siguienteOrdenConcepto++]
    );
    const conceptoIdObra = conceptoRows[0].id;
    importados.push({ concepto_id_catalogo: c.id, codigo: c.codigo, concepto_id_obra: conceptoIdObra });

    const { rows: destajoRows } = await client.query(
      `SELECT precio_destajo, destajista_nombre FROM catalogo_destajo WHERE concepto_id = $1`, [c.id]
    );
    for (const d of destajoRows) {
      const nombreDestajista = d.destajista_nombre?.trim() || 'Sin destajista asignado';
      const key = nombreDestajista.toLowerCase();
      let destajistaId = destajistaIdPorNombreLower.get(key);
      if (!destajistaId) {
        const { rows: nuevoDestajista } = await client.query(
          `INSERT INTO destajistas (project_id, nombre, orden) VALUES ($1,$2,$3) RETURNING id`,
          [proyectoId, nombreDestajista, siguienteOrdenDestajista++]
        );
        destajistaId = nuevoDestajista[0].id;
        destajistaIdPorNombreLower.set(key, destajistaId);
      }
      await client.query(
        `INSERT INTO destajo_items (project_id, destajista_id, concepto_id, codigo, concepto, unidad, cantidad_asignada, precio_destajo, orden)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,0)`,
        [proyectoId, destajistaId, conceptoIdObra, c.codigo, c.concepto, c.unidad, d.precio_destajo]
      );
    }

    const { rows: matrizRows } = await client.query(`SELECT datos FROM catalogo_matrices WHERE concepto_id = $1`, [c.id]);
    for (const { datos } of matrizRows) {
      const { rows: nuevaMatriz } = await client.query(
        `INSERT INTO matrices_precio_unitario (concepto_id, pct_indirecto, pct_utilidad, pct_financiamiento, rendimiento, partida, analisis_no, cuadrilla_nombre)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [conceptoIdObra, datos.pct_indirecto, datos.pct_utilidad, datos.pct_financiamiento, datos.rendimiento, datos.partida, datos.analisis_no, datos.cuadrilla_nombre]
      );
      const matrizIdObra = nuevaMatriz[0].id;
      let ordenRenglon = 0;
      for (const r of (datos.renglones || [])) {
        let insumoId = null;
        if (r.codigo_insumo) {
          insumoId = insumoIdPorCodigo.get(r.codigo_insumo) || null;
          if (!insumoId) {
            const { rows: catIns } = await client.query(
              `SELECT precio_unitario_insumo FROM catalogo_insumos WHERE concepto_id = $1 AND codigo_insumo = $2 LIMIT 1`,
              [c.id, r.codigo_insumo]
            );
            const { rows: nuevoInsumo } = await client.query(
              `INSERT INTO insumos (project_id, codigo, concepto, categoria, cantidad_presupuesto, precio_presupuesto, importe_presupuesto, orden)
               VALUES ($1,$2,$3,$4,0,$5,0,$6) RETURNING id`,
              [proyectoId, r.codigo_insumo, r.descripcion || r.codigo_insumo, r.categoria, catIns[0]?.precio_unitario_insumo || 0, siguienteOrdenInsumo++]
            );
            insumoId = nuevoInsumo[0].id;
            insumoIdPorCodigo.set(r.codigo_insumo, insumoId);
          }
          await client.query(`INSERT INTO concepto_insumos (concepto_id, insumo_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [conceptoIdObra, insumoId]);
        }
        await client.query(
          `INSERT INTO matriz_precio_renglones (matriz_id, categoria, tipo, insumo_id, codigo, descripcion, cantidad, factor_referencia, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [matrizIdObra, r.categoria, r.tipo, insumoId, r.codigo_insumo || null, r.descripcion, r.cantidad, r.factor_referencia, ordenRenglon++]
        );
      }
    }
  }

  return { importados, omitidos_duplicados: omitidosDuplicados };
}

module.exports = { procesarArchivoCatalogo, persistirArchivoParseado, listarArchivos, eliminarArchivo, buscarConceptos, importarAObra, parseArchivoConFallbackAjal };
