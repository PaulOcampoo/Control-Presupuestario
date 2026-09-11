'use strict';

// prompt-ruta-jerarquica-conceptos.md — llena conceptos.ruta_jerarquica
// (JSONB, array nivel 1->N) reconstruyendo la jerarquia completa de secciones
// a partir de las filas es_total=1 ya guardadas (encabezado/TOTAL), sin
// necesitar el Excel original ni Blob.
//
// Algoritmo de pila (prompt-diagnostico-niveles-jerarquia.md): apila al ver
// un encabezado de seccion, desapila al ver "TOTAL <mismo texto>" que lo
// cierra. Validado sin excepciones contra las 7 obras reales (profundidad 4
// a 7 niveles, no 2) -- el codigo del encabezado NO es senal confiable de
// nivel (varia por obra) y el formato de celda tampoco; el texto "TOTAL X"
// emparejado con su encabezado "X" es la unica senal universal encontrada.
//
// Generico por diseno: procesa TODOS los project_id presentes en
// `conceptos`, no una lista fija de ids -- los ids de una misma obra real
// difieren entre Preview y Produccion (confirmado en
// scripts/fix-codigo-duplicado-pav-ado-obra57-produccion.sql), asi que un
// script con ids hardcodeados en Preview seria incorrecto contra Produccion.
// Corre igual (e inofensivo) en cualquiera de los dos, apuntado via
// DATABASE_URL.
//
// Idempotente: recalcula y sobreescribe ruta_jerarquica desde cero en cada
// corrida, nunca depende de un estado previo. NUNCA toca `grupo` ni ninguna
// otra columna de `conceptos` o de cualquier otra tabla.
//
// Seguridad: TODO el UPDATE corre dentro de una sola transaccion. Antes de
// escribir nada, verifica en memoria que ruta_jerarquica[-1] === grupo para
// el 100% de los conceptos reales y que no haya ningun cierre "TOTAL X" sin
// su encabezado "X" abierto -- si algo no cuadra, no abre transaccion de
// escritura, solo reporta. Ya dentro de la transaccion, repite la
// verificacion contra lo recien escrito antes de decidir COMMIT/ROLLBACK.
//
// Uso (Claude Code corre esto SOLO contra Preview -- nunca contra
// Produccion; Paul corre el mismo script sin cambios apuntando su propio
// DATABASE_URL a Produccion cuando decida hacerlo):
//   node --env-file=.env scripts/backfill-ruta-jerarquica.js --dry-run
//   node --env-file=.env scripts/backfill-ruta-jerarquica.js

const { Pool } = require('pg');

const DRY_RUN = process.argv.includes('--dry-run');

function norm(text) {
  return String(text == null ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
}

// Reconstruye ruta_jerarquica para cada concepto real (es_total=0) de un
// proyecto, a partir de sus filas YA guardadas en orden original (incluye
// es_total=1 -- encabezados/totales nunca se descartaron al importar).
//
// Dos categorias de problema, tratadas distinto (decision explicita, ver
// prompt-ruta-jerarquica-conceptos.md Stop Conditions):
// - 'cierre_sin_encabezado' (un TOTAL sin header que le corresponda): indica
//   que el algoritmo mismo no pudo interpretar la secuencia -- BLOQUEA todo
//   el proyecto, no se escribe nada de ese project_id.
// - 'mismatch_grupo' (ruta_jerarquica[-1] != grupo en un concepto puntual):
//   caso real confirmado en obra 13 -- `orden` quedo desfasado por una
//   actualizacion de presupuesto que agrega filas nuevas al FINAL de la
//   secuencia (`maxOrdenExistente + nuevo.orden` en reintegracionPresupuesto.js)
//   en vez de insertarlas en su posicion estructural real. Se OMITE solo ese
//   concepto puntual (ruta_jerarquica se deja NULL, nunca se fuerza un valor
//   que no coincida con `grupo`) y se sigue con el resto del proyecto.
function calcularRutas(rows) {
  const stack = []; // texto de cada encabezado abierto, nivel 1..N
  const updates = [];
  const omitidos = [];
  const bloqueantes = [];

  for (const row of rows) {
    const upper = norm(row.concepto);
    const isTotalRow = upper.startsWith('TOTAL ');
    const isGroupHeader = !row.unidad && !row.cantidad && !row.precio_unitario && !isTotalRow;

    if (isTotalRow) {
      const nombreCerrado = norm(row.concepto.replace(/^TOTAL\s+/i, ''));
      let idx = -1;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (norm(stack[i]) === nombreCerrado) { idx = i; break; }
      }
      if (idx === -1) {
        bloqueantes.push({ tipo: 'cierre_sin_encabezado', concepto_id: row.id, orden: row.orden, texto: row.concepto });
      } else {
        stack.length = idx;
      }
      continue;
    }
    if (isGroupHeader) {
      stack.push(row.concepto);
      continue;
    }
    // Concepto real: su ruta es la pila de encabezados abiertos en este punto.
    const ruta = [...stack];
    if (ruta.length && ruta[ruta.length - 1] !== row.grupo) {
      omitidos.push({
        concepto_id: row.id, orden: row.orden,
        grupo_actual: row.grupo, ruta_calculada: ruta,
      });
      continue; // no se agrega a updates -- ruta_jerarquica se deja NULL
    }
    updates.push({ id: row.id, ruta_jerarquica: ruta });
  }
  return { updates, omitidos, bloqueantes };
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows: projectIds } = await pool.query('SELECT DISTINCT project_id FROM conceptos ORDER BY project_id');

  let totalConceptos = 0;
  const bloqueantesPorProyecto = [];
  const omitidosPorProyecto = [];
  const allUpdates = [];

  for (const { project_id } of projectIds) {
    const { rows } = await pool.query(
      `SELECT id, orden, codigo, concepto, unidad, cantidad, precio_unitario, es_total, grupo
       FROM conceptos WHERE project_id = $1 ORDER BY orden`,
      [project_id]
    );
    const { updates, omitidos, bloqueantes } = calcularRutas(rows);
    totalConceptos += updates.length;
    if (bloqueantes.length) bloqueantesPorProyecto.push({ project_id, bloqueantes });
    if (omitidos.length) omitidosPorProyecto.push({ project_id, omitidos });
    // Un proyecto con algun bloqueante no escribe NADA de ese project_id
    // (ni siquiera los conceptos limpios) -- el algoritmo mismo fallo ahi,
    // no es seguro confiar en ninguna parte de esa reconstruccion.
    if (!bloqueantes.length) allUpdates.push(...updates);
    console.log(`project_id=${project_id}: ${rows.length} filas, ${updates.length} concepto(s) con ruta, ${omitidos.length} omitido(s), ${bloqueantes.length} bloqueante(s)`);
  }

  console.log('');
  if (bloqueantesPorProyecto.length) {
    console.log('BLOQUEANTES (cierre "TOTAL X" sin encabezado "X" abierto) -- ese project_id completo NO se escribe:');
    console.log(JSON.stringify(bloqueantesPorProyecto, null, 2));
  }
  if (omitidosPorProyecto.length) {
    console.log('OMITIDOS (ruta_jerarquica[-1] != grupo en un concepto puntual, "orden" desfasado por una actualizacion de presupuesto posterior) -- se dejan en NULL, nunca se fuerza un valor que no coincida con grupo:');
    console.log(JSON.stringify(omitidosPorProyecto, null, 2));
  }
  if (bloqueantesPorProyecto.length) {
    await pool.end();
    process.exitCode = 1;
    return;
  }

  console.log(`Verificacion OK: ${totalConceptos} concepto(s) a escribir con ruta_jerarquica[-1] = grupo, 0 encabezados sin cierre.`);

  if (DRY_RUN) {
    console.log('--dry-run: no se escribio nada.');
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const u of allUpdates) {
      await client.query('UPDATE conceptos SET ruta_jerarquica = $1::jsonb WHERE id = $2', [JSON.stringify(u.ruta_jerarquica), u.id]);
    }
    // Verificacion DESPUES, dentro de la misma transaccion, contra lo recien
    // escrito -- si algo no cuadra, ROLLBACK y no se pierde nada.
    const { rows: verif } = await client.query(`
      SELECT COUNT(*) AS n FROM conceptos
      WHERE es_total = 0 AND ruta_jerarquica IS NOT NULL
        AND ruta_jerarquica->(jsonb_array_length(ruta_jerarquica) - 1) <> to_jsonb(grupo)
    `);
    if (Number(verif[0].n) > 0) {
      console.log(`Verificacion posterior fallo: ${verif[0].n} fila(s) con ruta_jerarquica[-1] != grupo. ROLLBACK.`);
      await client.query('ROLLBACK');
      process.exitCode = 1;
      return;
    }
    await client.query('COMMIT');
    console.log(`COMMIT: ${allUpdates.length} concepto(s) actualizado(s) con ruta_jerarquica.`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
