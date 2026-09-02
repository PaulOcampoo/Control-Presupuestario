'use strict';

// prompt-ajuste-backup-diario.md (originalmente prompt-p6-backup-neon.md):
// sube el dump comprimido (.sql.gz) generado por
// .github/workflows/backup-neon.yml a Vercel Blob, bajo el prefijo
// 'backups/', con retención de dos niveles: los RETENCION_DIARIOS más
// recientes (cadencia diaria) + un representante "mensual" por cada uno de
// los últimos RETENCION_MENSUALES meses calendario (el backup más antiguo
// disponible de ese mes — no necesariamente el del día 1, para no perder el
// representante de un mes completo por una sola falla puntual del run del
// día 1). access: 'private' a propósito — dump completo de la base de
// datos, no debe ser público (mismo patrón que el resto de la app usa para
// PDFs de contrato, ver server/app.js).
//
// Cambió de retención plana de 8 backups SEMANALES (prompt-p6-backup-neon.md)
// a este esquema porque el negocio ya tiene módulos financieros activos
// (Control de Cuentas, Control Financiero) donde una ventana de pérdida de
// datos de una semana completa es demasiado (prompt-ajuste-backup-diario.md).
//
// Uso: node scripts/backup-neon-to-blob.js <ruta-al-archivo.sql.gz>

const fs = require('fs');
const path = require('path');
const { put, list, del } = require('@vercel/blob');

const RETENCION_DIARIOS = 30;
const RETENCION_MENSUALES = 12;

const RE_FECHA = /^backups\/backup-(\d{4}-\d{2}-\d{2})\.sql\.gz$/;

// Extrae la fecha (YYYY-MM-DD) embebida en el nombre de archivo — más
// confiable que `uploadedAt` de Vercel Blob para agrupar por mes calendario:
// el nombre lo fija el propio workflow en el momento del dump, mientras que
// `uploadedAt` es la hora de la llamada a `put()`, que en teoría podría caer
// del otro lado de medianoche UTC si un run se retrasa.
function fechaDe(pathname) {
  const m = RE_FECHA.exec(pathname);
  return m ? m[1] : null;
}

function diffDias(fechaA, fechaB) {
  // Date.UTC espera el mes 0-indexado (enero=0) — restar 1 al mes parseado
  // de la fecha (1-indexada, "2026-08-31" -> mes 8) antes de pasarlo.
  const [ay, am, ad] = fechaA.split('-').map(Number);
  const [by, bm, bd] = fechaB.split('-').map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86400000);
}

function diffMeses(fechaA, fechaB) {
  const [ay, am] = fechaA.split('-').map(Number);
  const [by, bm] = fechaB.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

// Clasifica los blobs existentes en conservar/borrar dado un punto de
// referencia "hoy" (YYYY-MM-DD, parámetro inyectable a propósito para poder
// probar la lógica con fechas simuladas sin tocar Blob real — ver
// tests/backup-rotacion.test.js). Función pura, sin I/O.
function clasificarBackups(blobs, hoyStr) {
  const conFecha = [];
  const sinFecha = [];
  for (const b of blobs) {
    const fecha = fechaDe(b.pathname);
    if (fecha) conFecha.push({ ...b, fecha });
    else sinFecha.push(b);
  }

  // Representante mensual: el backup MÁS ANTIGUO disponible dentro de cada
  // mes calendario presente en `blobs`.
  const masAntiguoPorMes = new Map(); // 'YYYY-MM' -> backup
  for (const b of conFecha) {
    const mes = b.fecha.slice(0, 7);
    const actual = masAntiguoPorMes.get(mes);
    if (!actual || b.fecha < actual.fecha) masAntiguoPorMes.set(mes, b);
  }
  const mesesEnVentana = [...masAntiguoPorMes.entries()].filter(([mes]) => {
    const mesesAtras = diffMeses(`${mes}-01`, `${hoyStr.slice(0, 7)}-01`);
    return mesesAtras >= 0 && mesesAtras < RETENCION_MENSUALES;
  });
  const mensualesPromovidos = new Set(mesesEnVentana.map(([, b]) => b.pathname));

  const aConservar = [];
  const aBorrar = [];
  for (const b of conFecha) {
    const esDiarioReciente = diffDias(b.fecha, hoyStr) < RETENCION_DIARIOS;
    const esMensualPromovido = mensualesPromovidos.has(b.pathname);
    if (esDiarioReciente || esMensualPromovido) aConservar.push(b);
    else aBorrar.push(b);
  }

  return { aConservar, aBorrar, sinFecha, mensualesPromovidos };
}

async function main() {
  const archivoLocal = process.argv[2];
  if (!archivoLocal) {
    throw new Error('Falta la ruta del archivo .sql.gz como argumento');
  }
  if (!fs.existsSync(archivoLocal)) {
    throw new Error(`No existe el archivo: ${archivoLocal}`);
  }
  const stats = fs.statSync(archivoLocal);
  if (stats.size === 0) {
    // pg_dump pudo haber fallado en silencio (ej. conexión rechazada antes
    // de escribir nada) y el pipe a gzip igual crea el archivo vacío/casi
    // vacío — nunca subir un backup de 0 bytes como si fuera válido.
    throw new Error('El archivo de backup está vacío (0 bytes) — pg_dump probablemente falló. Abortando sin subir.');
  }

  const nombre = path.basename(archivoLocal); // ej. backup-2026-07-28.sql.gz
  const buffer = fs.readFileSync(archivoLocal);
  const { url } = await put(`backups/${nombre}`, buffer, {
    access: 'private',
    contentType: 'application/gzip',
    addRandomSuffix: false,
  });
  console.log(`Subido a Vercel Blob: ${url} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

  await rotarBackupsViejos();
}

// Aplica la retención de 2 niveles (diarios + mensuales) sobre los backups
// existentes bajo 'backups/'. Nunca hace overwrite — solo DELETE de los que
// exceden ambas ventanas. Salvaguardas duras (Forbidden Action del prompt:
// nunca eliminar la de "abortar si no hay certeza"):
//   1. Cualquier blob cuyo nombre no calce con el patrón esperado no se
//      puede clasificar con confianza -> se aborta TODO el borrado de este
//      ciclo, sin eliminar nada, hasta revisar manualmente.
//   2. Si la clasificación no marca ningún backup para conservar (no debería
//      ser posible: el backup recién subido siempre cae dentro de la
//      ventana diaria) -> señal de bug, se aborta sin borrar.
async function rotarBackupsViejos() {
  const { blobs } = await list({ prefix: 'backups/' });
  console.log(`Backups existentes bajo 'backups/': ${blobs.length}`);

  const hoyStr = new Date().toISOString().slice(0, 10);
  const { aConservar, aBorrar, sinFecha, mensualesPromovidos } = clasificarBackups(blobs, hoyStr);

  if (sinFecha.length > 0) {
    console.error(
      `Salvaguarda de rotación: ${sinFecha.length} blob(s) bajo 'backups/' no calzan con el patrón ` +
      `"backup-YYYY-MM-DD.sql.gz" esperado (${sinFecha.map((b) => b.pathname).join(', ')}) — ` +
      `se aborta el borrado esta vez, sin eliminar nada, hasta revisar manualmente.`
    );
    return;
  }

  if (aConservar.length === 0 && aBorrar.length > 0) {
    console.error(
      'Salvaguarda de rotación: la clasificación no marcó NINGÚN backup para conservar, lo cual no debería ' +
      'ser posible (el backup recién subido siempre debería calificar) — se aborta el borrado sin eliminar nada.'
    );
    return;
  }

  if (aBorrar.length === 0) {
    console.log(
      `Nada que rotar (${aConservar.length} backup(s) dentro de retención, ` +
      `${mensualesPromovidos.size} de ellos como representante mensual).`
    );
    return;
  }

  for (const b of aBorrar) {
    await del(b.url);
    console.log(
      `Borrado por rotación (fuera de la ventana diaria de ${RETENCION_DIARIOS} días y no es representante ` +
      `mensual): ${b.pathname} (fecha ${fechaDe(b.pathname)})`
    );
  }
  console.log(
    `Rotación completa: ${aBorrar.length} backup(s) viejo(s) eliminado(s), ${aConservar.length} conservado(s) ` +
    `(${mensualesPromovidos.size} de ellos como representante mensual).`
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Falló la subida/rotación del backup:', err.message);
    process.exit(1);
  });
}

module.exports = { clasificarBackups, fechaDe, diffDias, diffMeses, RETENCION_DIARIOS, RETENCION_MENSUALES };
