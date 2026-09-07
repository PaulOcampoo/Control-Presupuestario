'use strict';
// Corre SOLO dentro del buildCommand de Vercel (ver vercel.json) -- nunca en
// `npm run dev`, nunca se commitea a git. Genera copias con hash de
// contenido de app.js/styles.css y reescribe las referencias en index.html/
// sw.js, todo dentro del checkout efímero del build de Vercel. Esto existe
// porque Vercel sirve estos archivos como estáticos directamente (bypass de
// server/app.js en producción, ver comentario ahí) y su edge cacheaba
// versiones viejas pese a Cache-Control: max-age=0 -- confirmado con
// evidencia real (X-Vercel-Cache: HIT + Age creciente) en
// prompt-diagnostico-zafiro-round2-produccion-viva.md. Con URL inmutable por
// contenido, cachear agresivo deja de ser un bug: cada hash nuevo es una URL
// nueva, nunca se sirve contenido viejo bajo un nombre que cambió.
//
// Se descartó hacer esto commiteado a git (como los scripts build:*
// existentes para vendor/) porque app.js cambia en casi cada commit de este
// proyecto -- acumularía cientos de copias de ~1.2MB en el repo. Al vivir
// solo en el build de Vercel, nunca toca el working tree ni git.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HASH_LEN = 10;

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, HASH_LEN);
}

// originalName ej. 'app.js' -> 'app.a1b2c3d4e5.js'
function hashAndCopy(originalName) {
  const ext = path.extname(originalName); // '.js' o '.css'
  const base = originalName.slice(0, -ext.length); // 'app' o 'styles'
  const originalPath = path.join(PUBLIC_DIR, originalName);
  const hash = hashFile(originalPath);
  const hashedName = `${base}.${hash}${ext}`;
  fs.copyFileSync(originalPath, path.join(PUBLIC_DIR, hashedName));
  return hashedName;
}

function rewriteReferences(fileName, replacements) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  let content = fs.readFileSync(filePath, 'utf8');
  for (const [from, to] of replacements) {
    if (!content.includes(from)) {
      throw new Error(`[hash-static-assets] no se encontró "${from}" en ${fileName} -- referencia esperada ausente, revisar antes de desplegar`);
    }
    content = content.split(from).join(to);
  }
  fs.writeFileSync(filePath, content);
}

const appHashedName = hashAndCopy('app.js');
const stylesHashedName = hashAndCopy('styles.css');
console.log(`[hash-static-assets] app.js -> ${appHashedName}`);
console.log(`[hash-static-assets] styles.css -> ${stylesHashedName}`);

rewriteReferences('index.html', [
  ['src="/app.js"', `src="/${appHashedName}"`],
  ['href="/styles.css"', `href="/${stylesHashedName}"`],
]);

rewriteReferences('sw.js', [
  [`'/app.js'`, `'/${appHashedName}'`],
  [`'/styles.css'`, `'/${stylesHashedName}'`],
]);

console.log('[hash-static-assets] index.html y sw.js actualizados');
