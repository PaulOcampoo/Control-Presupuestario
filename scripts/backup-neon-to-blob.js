'use strict';

// prompt-p6-backup-neon.md: sube el dump comprimido (.sql.gz) generado por
// .github/workflows/backup-neon.yml a Vercel Blob, bajo el prefijo
// 'backups/', y rota reteniendo solo los 8 más recientes (~8 semanas con
// cadencia semanal). access: 'private' a propósito — es un dump completo de
// la base de datos, no debe ser público (mismo patrón que el resto de la app
// usa para PDFs de contrato, ver server/app.js).
//
// Uso: node scripts/backup-neon-to-blob.js <ruta-al-archivo.sql.gz>

const fs = require('fs');
const path = require('path');
const { put, list, del } = require('@vercel/blob');

const RETENCION = 8;

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

// Conserva solo los RETENCION backups más recientes bajo 'backups/'. Nunca
// hace DO UPDATE ni sobreescribe — solo DELETE de los que exceden la
// ventana. Salvaguarda explícita (Forbidden Action del prompt): si por
// cualquier razón no se puede confirmar que quedan al menos RETENCION
// backups intactos después de filtrar, se aborta el borrado sin tocar nada,
// en vez de arriesgarse a borrar de más por un cálculo o listado corrupto.
async function rotarBackupsViejos() {
  const { blobs } = await list({ prefix: 'backups/' });
  console.log(`Backups existentes bajo 'backups/': ${blobs.length}`);

  if (blobs.length <= RETENCION) {
    console.log(`Nada que rotar (${blobs.length} <= ${RETENCION}).`);
    return;
  }

  const ordenados = [...blobs].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  const aConservar = ordenados.slice(0, RETENCION);
  const aBorrar = ordenados.slice(RETENCION);

  if (aConservar.length < RETENCION) {
    console.error(
      `Salvaguarda de rotación: solo se identificaron ${aConservar.length} backups válidos para conservar ` +
      `(se esperaban ${RETENCION}) — se aborta el borrado esta vez, sin eliminar nada, hasta revisar manualmente.`
    );
    return;
  }

  for (const b of aBorrar) {
    await del(b.url);
    console.log(`Borrado por rotación (excede ${RETENCION} semanas): ${b.pathname} (subido ${b.uploadedAt})`);
  }
  console.log(`Rotación completa: ${aBorrar.length} backup(s) viejo(s) eliminado(s), ${aConservar.length} conservado(s).`);
}

main().catch((err) => {
  console.error('Falló la subida/rotación del backup:', err.message);
  process.exit(1);
});
