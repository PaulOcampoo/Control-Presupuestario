Objective:
Auditar e implementar la instalabilidad completa de App-CP como PWA, para que pueda instalarse como app nativa en Android, iOS, Windows y macOS (vía Chrome/Edge/Safari), sin dejar de funcionar como web app normal, sin romper funcionalidad de producción existente.

Starting State:
- App-CP es una PWA mobile-first, frontend vanilla JS/CSS (public/app.js, public/index.html), backend Node/Express en Vercel.
- Ya existe un Service Worker con cache versionado `ctrl-ppto-vN`; regla del proyecto: SW_VERSION se bumpea en cada commit que toque sw.js, sin excepciones.
- No está confirmado si existe actualmente un manifest.json/manifest.webmanifest completo, ni si está enlazado en index.html.
- No está confirmado el estado de iconos (192x192, 512x512, maskable) ni de meta tags iOS (apple-mobile-web-app-capable, apple-touch-icon).
- Producción actual: v133.

Target State:

1. AUDITORÍA DE INSTALABILIDAD (hacer primero, reportar antes de tocar código):
   - Verificar si existe manifest.json/webmanifest y su contenido actual.
   - Verificar si index.html enlaza `<link rel="manifest">`.
   - Verificar iconos existentes en public/ (tamaños disponibles vs. faltantes).
   - Verificar meta tags iOS existentes.
   - Correr Lighthouse (o equivalente) y reportar qué criterios de "Installable" fallan.

2. MANIFEST COMPLETO:
   - Crear o completar manifest.json con: `name`, `short_name`, `start_url`, `display: "standalone"`, `theme_color` (#0B1220), `background_color` (#0B1220), `orientation`, `icons` (192x192, 512x512, y una versión "maskable").
   - `start_url` debe apuntar a la ruta correcta post-login actual — NO inventar una nueva.
   - Enlazar `<link rel="manifest" href="/manifest.json">` en index.html si falta.

3. SOPORTE iOS (Safari "Agregar a inicio"):
   - Agregar `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style`, y `apple-touch-icon` (152, 167, 180px) en index.html.

4. SOPORTE ESCRITORIO (Windows/macOS vía Chrome/Edge):
   - Confirmar que manifest + SW ya disparan el prompt nativo `beforeinstallprompt`.
   - Opcional: capturar `beforeinstallprompt` y exponer un botón "Instalar App-CP" custom en Ajustes, en vez de depender solo del ícono del navegador.

5. NO ROMPER PRODUCCIÓN:
   - Si se toca sw.js para cachear manifest/iconos nuevos, bumpear SW_VERSION.
   - No alterar lógica de auth, roles, ni endpoints /api/*.

Allowed Actions:
- Crear/editar manifest.json.
- Editar public/index.html: solo para agregar `<link rel="manifest">` y meta tags iOS/apple-touch-icon.
- Generar y agregar iconos en public/icons/ a partir del logo existente si faltan tamaños.
- Editar sw.js solo si es necesario para cachear manifest/iconos nuevos (con bump de SW_VERSION correspondiente).
- Crear archivo nuevo opcional public/install-prompt.js para el botón de instalación custom, enlazado sin afectar otros scripts.

Forbidden Actions:
- NO tocar lógica de autenticación, roles, ni ningún endpoint /api/*.
- NO modificar paleta de colores, tipografías ni layout existente.
- NO implementar Electron, Capacitor ni TWA en este prompt — solo PWA nativa del navegador. Publicación en App Store/Play Store es una fase separada.
- NO cambiar el `start_url` a una ruta distinta a la actual sin confirmar con Paul.
- NO remover el sistema de cache versionado existente.

Stop Conditions:
Pausar y pedir revisión cuando:
- No exista un logo en alta resolución (≥512x512) para generar los iconos maskable.
- El manifest actual (si existe) ya define un start_url distinto y cambiarlo podría romper el flujo post-login.
- Surja la duda de si además se quiere publicar en App Store/Play Store (decisión de negocio, no técnica — no asumir, preguntar).

Checkpoints:
✅ Reporte de auditoría inicial (qué existe, qué falta) antes de escribir código.
✅ manifest.json válido y accesible en /manifest.json (verificar con curl/fetch, no solo visualmente).
✅ Auditoría Lighthouse PWA pasa criterio "Installable" (adjuntar output literal).
✅ Confirmación de que el botón/ícono "Instalar" aparece en Chrome desktop y en Android (verificación de Paul en dispositivo real).
✅ Lista completa de archivos modificados/creados con resumen de cada cambio.

Estimado de ejecución: Claude Code + Sonnet 5 — Esfuerzo: Medio (~1-2 horas, incluyendo generación de iconos y verificación en dispositivo real).
