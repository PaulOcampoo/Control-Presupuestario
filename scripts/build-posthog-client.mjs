// Genera public/vendor/posthog-browser.js: un bundle browser-safe de
// posthog-js para no depender de un CDN externo (ver comentario de CSP
// "todo local, sin CDNs" en server/app.js). Mismo patrón que
// build-blob-client.mjs / build-sentry-client.mjs. Correr de nuevo solo si
// se actualiza la dependencia posthog-js.
import { build } from 'esbuild';

await build({
  stdin: {
    contents: "import posthog from 'posthog-js';\nwindow.posthog = posthog;\n",
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  outfile: 'public/vendor/posthog-browser.js',
});
