// Genera public/vendor/sentry-browser.js: un bundle browser-safe de
// @sentry/browser (solo init/captureException/captureMessage/setTag/setUser)
// para no depender de un CDN externo (ver comentario de CSP "todo local, sin
// CDNs" en server/app.js). Mismo patrón que build-blob-client.mjs. Correr de
// nuevo solo si se actualiza la dependencia @sentry/browser.
import { build } from 'esbuild';

await build({
  stdin: {
    contents: "import { init, captureException, captureMessage, setTag, setUser } from '@sentry/browser';\nwindow.SentryBrowser = { init, captureException, captureMessage, setTag, setUser };\n",
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  outfile: 'public/vendor/sentry-browser.js',
});
