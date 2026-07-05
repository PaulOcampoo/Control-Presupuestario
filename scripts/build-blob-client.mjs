// Genera public/vendor/vercel-blob-client.js: un bundle browser-safe de
// @vercel/blob/client (solo la función upload()) para subir presupuestos
// directo a Vercel Blob desde el navegador, sin pasar por el límite de
// tamaño de body de las funciones serverless. Correr de nuevo solo si se
// actualiza la dependencia @vercel/blob.
import { build } from 'esbuild';

await build({
  stdin: {
    contents: "import { upload } from '@vercel/blob/client';\nwindow.VercelBlobClient = { upload };\n",
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  outfile: 'public/vendor/vercel-blob-client.js',
});
